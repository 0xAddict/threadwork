#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { TaskDB } from './db'
import { dispatchAgentNudge, dispatchAgentInterrupt, configureNudgeDebounce } from './nudge'
import {
  postToGroup,
  postToGroupThreaded,
  postNudgeToGroup,
  formatTaskCreated,
  formatTaskClaimed,
  formatTaskCompleted,
  formatNote,
  formatNudge,
  formatDecisionOpened,
  formatDecisionFinalized,
  formatDecisionExpired,
  formatPositionSubmitted,
  formatCritiqueSubmitted,
} from './notify'
import { DB_PATH, SELF_LABEL, AGENT_SESSIONS, TMUX_PATH, TEAM_AGENTS, assertAgentIdentity } from './config'

import { MemoryDB } from './memory'
import { DecisionDB, expireStaleDecisions } from './decision'
import { forceDebrief } from './debrief'
import { AuditLog } from './audit'
import { MemoryConsolidator } from './consolidator'

const db = new TaskDB(DB_PATH)
const mem = new MemoryDB(db)
const dec = new DecisionDB(db, mem)
const audit = new AuditLog(db)

// Wire the nudge debounce module to our live db + audit instances so that
// logDelivered() can emit nudge_sent + agent_nudged audit rows on every
// successful nudge. Without this, _debounceAudit stays null and the audit
// trail goes silent (regression introduced by 93f6511 making audit param
// optional; #921).
configureNudgeDebounce(db, audit)

function normalizeScore(raw: unknown): number {
  const n = Number(raw)
  if (isNaN(n)) return 0.5
  if (n > 1 && n <= 10) return n / 10
  if (n > 10 && n <= 100) return n / 100
  return Math.max(0, Math.min(1, n))
}

function parseAgentList(raw: string): string[] {
  return raw.split(',').map(a => a.trim().toLowerCase()).filter(a => a in AGENT_SESSIONS)
}

function isKnownAgent(agent: string): boolean {
  return agent in AGENT_SESSIONS
}

/**
 * Safe wrapper around db.declareAgentState — emit failures must NEVER block the
 * underlying tool's primary effect (e.g. claim_task must still claim even if
 * the state-contracts emit row write fails). Spec: state-contracts-redesign §5
 * step 3 + §3 conflict resolution (source='mcp', priority 3).
 *
 * Pass state=undefined for touch-only keepalive (refreshes state_changed_at
 * without changing state — used by write_status).
 */
function safeEmitState(
  agent: string,
  state: string | undefined,
  opts: { taskId?: number; tool?: string; pid?: number } = {},
): void {
  try {
    db.declareAgentState(agent, state, 'mcp', opts)
  } catch (err) {
    // Silent — emit failure is non-fatal. Hook-side emit (emit-state.sh) and
    // heartbeat-daemon-v2 stale-state fallback both provide redundancy.
    console.error('[task-board] safeEmitState failed:', (err as Error).message)
  }
}

const mcp = new Server(
  { name: 'task-board', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      `You are agent "${SELF_LABEL}". You have a shared task board and personal memory with other agents (boss, steve, sadie, kiera).`,
      'TASK TOOLS: create_task, delegate_task, claim_task, complete_task, list_tasks, send_note, nudge_agent, interrupt_agent',
      'DELEGATION: Use delegate_task (not create_task) when assigning work to another agent. It sets up supervision automatically.',
      'SUB-AGENT TRACKING: Before spawning Agent tool, call spawn_subagent. After Agent returns — ON SUCCESS OR FAILURE — call close_subagent. Treat this as a try/finally: if Agent throws, you are STILL responsible for close_subagent before any next action (server-side auto-close on parent complete_task is a backstop, not the primary path). Use get_children to see child tasks.',
      'STATUS TOOLS: write_status (sub-agents report progress, supports progress/blocked/eta), read_status (monitor loops check progress), clear_status (cleanup after task)',
      'MEMORY TOOLS: save_memory (store learnings), recall_memories (search your knowledge), get_boot_briefing (load context on startup)',
      'MEMORY MANAGEMENT: promote_memory (share with all agents), pin_memory (prevent decay)',
      'DECISION TOOLS: open_decision, submit_position, critique_position, list_decisions, get_decision_brief, finalize_decision (boss only)',
      'On startup, call get_boot_briefing to load your role, top memories, and recent task history.',
      'After completing tasks, save important learnings with save_memory.',
      'Always delegate complex work to subagents (Agent tool) to keep your context clean.',
    ].join('\n'),
  },
)

// Register tool list
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'create_task',
      description: 'Create a task. Optionally assign to an agent via "to" (auto-nudges target + posts to Telegram). Omit "to" to place task in the backlog (unassigned).',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target agent: boss, steve, sadie, or kiera. Omit to create an unassigned backlog task.' },
          description: { type: 'string', description: 'What needs to be done' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Task priority (default: normal)' },
        },
        required: ['description'],
      },
    },
    {
      name: 'delegate_task',
      description: 'Delegate a task to another agent with durable supervision. Automatically sets you as supervisor, computes watchdog check times, and enables heartbeat/progress monitoring. Use this instead of create_task when assigning work to others.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target agent: boss, steve, sadie, or kiera' },
          description: { type: 'string', description: 'What needs to be done' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Task priority (default: normal)' },
          parent_task_id: { type: 'number', description: 'Optional parent task ID to create a child task' },
          heartbeat_timeout_sec: { type: 'number', description: `Seconds before heartbeat is considered overdue (default: 120)` },
          progress_timeout_sec: { type: 'number', description: `Seconds before progress is considered stale (default: 600)` },
        },
        required: ['to', 'description'],
      },
    },
    {
      name: 'claim_task',
      description: 'Claim a pending task assigned to you. Sets status to in_progress and initializes heartbeat timing for supervision.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'The task ID to claim' },
          session_id: { type: 'string', description: 'Optional session ID to bind the worker session' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'complete_task',
      description: 'Mark a task as completed with a result summary. Checks for open child tasks first — refuses if children are still active. Posts to team group.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'The task ID to complete' },
          result: { type: 'string', description: 'Summary of what was done' },
          result_finding_id: { type: 'number', description: 'Optional: finding_id containing the structured result (Sprint 3)' },
        },
        required: ['task_id', 'result'],
      },
    },
    {
      name: 'list_tasks',
      description: 'List tasks. Filter by assignee and/or status.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['mine', 'pending', 'in_progress', 'completed', 'all'],
            description: '"mine" shows tasks assigned to you. Others filter by status. Default: mine.',
          },
        },
      },
    },
    {
      name: 'send_note',
      description: 'Add a note/comment to a task. Posts to team group.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'The task ID' },
          message: { type: 'string', description: 'The note content' },
        },
        required: ['task_id', 'message'],
      },
    },
    {
      name: 'nudge_agent',
      description: 'Send a wake message to another agent without creating a task.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Target agent: boss, steve, sadie, or kiera' },
          message: { type: 'string', description: 'The message to send' },
        },
        required: ['agent', 'message'],
      },
    },
    {
      name: 'save_memory',
      description: 'Save a memory/learning for yourself. Persists across sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The memory content' },
          category: { type: 'string', enum: ['learning', 'preference', 'fact', 'role'], description: 'Memory category' },
          importance: { type: 'number', description: 'Importance 1-5 (default: 3). Higher = persists longer.' },
          pinned: { type: 'boolean', description: 'Pin to prevent decay (default: false). Use for role definitions.' },
          classification: {
            type: 'string',
            enum: ['foundational', 'strategic', 'operational', 'observational', 'ephemeral'],
            description: 'Memory classification tier. Defaults based on category. Agent+foundational -> proposed state.',
          },
          quality: {
            type: 'number',
            description: 'Quality score 0.0-1.0 (default: 0.5). Memories below 0.3 excluded from boot briefing.',
          },
          source_type: {
            type: 'string',
            enum: ['human', 'agent', 'system', 'consolidation'],
            description: 'Source type (default: agent). Human source can create active foundational directly.',
          },
          evidence: {
            type: 'string',
            description: 'JSON string of supporting evidence/references.',
          },
          supersedes_memory_id: {
            type: 'number',
            description: 'ID of memory this supersedes. Creates lineage chain.',
          },
        },
        required: ['content', 'category'],
      },
    },
    {
      name: 'recall_memories',
      description: 'Search your memories and shared team knowledge. Updates access tracking (boosts importance of accessed memories).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term (matches content)' },
          category: { type: 'string', enum: ['learning', 'preference', 'fact', 'task_summary', 'role'], description: 'Filter by category' },
          limit: { type: 'number', description: 'Max results (default: 10)' },
        },
      },
    },
    {
      name: 'get_boot_briefing',
      description: 'Load your boot briefing: role, top memories, shared knowledge, and recent tasks. Call this on startup.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'promote_memory',
      description: 'Promote a personal memory to shared — all agents will see it.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'number', description: 'The memory ID to promote' },
        },
        required: ['memory_id'],
      },
    },
    {
      name: 'pin_memory',
      description: 'Toggle pin on a memory. Pinned memories never decay.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'number', description: 'The memory ID to pin/unpin' },
        },
        required: ['memory_id'],
      },
    },
    {
      name: 'interrupt_agent',
      description: 'Send Ctrl+C to an agent\'s tmux session. Use when a sub-agent or runner is stuck, hung, or needs to be force-stopped.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Target agent: boss, steve, sadie, or kiera' },
          reason: { type: 'string', description: 'Why the interrupt is needed' },
        },
        required: ['agent', 'reason'],
      },
    },
    {
      name: 'write_status',
      description: 'Write a status entry for a delegated task. Sub-agents call this to report progress. Also updates heartbeat/progress timestamps on the task row for durable supervision.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The parent agent name (steve, sadie, kiera, boss)' },
          task_id: { type: 'number', description: 'The task ID being worked on' },
          status: { type: 'string', enum: ['working', 'blocked', 'complete', 'idle'], description: 'Current status' },
          detail: { type: 'string', description: 'What is happening right now' },
          progress: { type: 'boolean', description: 'Whether real progress was made (default: true). If false, only heartbeat is updated, not progress timestamp.' },
          blocked: { type: 'boolean', description: 'Whether the task is blocked (default: false). If true, triggers immediate supervisor notification.' },
          blocked_reason: { type: 'string', description: 'Reason the task is blocked (used when blocked=true)' },
          blocked_on: { type: 'string', enum: ['human', 'external_api', 'upstream_task', 'agent'], description: 'What is blocking this task. Determines watchdog behavior: agent/null uses short TTL (600s); human/external_api/upstream_task uses long window (eta_sec or 48h default). Use human for awaiting human decisions, external_api for third-party API calls, upstream_task for dependent tasks.' },
          eta_sec: { type: 'number', description: 'Estimated seconds until next meaningful update. Extends next_check_at accordingly.' },
        },
        required: ['agent', 'task_id', 'status', 'detail'],
      },
    },
    {
      name: 'read_status',
      description: 'Read recent JSONL status entries for an agent\'s delegated tasks. Used by monitor loops.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The agent whose status to read (steve, sadie, kiera, boss)' },
          task_id: { type: 'number', description: 'Optional: filter to a specific task ID' },
          last_n: { type: 'number', description: 'Number of recent entries to return (default: 20)' },
        },
        required: ['agent'],
      },
    },
    {
      name: 'clear_status',
      description: 'Clear status entries for a completed task. Called when a task finishes to clean up.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The agent whose status file to clean' },
          task_id: { type: 'number', description: 'The task ID to remove entries for' },
        },
        required: ['agent', 'task_id'],
      },
    },
    {
      name: 'query_audit_log',
      description: 'Query the audit log to see what agents have been doing. Useful for reviewing team activity and debugging.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Filter by agent name' },
          action: { type: 'string', description: 'Filter by action type (task_created, task_claimed, task_completed, memory_saved, etc.)' },
          task_id: { type: 'number', description: 'Filter by task ID' },
          limit: { type: 'number', description: 'Max results (default: 50)' },
        },
      },
    },
    {
      name: 'challenge_memory',
      description: 'Challenge a memory — increments challenge_count, may flip to disputed state. Use when a memory is outdated or contradicted.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          memory_id: { type: 'number', description: 'The memory ID to challenge' },
          reason: { type: 'string', description: 'Why this memory is being challenged' },
        },
        required: ['memory_id', 'reason'],
      },
    },
    {
      name: 'supersede_memory',
      description: 'Replace an outdated memory with new content. Marks old as superseded, creates replacement with lineage link.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          old_memory_id: { type: 'number', description: 'The memory ID to supersede' },
          new_content: { type: 'string', description: 'The replacement content' },
          reason: { type: 'string', description: 'Why this memory is being superseded' },
        },
        required: ['old_memory_id', 'new_content', 'reason'],
      },
    },
    {
      name: 'consolidate_memories',
      description: 'Trigger a memory consolidation run. Runs the 5-phase daemon cycle (Orient, Gather, Validate, Consolidate, Prune).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          scope: { type: 'string', description: 'Scope: all, operational, or agent:NAME', default: 'all' },
          dry_run: { type: 'boolean', description: 'If true, log proposed changes without executing', default: true },
          max_changes: { type: 'number', description: 'Maximum mutations per run', default: 50 },
        },
      },
    },
    {
      name: 'get_memory_health_report',
      description: 'Get memory system health stats: counts by classification/state, dispute rate, average quality, last consolidation run info.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          scope: { type: 'string', description: 'Scope: all, operational, or agent:NAME', default: 'all' },
        },
      },
    },
    {
      name: 'spawn_subagent',
      description: 'Create a durable child task row BEFORE spawning a sub-agent via the Agent tool. Records the sub-agent invocation so the watchdog can monitor it. Call this before Agent tool, then pass the returned child_task_id to the sub-agent. Does NOT actually spawn the agent — you do that with the Agent tool. PAIRING REQUIREMENT: every spawn_subagent must be paired with a close_subagent call in a finally-equivalent block — call close_subagent immediately after Agent returns whether it succeeded, errored, or was interrupted. ADDENDUM: by default the parent task MUST be in_progress. To record a post-acceptance addendum (a fix shipped AFTER the card was accepted/completed), pass addendum:true — this allows a completed/cancelled parent, labels the row "[addendum to #N]", and excludes it from the parent completion gate and the watchdog escalation sweep.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          description: { type: 'string', description: 'What the sub-agent will work on' },
          parent_task_id: { type: 'number', description: 'The task ID this sub-agent is working under' },
          model: { type: 'string', description: 'Optional model hint (e.g., "haiku", "sonnet"). Stored in description for reference only.' },
          addendum: { type: 'boolean', description: 'Set true to record a post-acceptance addendum under a COMPLETED/CANCELLED parent. Default false (parent must be in_progress — current refusal behavior preserved).' },
        },
        required: ['description', 'parent_task_id'],
      },
    },
    {
      name: 'close_subagent',
      description: 'Mark a synthetic sub-agent child task as completed. CALL THIS IN A FINALLY BLOCK — immediately after Agent returns on SUCCESS, and also after Agent throws/errors/is-interrupted. Pass the original error message as result if Agent failed. Clears watchdog monitoring for this child task. Server-side auto-close on parent complete_task exists as a backstop for crash/abort cases, but the explicit close after Agent returns is the primary path and the only one that runs while the parent is still alive to record the actual sub-agent outcome.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'The child task ID returned by spawn_subagent' },
          result: { type: 'string', description: 'Summary of what the sub-agent accomplished (or error if it failed)' },
        },
        required: ['task_id', 'result'],
      },
    },
    {
      name: 'get_children',
      description: 'Get all child tasks of a parent task. Shows both delegated tasks and sub-agent invocations.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'The parent task ID' },
          include_completed: { type: 'boolean', description: 'Include completed/cancelled children (default: true)' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'open_decision',
      description: 'Open a new decision record for structured async deliberation. Any agent can open. Posts to team group.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Title of the decision' },
          context: { type: 'string', description: 'Why this decision is needed' },
          expires_in_hours: { type: 'number', description: 'Hours until auto-expiry (optional)' },
          task_id: { type: 'number', description: 'Optional link to originating task' },
        },
        required: ['title'],
      },
    },
    {
      name: 'submit_position',
      description: 'Submit a position (named stance with rationale) on an open decision. Any agent can submit.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          decision_id: { type: 'number', description: 'The decision ID' },
          position: { type: 'string', description: 'Your stance/recommendation' },
          rationale: { type: 'string', description: 'Why you hold this position' },
          evidence: { type: 'string', description: 'Supporting data or references' },
        },
        required: ['decision_id', 'position'],
      },
    },
    {
      name: 'critique_position',
      description: 'Critique a position or the decision as a whole. Any agent can critique.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          decision_id: { type: 'number', description: 'The decision ID' },
          critique: { type: 'string', description: 'Your critique' },
          position_id: { type: 'number', description: 'Optional: which position you are critiquing' },
          severity: { type: 'string', enum: ['observation', 'concern', 'blocker'], description: 'Severity level (default: observation)' },
        },
        required: ['decision_id', 'critique'],
      },
    },
    {
      name: 'list_decisions',
      description: 'List decisions. Defaults to showing open decisions.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: { type: 'string', enum: ['open', 'positions', 'critique', 'finalized', 'expired', 'cancelled'], description: 'Filter by status (default: open, which includes positions and critique)' },
          limit: { type: 'number', description: 'Max results (default: 50)' },
        },
      },
    },
    {
      name: 'get_decision_brief',
      description: 'Get a formatted decision brief with all positions and critiques.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          decision_id: { type: 'number', description: 'The decision ID' },
        },
        required: ['decision_id'],
      },
    },
    {
      name: 'finalize_decision',
      description: 'Finalize a decision with an outcome. BOSS ONLY. Creates a shared memory record. Posts to team group.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          decision_id: { type: 'number', description: 'The decision ID to finalize' },
          outcome: { type: 'string', description: 'The final decision/outcome' },
          rationale: { type: 'string', description: 'Why this outcome was chosen' },
        },
        required: ['decision_id', 'outcome', 'rationale'],
      },
    },
    {
      name: 'force_debrief',
      description: 'Manually trigger a session debrief. Boss-only. Bypasses idle and volume gates but respects the lock gate. Creates a decision record with synthesis.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    // Sprint 6: DB Hygiene + Hardening
    {
      name: 'run_hygiene',
      description: 'Run DB hygiene: archive old tasks, prune events, clean expired artifacts, compress findings. Default: dry_run=true (preview only).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          dry_run: { type: 'boolean', description: 'If true (default), preview what would be cleaned without making changes' },
        },
      },
    },
    {
      name: 'get_db_stats',
      description: 'Get database statistics: row counts, oldest/newest records per table, DB file size.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    // Sprint 5: Communication Gates
    {
      name: 'get_violations',
      description: 'Query gate violation history. Gated by gates_enabled flag.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_id: { type: 'string', description: 'Filter by agent (optional)' },
          last_n: { type: 'number', description: 'Max results (default: 50)' },
        },
      },
    },
    // Sprint 3: Unified Execution Events
    {
      name: 'report_progress',
      description: 'Report structured progress on a task. Durable event stored in progress_events table. 30s throttle per task (lifecycle events bypass throttle). Gated by progress_events_enabled flag.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task ID to report progress on' },
          event_type: {
            type: 'string',
            enum: ['started', 'heartbeat', 'progress', 'finding_written', 'completed', 'failed', 'abandoned'],
            description: 'Type of progress event',
          },
          percent: { type: 'number', description: 'Completion percentage 0-100 (optional)' },
          activity: { type: 'string', description: 'What is happening (optional)' },
          metrics_json: { type: 'string', description: 'JSON string of metrics (optional)' },
          attempt_id: { type: 'number', description: 'Task attempt ID (optional)' },
          detail_ref: { type: 'number', description: 'Reference to a finding_id for detail (optional)' },
        },
        required: ['task_id', 'event_type'],
      },
    },
    {
      name: 'get_progress',
      description: 'Get durable progress event history for a task. Gated by progress_events_enabled flag.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task ID to get progress for' },
          last_n: { type: 'number', description: 'Max events to return (default: 50)' },
          event_type: { type: 'string', description: 'Filter by event type' },
        },
        required: ['task_id'],
      },
    },
    // Sprint 2: Blackboard Findings Store
    {
      name: 'write_finding',
      description: 'Store a structured finding from task work. Gated by blackboard_enabled flag. Deduplicates on content hash.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task this finding belongs to' },
          finding_type: { type: 'string', description: 'Type of finding (e.g., bug, insight, metric, decision, blocker, recommendation)' },
          summary: { type: 'string', description: 'Summary text (max 1000 chars)' },
          attempt_id: { type: 'number', description: 'Task attempt ID (optional)' },
          parent_agent_id: { type: 'string', description: 'Parent agent if sub-agent (optional)' },
          status: { type: 'string', enum: ['draft', 'published', 'superseded'], description: 'Finding status (default: draft)' },
          is_final: { type: 'boolean', description: 'Mark as final finding (default: false)' },
          metrics_json: { type: 'string', description: 'JSON string of metrics data' },
          refs_json: { type: 'string', description: 'JSON string of references' },
          metadata_json: { type: 'string', description: 'JSON string of additional metadata' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Finding priority (default: normal)' },
          expires_at: { type: 'string', description: 'ISO datetime when finding expires' },
        },
        required: ['task_id', 'finding_type', 'summary'],
      },
    },
    {
      name: 'read_findings',
      description: 'Read finding summaries for a task. Returns summary-level data only. Gated by blackboard_enabled flag.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task ID to read findings for' },
          finding_type: { type: 'string', description: 'Filter by finding type' },
          is_final: { type: 'boolean', description: 'Filter by is_final flag' },
          limit: { type: 'number', description: 'Max results (default: 50)' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'read_finding_raw',
      description: 'Read full finding detail including all fields and linked artifacts. Gated by blackboard_enabled flag.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          finding_id: { type: 'number', description: 'The finding ID to read' },
        },
        required: ['finding_id'],
      },
    },
    {
      name: 'write_artifact',
      description: 'Store an artifact (file content) linked to a task. Saved to disk with URI reference in DB. Gated by blackboard_enabled flag.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task this artifact belongs to' },
          content: { type: 'string', description: 'The artifact content to store' },
          mime_type: { type: 'string', description: 'MIME type (default: text/plain)' },
          attempt_id: { type: 'number', description: 'Task attempt ID (optional)' },
          finding_id: { type: 'number', description: 'Link to a finding (optional)' },
          expires_at: { type: 'string', description: 'ISO datetime when artifact expires' },
        },
        required: ['task_id', 'content'],
      },
    },
  ],
}))

// Handle tool calls
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'create_task': {
        const toRaw = args.to as string | undefined
        const to = toRaw ? toRaw.toLowerCase() : null
        const description = args.description as string
        const priority = (args.priority as string) ?? 'normal'

        if (to !== null && !isKnownAgent(to)) {
          return { content: [{ type: 'text', text: `Invalid agent "${to}". Valid agents: ${TEAM_AGENTS.join(', ')}`, isError: true }] }
        }

        const task = db.createTask({ from: SELF_LABEL, to, description, priority })

        if (to !== null) {
          const nudgeMsg = `You have a new task (#${task.id}) from ${SELF_LABEL}. Run list_tasks(filter="mine") for details.`
          const [nudgeResult] = await Promise.all([
            dispatchAgentNudge(to, nudgeMsg, { source: SELF_LABEL }),
            postToGroupThreaded(formatTaskCreated(task), task.id, { spine: true }),
          ])
          audit.log(SELF_LABEL, 'task_created', { to, description, priority }, task.id)

          const nudgeWarning = nudgeResult.ok ? '' : ` (warning: nudge failed — ${nudgeResult.error})`
          return { content: [{ type: 'text', text: `Task #${task.id} created and assigned to ${to}. Agent nudged.${nudgeWarning}` }] }
        } else {
          await postToGroupThreaded(formatTaskCreated(task), task.id, { spine: true })
          audit.log(SELF_LABEL, 'task_created', { to: 'backlog', description, priority }, task.id)
          return { content: [{ type: 'text', text: `Task #${task.id} created in backlog (unassigned).` }] }
        }
      }

      case 'delegate_task': {
        const to = (args.to as string).toLowerCase()
        const description = args.description as string
        const priority = (args.priority as string) ?? 'normal'
        const parentTaskId = args.parent_task_id as number | undefined
        const heartbeatTimeoutSec = args.heartbeat_timeout_sec as number | undefined
        const progressTimeoutSec = args.progress_timeout_sec as number | undefined

        if (!isKnownAgent(to)) {
          return { content: [{ type: 'text', text: `Invalid agent "${to}". Valid agents: ${TEAM_AGENTS.join(', ')}`, isError: true }] }
        }

        // Sprint 5: Gate 1 (Outbound) — check quarantine before delegating
        if (db.isFeatureEnabled('gates_enabled') && db.isQuarantined(to)) {
          const count = db.getRecentViolationCount(to, 24)
          db.recordViolation(SELF_LABEL, 'delegation_to_quarantined', `Attempted delegation to quarantined agent ${to} (${count} violations in 24h)`)
          // Soft quarantine: warn but allow (reduced priority noted)
          // Log but don't block — council decision: soft quarantine, not hard block
        }

        // Sprint 4: Check circuit breaker before delegating
        if (db.isCircuitOpen(to)) {
          const circuitInfo = db.getCircuitState(to)
          return { content: [{ type: 'text', text: `Cannot delegate to ${to} — circuit breaker is OPEN (${circuitInfo?.fault_count ?? 0} faults). Cooldown until: ${circuitInfo?.cooldown_until ?? 'unknown'}. Try another agent or wait for cooldown.`, isError: true }] }
        }

        try {
          const task = db.delegateTask({
            from: SELF_LABEL,
            to,
            description,
            priority,
            supervisor_agent: SELF_LABEL,
            parent_task_id: parentTaskId,
            heartbeat_timeout_sec: heartbeatTimeoutSec,
            progress_timeout_sec: progressTimeoutSec,
          })

          const nudgeMsg = `You have a new delegated task (#${task.id}) from ${SELF_LABEL}. Run list_tasks(filter="mine") for details.`
          const [nudgeResult] = await Promise.all([
            dispatchAgentNudge(to, nudgeMsg, { source: SELF_LABEL }),
            postToGroup(formatTaskCreated(task)),
          ])
          audit.log(SELF_LABEL, 'task_delegated', {
            to, description, priority,
            supervisor_agent: SELF_LABEL,
            parent_task_id: parentTaskId ?? null,
            heartbeat_timeout_sec: task.heartbeat_timeout_sec,
            progress_timeout_sec: task.progress_timeout_sec,
          }, task.id)

          const nudgeWarning = nudgeResult.ok ? '' : ` (warning: nudge failed — ${nudgeResult.error})`
          const parentInfo = parentTaskId ? ` (child of #${parentTaskId})` : ''
          return { content: [{ type: 'text', text: `Task #${task.id} delegated to ${to}${parentInfo}. Supervisor: ${SELF_LABEL}. Next check: ${task.next_check_at}.${nudgeWarning}` }] }
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Delegation failed: ${err.message}`, isError: true }] }
        }
      }

      case 'claim_task': {
        const taskId = args.task_id as number
        const sessionId = args.session_id as string | undefined

        // Use session-aware claim
        const task = db.claimTaskWithSession(taskId, SELF_LABEL, sessionId ?? AGENT_SESSIONS[SELF_LABEL])

        if (!task) {
          audit.log(SELF_LABEL, 'task_failed', { task_id: taskId, reason: 'not found or already claimed' }, taskId)
          return { content: [{ type: 'text', text: `Cannot claim task #${taskId} — either it doesn't exist or is already claimed.`, isError: true }] }
        }

        // Upsert agent session and declare state
        const agentSession = AGENT_SESSIONS[SELF_LABEL]
        if (agentSession) {
          db.upsertAgentSession(SELF_LABEL, agentSession, 'alive')
        }
        safeEmitState(SELF_LABEL, 'ACTIVE_THINKING', { taskId: task.id, tool: 'claim_task' })

        await postToGroupThreaded(formatTaskClaimed(task), task.id)
        audit.log(SELF_LABEL, 'task_claimed', { task_id: taskId, session_id: sessionId ?? agentSession ?? null }, taskId)
        return { content: [{ type: 'text', text: `Claimed task #${task.id}: ${task.description}` }] }
      }

      case 'complete_task': {
        const taskId = args.task_id as number
        const result = args.result as string

        // Use finalizer check: refuse if open non-synthetic child tasks exist.
        // Synthetic (sub-agent) children are auto-closed as a side effect.
        let completion = db.completeTaskWithFinalizerCheck(taskId, result, SELF_LABEL)
        if (completion.error) {
          audit.log(SELF_LABEL, 'task_failed', { task_id: taskId, reason: completion.error }, taskId)
          return { content: [{ type: 'text', text: completion.error, isError: true }] }
        }

        let task = completion.task
        let autoClosedChildren = completion.autoClosedChildren

        // If agent-scoped completion didn't match, boss can force-complete
        if (!task && SELF_LABEL === 'boss') {
          const forceCompletion = db.forceCompleteTaskWithFinalizerCheck(taskId, result)
          if (forceCompletion.error) {
            audit.log(SELF_LABEL, 'task_failed', { task_id: taskId, reason: forceCompletion.error }, taskId)
            return { content: [{ type: 'text', text: forceCompletion.error, isError: true }] }
          }
          task = forceCompletion.task
          autoClosedChildren = forceCompletion.autoClosedChildren
        }

        if (!task) {
          audit.log(SELF_LABEL, 'task_failed', { task_id: taskId, reason: 'not found, not in progress, or not assigned to you' }, taskId)
          return { content: [{ type: 'text', text: `Cannot complete task #${taskId} — either it doesn't exist, isn't in progress, or isn't assigned to you.`, isError: true }] }
        }

        // Sprint 5: Gate 2 (Inbound) — soft check: warn if no findings exist for this task
        if (db.isFeatureEnabled('gates_enabled') && db.isFeatureEnabled('blackboard_enabled')) {
          const findings = db.readFindings({ task_id: task.id })
          if (findings.length === 0) {
            db.recordViolation(SELF_LABEL, 'no_findings_on_complete', `Task #${task.id} completed without any findings`, task.id)
            // Soft: just log, don't block (calibration framing)
          }
        }

        // Sprint 5: Gate 3 (Monitoring) — log oversized result summaries
        if (db.isFeatureEnabled('gates_enabled') && result.length > 500) {
          db.recordViolation(SELF_LABEL, 'oversized_summary', `Task #${task.id} result is ${result.length} chars (limit: 500)`, task.id)
        }

        // Sprint 4: If agent's circuit was half_open and task completed successfully, close circuit
        const circuitState = db.getCircuitState(task.to_agent)
        if (circuitState?.circuit_state === 'half_open') {
          db.closeCircuit(task.to_agent)
          audit.log(SELF_LABEL, 'circuit_closed', { agent: task.to_agent, reason: 'probe task completed successfully' }, taskId)
        }

        // Sprint 3: Set result_finding_id if provided
        const resultFindingId = args.result_finding_id as number | undefined
        if (resultFindingId) {
          db.run(d => {
            d.prepare('UPDATE tasks SET result_finding_id = ? WHERE id = ?').run(resultFindingId, task!.id)
          })
        }

        // Sprint 3: Emit completion event to progress_events
        db.emitCompletionEvent(task.id, SELF_LABEL, task.attempt_id)
        safeEmitState(SELF_LABEL, 'COMPLETED', { tool: 'complete_task' })

        const nudgeMsg = `Task #${task.id} completed by ${SELF_LABEL}. Run list_tasks(filter="mine") for details.`
        const [nudgeResult] = await Promise.all([
          dispatchAgentNudge(task.from_agent, nudgeMsg, { source: SELF_LABEL }),
          postToGroupThreaded(formatTaskCompleted(task), task.id),
        ])

        // Auto-extract task summary as memory
        const priorityToImportance: Record<string, number> = { low: 1, normal: 2, high: 3, urgent: 4 }
        mem.saveMemory({
          agent: SELF_LABEL,
          content: `Task #${task.id}: ${task.description} → Result: ${result}`,
          category: 'task_summary',
          importance: priorityToImportance[task.priority] ?? 2,
          source_task_id: task.id,
        })
        audit.log(SELF_LABEL, 'task_completed', {
          task_id: taskId, result,
          auto_closed_children: autoClosedChildren ?? null,
        }, taskId)

        const completeNudgeWarning = nudgeResult.ok ? '' : ` (warning: nudge to ${task.from_agent} failed — ${nudgeResult.error})`
        const autoCloseInfo = autoClosedChildren?.length ? ` (auto-closed ${autoClosedChildren.length} sub-agent task(s): ${autoClosedChildren.map(id => '#' + id).join(', ')})` : ''
        return { content: [{ type: 'text', text: `Task #${task.id} completed. Result: ${result}${autoCloseInfo}${completeNudgeWarning}` }] }
      }

      case 'list_tasks': {
        const filterStr = (args.filter as string) ?? 'mine'
        let filter: { assignee?: string; status?: string } = {}

        if (filterStr === 'mine') {
          filter.assignee = SELF_LABEL
        } else if (filterStr !== 'all') {
          filter.status = filterStr
        }

        const tasks = db.listTasks(filter)

        if (tasks.length === 0) {
          return { content: [{ type: 'text', text: 'No tasks found.' }] }
        }

        const lines = tasks.map(
          (t) => `#${t.id} [${t.status}] ${t.from_agent}→${t.to_agent}: ${t.description}${t.result ? ` | Result: ${t.result}` : ''}`,
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'send_note': {
        const taskId = args.task_id as number
        const message = args.message as string

        const task = db.getTask(taskId)
        if (!task) {
          return { content: [{ type: 'text', text: `Task #${taskId} not found.`, isError: true }] }
        }

        db.addNote(taskId, SELF_LABEL, message)
        await postToGroupThreaded(formatNote(taskId, SELF_LABEL, message), taskId)
        audit.log(SELF_LABEL, 'note_added', { task_id: taskId, message }, taskId)

        return { content: [{ type: 'text', text: `Note added to task #${taskId}.` }] }
      }

      case 'nudge_agent': {
        const agent = (args.agent as string).toLowerCase()
        const message = args.message as string
        const result = await dispatchAgentNudge(agent, message, { source: SELF_LABEL })

        if (!result.ok) {
          return { content: [{ type: 'text', text: `Nudge failed: ${result.error}`, isError: true }] }
        }

        // #1785: GROUP-CHAT nudge noise control — digest/throttle rapid repeat
        // nudges to the same target. Delivery to the agent already happened above
        // via dispatchAgentNudge (untouched); this only tames the group spine.
        // 'urgent'/'high' priority nudges bypass the throttle so escalations surface.
        const nudgeUrgency = (args.urgency as string | undefined)?.toLowerCase()
        await postNudgeToGroup(SELF_LABEL, agent, message, {
          urgent: nudgeUrgency === 'urgent' || nudgeUrgency === 'high',
        })
        // audit_log('agent_nudged') is emitted inside dispatchAgentNudge() on the
        // successful sendTmux path only — this is the single canonical write site
        // (sprint #256 gate 3). Do NOT re-add a direct write here.
        return { content: [{ type: 'text', text: `Nudged ${agent}: ${message}` }] }
      }

      case 'save_memory': {
        const content = args.content as string
        const category = args.category as string
        const importance = (args.importance as number) ?? 3
        const pinned = (args.pinned as boolean) ?? false
        const classification = args.classification as string | undefined
        const quality = args.quality as number | undefined
        const source_type = args.source_type as string | undefined
        const evidence = args.evidence as string | undefined
        const supersedes_memory_id = args.supersedes_memory_id as number | undefined

        const memory = mem.saveMemory({
          agent: SELF_LABEL,
          content,
          category,
          importance,
          pinned,
          classification: classification as import('./memory').Classification | undefined,
          quality,
          source_type: source_type as import('./memory').SourceType | undefined,
          evidence,
          supersedes_memory_id,
        })
        audit.log(SELF_LABEL, 'memory_saved', { category, importance: memory.importance }, undefined, memory.id)

        return { content: [{ type: 'text', text: `Memory #${memory.id} saved (importance: ${memory.importance}${memory.pinned ? ', pinned' : ''})` }] }
      }

      case 'recall_memories': {
        const query = args.query as string | undefined
        const category = args.category as string | undefined
        const limit = args.limit as number | undefined

        const memories = mem.recallMemories(SELF_LABEL, { query, category, limit })
        audit.log(SELF_LABEL, 'memory_recalled', { query: query ?? null, results_count: memories.length })

        if (memories.length === 0) {
          return { content: [{ type: 'text', text: 'No memories found.' }] }
        }

        const lines = memories.map(
          (m) => `#${m.id} [${m.category}] imp:${m.importance} ${m.pinned ? '📌' : ''} ${m.content}`,
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'get_boot_briefing': {
        const briefing = mem.getBootBriefing(SELF_LABEL, db)
        const sections: string[] = []

        if (briefing.role.length > 0) {
          sections.push('== ROLE ==\n' + briefing.role.map(m => m.content).join('\n'))
        }
        if (briefing.topMemories.length > 0) {
          sections.push('== TOP MEMORIES ==\n' + briefing.topMemories.map(m => `[${m.category}] ${m.content}`).join('\n'))
        }
        if (briefing.sharedMemories.length > 0) {
          sections.push('== SHARED KNOWLEDGE ==\n' + briefing.sharedMemories.map(m => `[${m.category}] ${m.content}`).join('\n'))
        }
        if (briefing.recentTasks.length > 0) {
          sections.push('== RECENT TASKS ==\n' + briefing.recentTasks.map(t => `#${t.id} ${t.description} → ${t.result}`).join('\n'))
        }

        audit.log(SELF_LABEL, 'boot_briefing', {
          role_count: briefing.role.length,
          memory_count: briefing.topMemories.length,
          shared_count: briefing.sharedMemories.length,
          task_count: briefing.recentTasks.length,
        })

        if (sections.length === 0) {
          return { content: [{ type: 'text', text: 'No memories or history yet. You are a fresh agent.' }] }
        }

        return { content: [{ type: 'text', text: sections.join('\n\n') }] }
      }

      case 'promote_memory': {
        const memoryId = args.memory_id as number
        const promoted = mem.promoteMemory(memoryId)

        if (!promoted) {
          return { content: [{ type: 'text', text: `Memory #${memoryId} not found.`, isError: true }] }
        }

        audit.log(SELF_LABEL, 'memory_promoted', { memory_id: memoryId }, undefined, memoryId)
        return { content: [{ type: 'text', text: `Memory #${memoryId} promoted to shared. All agents can now see it.` }] }
      }

      case 'pin_memory': {
        const memoryId = args.memory_id as number
        const toggled = mem.pinMemory(memoryId)

        if (!toggled) {
          return { content: [{ type: 'text', text: `Memory #${memoryId} not found.`, isError: true }] }
        }

        audit.log(SELF_LABEL, 'memory_pinned', { memory_id: memoryId, pinned: !!toggled.pinned }, undefined, memoryId)
        const state = toggled.pinned ? 'pinned (will not decay)' : 'unpinned (will decay normally)'
        return { content: [{ type: 'text', text: `Memory #${memoryId} ${state}.` }] }
      }

      case 'interrupt_agent': {
        const agent = (args.agent as string).toLowerCase()
        const reason = args.reason as string

        // Sprint #256 gate 4: all raw tmux send-keys invocations live inside
        // nudge.ts only. Ctrl+C delivery now goes through dispatchAgentInterrupt,
        // which does its own stateless session resolution, has-session preflight,
        // and audit-log write (action: NUDGE_ACTIONS.INTERRUPTED).
        const result = await dispatchAgentInterrupt(agent, reason, { source: SELF_LABEL })

        if (!result.ok) {
          return { content: [{ type: 'text', text: `Interrupt failed: ${result.error}`, isError: true }] }
        }

        await postToGroup(`🛑 ${SELF_LABEL} interrupted ${agent}: ${reason}`)
        return { content: [{ type: 'text', text: `Sent Ctrl+C to ${agent}. Reason: ${reason}` }] }
      }

      case 'write_status': {
        const agent = (args.agent as string).toLowerCase()
        const taskId = args.task_id as number
        const status = args.status as string
        const detail = args.detail as string
        const isProgress = (args.progress as boolean) ?? true
        const isBlocked = (args.blocked as boolean) ?? false
        const blockedReason = args.blocked_reason as string | undefined
        const blockedOn = args.blocked_on as 'human' | 'external_api' | 'upstream_task' | 'agent' | undefined
        const etaSec = args.eta_sec as number | undefined

        // Always write to task_status_events (preserving existing behavior)
        db.run(d => {
          d.prepare('INSERT INTO task_status_events (agent, task_id, status, detail) VALUES (?, ?, ?, ?)').run(agent, taskId, status, detail)
        })

        // Sprint 3: Also emit to progress_events if enabled (write_status is deprecated alias)
        if (db.isFeatureEnabled('progress_events_enabled')) {
          const eventType = status === 'blocked' ? 'heartbeat'
            : status === 'complete' ? 'completed'
            : status === 'idle' ? 'heartbeat'
            : 'progress'
          db.reportProgress({ task_id: taskId, agent_id: agent, event_type: eventType, activity: detail })
        }

        // Update heartbeat/progress/blocked on the task row for supervision
        const updatedTask = db.updateHeartbeat({
          taskId,
          agent,
          detail,
          isProgress,
          isBlocked,
          blockedReason: blockedReason ?? (isBlocked ? detail : undefined),
          blockedOn: isBlocked ? blockedOn : undefined,
          etaSec,
        })

        // Touch-only state keepalive: refresh state_changed_at without changing state
        safeEmitState(agent, undefined, { taskId, tool: 'write_status' })

        // If blocked, attempt immediate Telegram notification to supervisor
        let blockedNotice = ''
        if (isBlocked && updatedTask?.supervisor_agent) {
          const supervisor = updatedTask.supervisor_agent
          const reason = blockedReason ?? detail
          const blockedMsg = `Task #${taskId} is BLOCKED. Worker: ${agent}. Reason: ${reason}`

          // Nudge supervisor and post to group (plain text — no MarkdownV2 escaping needed)
          await Promise.all([
            dispatchAgentNudge(supervisor, blockedMsg, { source: agent }),
            postToGroup(formatNudge(agent, supervisor, `BLOCKED on task #${taskId}: ${reason}`)),
          ])
          blockedNotice = ` Supervisor (${supervisor}) notified.`
        }

        audit.log(SELF_LABEL, 'status_written', {
          agent, task_id: taskId, status, detail,
          progress: isProgress, blocked: isBlocked,
          blocked_reason: blockedReason ?? null,
          eta_sec: etaSec ?? null,
        }, taskId)

        const versionInfo = updatedTask ? ` (v${updatedTask.version})` : ''
        return { content: [{ type: 'text', text: `Status written for ${agent} task #${taskId}: [${status}] ${detail}${versionInfo}${blockedNotice}` }] }
      }

      case 'read_status': {
        const agent = (args.agent as string).toLowerCase()
        const taskId = args.task_id as number | undefined
        const lastN = (args.last_n as number) ?? 20

        const entries = db.run(d => {
          if (taskId !== undefined) {
            return d.prepare(
              'SELECT * FROM task_status_events WHERE agent = ? AND task_id = ? ORDER BY created_at DESC LIMIT ?'
            ).all(agent, taskId, lastN) as any[]
          }
          return d.prepare(
            'SELECT * FROM task_status_events WHERE agent = ? ORDER BY created_at DESC LIMIT ?'
          ).all(agent, lastN) as any[]
        }).reverse()

        if (entries.length === 0) {
          return { content: [{ type: 'text', text: taskId ? `No status entries for task #${taskId}.` : `No status entries for ${agent}.` }] }
        }

        const output = entries.map((e: any) => `[${e.created_at}] task#${e.task_id} ${e.status}: ${e.detail}`).join('\n')
        return { content: [{ type: 'text', text: output }] }
      }

      case 'clear_status': {
        const agent = (args.agent as string).toLowerCase()
        const taskId = args.task_id as number

        const deleted = db.run(d => {
          const result = d.prepare('DELETE FROM task_status_events WHERE agent = ? AND task_id = ?').run(agent, taskId)
          return result.changes
        })

        audit.log(SELF_LABEL, 'status_cleared', { agent, task_id: taskId, deleted }, taskId)
        return { content: [{ type: 'text', text: `Cleared ${deleted} status entries for ${agent} task #${taskId}.` }] }
      }

      case 'query_audit_log': {
        const entries = audit.query({
          agent: args.agent as string | undefined,
          action: args.action as string | undefined,
          taskId: args.task_id as number | undefined,
          limit: args.limit as number | undefined,
        })

        if (entries.length === 0) {
          return { content: [{ type: 'text', text: 'No audit entries found.' }] }
        }

        const lines = entries.map(e => {
          const detail = e.detail ? ` ${e.detail}` : ''
          const taskRef = e.task_id ? ` [task:#${e.task_id}]` : ''
          return `${e.created_at} | ${e.agent} | ${e.action}${taskRef}${detail}`
        })
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'challenge_memory': {
        const memoryId = Number(args.memory_id)
        const reason = String(args.reason ?? '')
        const result = mem.challengeMemory(memoryId, reason)
        if (!result) return { content: [{ type: 'text', text: `Memory #${memoryId} not found.` }] }
        audit.log(SELF_LABEL, 'memory_challenged', { reason, quality: result.quality, state: result.state }, undefined, memoryId)
        return { content: [{ type: 'text', text: `Challenged memory #${memoryId}. State: ${result.state}, Quality: ${result.quality.toFixed(2)}, Challenges: ${result.challenge_count}, Supports: ${result.support_count}` }] }
      }

      case 'supersede_memory': {
        const oldId = Number(args.old_memory_id)
        const newContent = String(args.new_content ?? '')
        const reason = String(args.reason ?? '')
        const result = mem.supersedeMemory(oldId, newContent, reason)
        if (!result) return { content: [{ type: 'text', text: `Memory #${oldId} not found.` }] }
        audit.log(SELF_LABEL, 'memory_superseded', { reason, old_id: oldId, new_id: result.new.id }, undefined, result.new.id)
        return { content: [{ type: 'text', text: `Superseded memory #${oldId} → #${result.new.id}. Old state: ${result.old.state}. New content saved.` }] }
      }

      case 'consolidate_memories': {
        const dryRun = args.dry_run !== false
        const maxChanges = Number(args.max_changes ?? 50)
        // Parse scope: "all" (default) | "operational" | "agent:NAME"
        const rawScope = args.scope != null ? String(args.scope).trim() : 'all'
        const scope = rawScope === '' ? 'all' : rawScope
        if (scope !== 'all' && scope !== 'operational' && !scope.startsWith('agent:')) {
          return { content: [{ type: 'text', text: `Invalid scope '${scope}'. Must be 'all', 'operational', or 'agent:NAME'.` }] }
        }
        if (scope.startsWith('agent:') && scope.slice('agent:'.length).trim() === '') {
          return { content: [{ type: 'text', text: `Invalid scope '${scope}'. agent:NAME requires a non-empty NAME.` }] }
        }
        const consolidator = new MemoryConsolidator(mem, db, dryRun, maxChanges, scope)
        const result = await consolidator.run(`manual trigger by ${SELF_LABEL}`)
        audit.log(SELF_LABEL, 'consolidation_triggered', { summary: result.summary, scope })
        return { content: [{ type: 'text', text: result.summary }] }
      }

      case 'get_memory_health_report': {
        // Respect the same scope dimension so agents can inspect just their slice.
        const rawScope = args.scope != null ? String(args.scope).trim() : 'all'
        const scope = rawScope === '' ? 'all' : rawScope
        if (scope !== 'all' && scope !== 'operational' && !scope.startsWith('agent:')) {
          return { content: [{ type: 'text', text: `Invalid scope '${scope}'. Must be 'all', 'operational', or 'agent:NAME'.` }] }
        }
        if (scope.startsWith('agent:') && scope.slice('agent:'.length).trim() === '') {
          return { content: [{ type: 'text', text: `Invalid scope '${scope}'. agent:NAME requires a non-empty NAME.` }] }
        }
        const consolidator = new MemoryConsolidator(mem, db, true, 50, scope)
        const report = consolidator.getHealthReport()
        const lines = [
          `Total active: ${report.totalActive}`,
          `By classification: ${JSON.stringify(report.byClassification)}`,
          `By state: ${JSON.stringify(report.byState)}`,
          `Dispute rate: ${(report.disputeRate * 100).toFixed(1)}%`,
          `Avg quality: ${report.avgQuality.toFixed(2)}`,
          `Last run: ${report.lastRunAt ?? 'never'} (${report.lastRunMutations ?? 0} mutations)`,
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'spawn_subagent': {
        const description = args.description as string
        const parentTaskId = args.parent_task_id as number
        const model = args.model as string | undefined
        const isAddendum = (args.addendum as boolean) === true

        const fullDescription = model
          ? `[subagent:${model}] ${description}`
          : `[subagent] ${description}`

        try {
          const childTask = db.createSubagentTask({
            description: fullDescription,
            parent_task_id: parentTaskId,
            supervisor_agent: SELF_LABEL,
            is_addendum: isAddendum,
          })

          audit.log(SELF_LABEL, 'subagent_spawned', {
            parent_task_id: parentTaskId,
            child_task_id: childTask.id,
            description: childTask.description,
            model: model ?? null,
            is_addendum: isAddendum ? 1 : 0,
          }, childTask.id)
          safeEmitState(SELF_LABEL, 'SUBAGENT_RUNNING', { taskId: childTask.id, tool: 'spawn_subagent', addendum: isAddendum })

          // #1624: addendum rows carry next_check_at=NULL (watchdog excluded);
          // surface that in the reply so callers know the row is durably tracked
          // but not heartbeat-supervised.
          const supervisionNote = isAddendum
            ? `Addendum to #${parentTaskId} — labeled "[addendum to #${parentTaskId}]", excluded from watchdog escalation and from the parent completion gate.`
            : `Watchdog will monitor heartbeat (timeout: ${childTask.heartbeat_timeout_sec}s).`
          return { content: [{ type: 'text', text: `Sub-agent task #${childTask.id} created (child of #${parentTaskId}). Pass this ID to the sub-agent. ${supervisionNote}` }] }
        } catch (err: any) {
          return { content: [{ type: 'text', text: `spawn_subagent failed: ${err.message}`, isError: true }] }
        }
      }

      case 'close_subagent': {
        const taskId = args.task_id as number
        const result = args.result as string

        const closed = db.closeSubagentTask(taskId, result)

        if (!closed) {
          // Maybe already completed or not a synthetic task
          const task = db.getTask(taskId)
          if (!task) {
            return { content: [{ type: 'text', text: `Sub-agent task #${taskId} not found.`, isError: true }] }
          }
          if (task.status === 'completed') {
            return { content: [{ type: 'text', text: `Sub-agent task #${taskId} was already completed.` }] }
          }
          if (!task.is_synthetic) {
            return { content: [{ type: 'text', text: `Task #${taskId} is not a synthetic sub-agent task. Use complete_task instead.`, isError: true }] }
          }
          return { content: [{ type: 'text', text: `Cannot close sub-agent task #${taskId} (status: ${task.status}).`, isError: true }] }
        }

        audit.log(SELF_LABEL, 'subagent_closed', {
          task_id: taskId,
          result,
          parent_task_id: closed.parent_task_id,
        }, taskId)
        safeEmitState(SELF_LABEL, 'ACTIVE_THINKING', { tool: 'close_subagent' })

        return { content: [{ type: 'text', text: `Sub-agent task #${taskId} completed. Parent: #${closed.parent_task_id}.` }] }
      }

      case 'get_children': {
        const taskId = args.task_id as number
        const includeCompleted = (args.include_completed as boolean) ?? true

        const children = db.getChildTasks(taskId, includeCompleted)

        if (children.length === 0) {
          return { content: [{ type: 'text', text: `No child tasks found for #${taskId}.` }] }
        }

        const lines = children.map(c => {
          // #1624: label addendum rows explicitly so get_children makes the
          // post-acceptance-fix lineage visible at a glance.
          const kindTag = c.is_addendum ? '[addendum]' : (c.is_synthetic ? '[subagent]' : '[task]')
          const resultInfo = c.result ? ` | Result: ${c.result}` : ''
          return `#${c.id} ${kindTag} [${c.status}] ${c.description}${resultInfo}`
        })
        return { content: [{ type: 'text', text: `Children of #${taskId}:\n${lines.join('\n')}` }] }
      }

      case 'open_decision': {
        const title = args.title as string
        const context = (args.context as string) ?? null
        const expiresInHours = args.expires_in_hours as number | undefined
        const taskId = args.task_id as number | undefined

        let expiresAt: string | undefined
        if (expiresInHours) {
          const d = new Date()
          d.setHours(d.getHours() + expiresInHours)
          expiresAt = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
        }

        const decision = dec.openDecision(title, context, SELF_LABEL, { expiresAt, taskId })
        await postToGroup(formatDecisionOpened(decision))
        audit.log(SELF_LABEL, 'decision_opened', { title, decision_id: decision.id })

        return { content: [{ type: 'text', text: `Decision #${decision.id} opened: ${title}${expiresAt ? ` (expires: ${expiresAt})` : ''}` }] }
      }

      case 'submit_position': {
        const decisionId = args.decision_id as number
        const position = args.position as string
        const rationale = args.rationale as string | undefined
        const evidence = args.evidence as string | undefined

        try {
          const pos = dec.addPosition(decisionId, SELF_LABEL, position, rationale, evidence)
          await postToGroup(formatPositionSubmitted(decisionId, SELF_LABEL, position, rationale))
          audit.log(SELF_LABEL, 'decision_position_submitted', { decision_id: decisionId, position_id: pos.id })
          return { content: [{ type: 'text', text: `Position #${pos.id} submitted on decision #${decisionId}.` }] }
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Submit position failed: ${err.message}`, isError: true }] }
        }
      }

      case 'critique_position': {
        const decisionId = args.decision_id as number
        const critique = args.critique as string
        const positionId = args.position_id as number | undefined
        const severity = args.severity as string | undefined

        try {
          const crit = dec.addCritique(decisionId, SELF_LABEL, critique, {
            positionId,
            severity: severity as import('./decision').CritiqueSeverity | undefined,
          })
          const target = positionId ? `position #${positionId}` : 'decision overall'
          await postToGroup(formatCritiqueSubmitted(decisionId, SELF_LABEL, target, critique))
          audit.log(SELF_LABEL, 'decision_critique_submitted', { decision_id: decisionId, critique_id: crit.id, severity: crit.severity })
          return { content: [{ type: 'text', text: `Critique #${crit.id} submitted on decision #${decisionId} (severity: ${crit.severity}).` }] }
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Critique failed: ${err.message}`, isError: true }] }
        }
      }

      case 'list_decisions': {
        const status = (args.status as string) ?? 'open'
        const limit = args.limit as number | undefined

        const decisions = dec.getDecisionsByStatus(status, limit)

        if (decisions.length === 0) {
          return { content: [{ type: 'text', text: `No decisions found with status '${status}'.` }] }
        }

        const lines = decisions.map(d => {
          const expiry = d.expires_at ? ` (expires: ${d.expires_at})` : ''
          const outcome = d.outcome ? ` | Outcome: ${d.outcome}` : ''
          return `#${d.id} [${d.status}] ${d.title} — opened by ${d.opened_by}${expiry}${outcome}`
        })
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'get_decision_brief': {
        const decisionId = args.decision_id as number
        const detail = dec.getDecision(decisionId)

        if (!detail) {
          return { content: [{ type: 'text', text: `Decision #${decisionId} not found.`, isError: true }] }
        }

        const sections: string[] = [
          `== Decision #${detail.id}: ${detail.title} ==`,
          `Status: ${detail.status} | Opened by: ${detail.opened_by} | Created: ${detail.created_at}`,
        ]

        if (detail.context) sections.push(`Context: ${detail.context}`)
        if (detail.expires_at) sections.push(`Expires: ${detail.expires_at}`)
        if (detail.task_id) sections.push(`Linked task: #${detail.task_id}`)

        if (detail.positions.length > 0) {
          sections.push('\n-- Positions --')
          for (const p of detail.positions) {
            let line = `  #${p.id} ${p.agent}: ${p.position}`
            if (p.rationale) line += ` | Rationale: ${p.rationale}`
            if (p.evidence) line += ` | Evidence: ${p.evidence}`
            sections.push(line)
          }
        }

        if (detail.critiques.length > 0) {
          sections.push('\n-- Critiques --')
          for (const c of detail.critiques) {
            const target = c.position_id ? ` (re: position #${c.position_id})` : ''
            sections.push(`  #${c.id} [${c.severity}] ${c.agent}${target}: ${c.critique}`)
          }
        }

        if (detail.outcome) {
          sections.push(`\n-- Outcome --`)
          sections.push(`Finalized by: ${detail.finalized_by ?? 'unknown'}`)
          sections.push(`Outcome: ${detail.outcome}`)
          if (detail.outcome_rationale) sections.push(`Rationale: ${detail.outcome_rationale}`)
          if (detail.memory_id) sections.push(`Memory: #${detail.memory_id}`)
        }

        return { content: [{ type: 'text', text: sections.join('\n') }] }
      }

      case 'finalize_decision': {
        if (SELF_LABEL !== 'boss') {
          return { content: [{ type: 'text', text: 'Only boss can finalize decisions.', isError: true }] }
        }

        const decisionId = args.decision_id as number
        const outcome = args.outcome as string
        const rationale = args.rationale as string

        try {
          const result = dec.finalizeDecision(decisionId, SELF_LABEL, outcome, rationale)
          await postToGroup(formatDecisionFinalized(result.decision))
          audit.log(SELF_LABEL, 'decision_finalized', {
            decision_id: decisionId,
            outcome,
            memory_id: result.memory.id,
          })
          return { content: [{ type: 'text', text: `Decision #${decisionId} finalized. Outcome: ${outcome}. Memory #${result.memory.id} created.` }] }
        } catch (err: any) {
          return { content: [{ type: 'text', text: `Finalize failed: ${err.message}`, isError: true }] }
        }
      }

      case 'force_debrief': {
        if (SELF_LABEL !== 'boss' && SELF_LABEL !== 'snoopy') {
          return { content: [{ type: 'text', text: 'Only boss or snoopy can force a debrief.', isError: true }] }
        }
        const result = await forceDebrief(db, mem, dec, audit)
        if (result.error) {
          return { content: [{ type: 'text', text: `Debrief failed: ${result.error}`, isError: true }] }
        }
        audit.log(SELF_LABEL, 'force_debrief', {
          run_id: result.runId, decision_id: result.decisionId,
          tasks: result.tasksReviewed, memories: result.memoriesReviewed,
        })
        return { content: [{ type: 'text', text: `Debrief #${result.runId} complete. Decision #${result.decisionId}. ${result.tasksReviewed} tasks, ${result.memoriesReviewed} memories reviewed.` }] }
      }

      // Sprint 6: DB Hygiene + Hardening handlers
      case 'run_hygiene': {
        const dryRun = (args.dry_run as boolean) ?? true
        const result = db.runHygiene(dryRun)
        audit.log(SELF_LABEL, 'hygiene_run', { dry_run: dryRun, ...result })
        const mode = dryRun ? 'DRY RUN (preview)' : 'LIVE (changes applied)'
        const lines = [
          `Hygiene ${mode}:`,
          `  Tasks to archive (>14d): ${result.archived_tasks}`,
          `  Progress events to prune (>14d): ${result.pruned_events}`,
          `  Expired artifacts to clean: ${result.expired_artifacts}`,
          `  Findings to compress (>7d): ${result.compressed_findings}`,
          `  Vacuumed: ${result.vacuumed}`,
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'get_db_stats': {
        const stats = db.getDbStats()
        const lines = Object.entries(stats).map(([table, s]) => {
          if (table === '_db_file') return `DB file size: ${s.row_count} KB`
          return `${table}: ${s.row_count} rows${s.oldest ? ` (${s.oldest} → ${s.newest})` : ''}`
        })
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      // Sprint 5: Communication Gates handlers
      case 'get_violations': {
        if (!db.isFeatureEnabled('gates_enabled')) {
          return { content: [{ type: 'text', text: 'Gates disabled (feature flag gates_enabled=0).', isError: true }] }
        }
        const violations = db.getViolations({
          agent_id: args.agent_id as string | undefined,
          last_n: args.last_n as number | undefined,
        })
        if (violations.length === 0) {
          return { content: [{ type: 'text', text: 'No violations found.' }] }
        }
        const lines = violations.map((v: any) =>
          `#${v.id} [${v.created_at}] ${v.agent_id} — ${v.violation_type}: ${v.detail?.slice(0, 200) ?? ''}`
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      // Sprint 3: Unified Execution Events handlers
      case 'report_progress': {
        const result = db.reportProgress({
          task_id: args.task_id as number,
          agent_id: SELF_LABEL,
          event_type: args.event_type as string,
          percent: args.percent as number | undefined,
          activity: args.activity as string | undefined,
          metrics_json: args.metrics_json as string | undefined,
          attempt_id: args.attempt_id as number | undefined,
          detail_ref: args.detail_ref as number | undefined,
        })
        if ('error' in result) {
          return { content: [{ type: 'text', text: result.error, isError: true }] }
        }
        if ('throttled' in result) {
          return { content: [{ type: 'text', text: `Throttled. Next progress event allowed in ${result.next_allowed_in_sec}s.` }] }
        }
        audit.log(SELF_LABEL, 'progress_reported', { task_id: args.task_id, event_type: args.event_type, event_id: result.event_id }, args.task_id as number)
        return { content: [{ type: 'text', text: `Progress event #${result.event_id} recorded (${args.event_type}) for task #${args.task_id}.` }] }
      }

      case 'get_progress': {
        const events = db.getProgress({
          task_id: args.task_id as number,
          last_n: args.last_n as number | undefined,
          event_type: args.event_type as string | undefined,
        })
        if (events.length === 0) {
          return { content: [{ type: 'text', text: `No progress events for task #${args.task_id}.` }] }
        }
        const lines = events.reverse().map((e: any) =>
          `[${e.created_at}] #${e.event_id} ${e.event_type}${e.percent != null ? ` ${e.percent}%` : ''} — ${e.activity ?? '(no activity)'}`
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      // Sprint 2: Blackboard Findings Store handlers
      case 'write_finding': {
        const result = db.writeFinding({
          task_id: args.task_id as number,
          finding_type: args.finding_type as string,
          summary: args.summary as string,
          agent_id: SELF_LABEL,
          attempt_id: args.attempt_id as number | undefined,
          parent_agent_id: args.parent_agent_id as string | undefined,
          status: args.status as string | undefined,
          is_final: args.is_final as boolean | undefined,
          metrics_json: args.metrics_json as string | undefined,
          refs_json: args.refs_json as string | undefined,
          metadata_json: args.metadata_json as string | undefined,
          priority: args.priority as string | undefined,
          expires_at: args.expires_at as string | undefined,
        })
        if ('error' in result) {
          return { content: [{ type: 'text', text: result.error, isError: true }] }
        }
        audit.log(SELF_LABEL, 'finding_written', { task_id: args.task_id, finding_type: args.finding_type, finding_id: result.finding_id }, args.task_id as number)
        return { content: [{ type: 'text', text: `Finding #${result.finding_id} written for task #${args.task_id} (type: ${args.finding_type}).` }] }
      }

      case 'read_findings': {
        const findings = db.readFindings({
          task_id: args.task_id as number,
          finding_type: args.finding_type as string | undefined,
          is_final: args.is_final as boolean | undefined,
          limit: args.limit as number | undefined,
        })
        if (findings.length === 0) {
          return { content: [{ type: 'text', text: `No findings for task #${args.task_id}.` }] }
        }
        const lines = findings.map(f =>
          `#${f.finding_id} [${f.finding_type}] ${f.status}${f.is_final ? ' (FINAL)' : ''} — ${f.summary.slice(0, 200)}`
        )
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'read_finding_raw': {
        const finding = db.readFindingRaw(args.finding_id as number)
        if (!finding) {
          return { content: [{ type: 'text', text: `Finding #${args.finding_id} not found (or blackboard disabled).`, isError: true }] }
        }
        return { content: [{ type: 'text', text: JSON.stringify(finding, null, 2) }] }
      }

      case 'write_artifact': {
        const result = db.writeArtifact({
          task_id: args.task_id as number,
          content: args.content as string,
          agent_id: SELF_LABEL,
          mime_type: args.mime_type as string | undefined,
          attempt_id: args.attempt_id as number | undefined,
          finding_id: args.finding_id as number | undefined,
          expires_at: args.expires_at as string | undefined,
        })
        if ('error' in result) {
          return { content: [{ type: 'text', text: result.error, isError: true }] }
        }
        audit.log(SELF_LABEL, 'artifact_written', { task_id: args.task_id, artifact_id: result.artifact_id, uri: result.uri }, args.task_id as number)
        return { content: [{ type: 'text', text: `Artifact #${result.artifact_id} stored at ${result.uri}` }] }
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}`, isError: true }] }
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err}`, isError: true }] }
  }
})

// Fail fast if AGENT_LABEL env var is not set — prevents silent wrong-tenant writes
assertAgentIdentity()

await mcp.connect(new StdioServerTransport())

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
