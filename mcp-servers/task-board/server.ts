#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { TaskDB } from './db'
import { nudgeAgent } from './nudge'
import {
  postToGroup,
  formatTaskCreated,
  formatTaskClaimed,
  formatTaskCompleted,
  formatNote,
  formatNudge,
} from './notify'
import { DB_PATH, SELF_LABEL, STATUS_DIR, AGENT_SESSIONS, TEAM_AGENTS, WORKER_AGENTS, BOSS_AGENT, AGENT_OWNERSHIP, AGENT_REPORTS_TO } from './config'
import { join } from 'path'
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { MemoryDB } from './memory'
import { AuditLog } from './audit'
import { DecisionDB } from './decision'

const db = new TaskDB(DB_PATH)
const mem = new MemoryDB(db)
const audit = new AuditLog(db)
const decisions = new DecisionDB(db)
const TEAM_AGENT_LIST = TEAM_AGENTS.join(', ')
const WORKER_AGENT_LIST = WORKER_AGENTS.join(', ')
const OWNERSHIP_LINES = WORKER_AGENTS
  .map((agent) => `${agent}: ${AGENT_OWNERSHIP[agent].join(', ')}`)
  .join(' | ')
const REPORTING_LINES = WORKER_AGENTS
  .map((agent) => `${agent} -> ${AGENT_REPORTS_TO[agent]}`)
  .join(' | ')

const isKnownAgent = (agent: string): boolean =>
  Object.prototype.hasOwnProperty.call(AGENT_SESSIONS, agent)

const normalizeScore = (raw: unknown, fallback: number = 0.6): number => {
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed <= 1) return Math.max(0.05, Math.min(1, parsed))
  if (parsed <= 10) return Math.max(0.05, Math.min(1, parsed / 10))
  return Math.max(0.05, Math.min(1, parsed / 100))
}

const parseAgentList = (input: unknown): string[] => {
  if (!Array.isArray(input)) return []
  return input
    .map((value) => String(value).toLowerCase())
    .filter((value, index, all) => value in AGENT_SESSIONS && all.indexOf(value) === index)
}

const formatDecisionBrief = (brief: ReturnType<DecisionDB['getDecisionBrief']>): string => {
  if (!brief) return 'Decision not found.'

  const critiqueMap = new Map<number, string[]>()
  for (const critique of brief.critiques) {
    const bucket = critiqueMap.get(critique.position_id) ?? []
    bucket.push(
      `  - ${critique.agent} [${critique.dimension}/${critique.severity}] conf:${critique.confidence.toFixed(2)} ${critique.summary}`,
    )
    critiqueMap.set(critique.position_id, bucket)
  }

  const lines = [
    `Decision #${brief.decision.id} [${brief.decision.status}/${brief.decision.priority}] ${brief.decision.title}`,
    `Question: ${brief.decision.description}`,
  ]

  if (brief.decision.final_summary) {
    lines.push(`Final: ${brief.decision.final_summary}`)
  }
  if (brief.decision.final_rationale) {
    lines.push(`Rationale: ${brief.decision.final_rationale}`)
  }

  if (brief.positions.length === 0) {
    lines.push('Positions: none yet.')
    return lines.join('\n')
  }

  lines.push('Positions:')
  for (const position of brief.positions) {
    lines.push(
      `- #${position.id} ${position.agent} [${position.stance}/${position.status}] conf:${position.confidence.toFixed(2)} ${position.summary}`,
    )
    lines.push(`  rationale: ${position.rationale}`)
    if (position.evidence) {
      lines.push(`  evidence: ${position.evidence}`)
    }

    const critiques = critiqueMap.get(position.id) ?? []
    if (critiques.length > 0) {
      lines.push(...critiques)
    }
  }

  return lines.join('\n')
}

const mcp = new Server(
  { name: 'task-board', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      `You are agent "${SELF_LABEL}" inside an autonomous DTC ecommerce execution team. You have a shared task board and personal memory with other agents (${TEAM_AGENT_LIST}).`,
      `Sector ownership: ${OWNERSHIP_LINES}.`,
      `Reporting lines: ${REPORTING_LINES}. Boss is the only final decision-maker for formal escalations.`,
      'TASK TOOLS: create_task, claim_task, complete_task, list_tasks, send_note, nudge_agent, interrupt_agent',
      'STATUS TOOLS: write_status (sub-agents report progress), read_status (monitor loops check progress), clear_status (cleanup after task)',
      'DECISION TOOLS: open_decision, submit_position, critique_position, list_decisions, get_decision_brief, finalize_decision',
      'MEMORY TOOLS: save_memory (store learnings), recall_memories (search your knowledge), get_boot_briefing (load context on startup)',
      'MEMORY MANAGEMENT: promote_memory (share with all agents), pin_memory (prevent decay), challenge_memory (mark a learning disputed), supersede_memory (replace stale learning)',
      'On startup, call get_boot_briefing to load your role, top memories, and recent task history.',
      'After completing tasks, save important learnings with save_memory.',
      'Default operating model: each worker owns a sector and has local authority for reversible choices inside that sector.',
      'Delegation model: Boss delegates top-level work to the relevant sector owner. Sector owners delegate bounded execution to runners, one-time agents, or narrower specialists instead of doing everything themselves.',
      'Push back when the human or another owner is wrong. Bring the strongest counter-narrative from your sector before escalating.',
      'Use open_decision only for meaningful choices: high-risk, ambiguous, irreversible, or strategic decisions. Do not turn simple execution work into a debate.',
      `Default review pool for decisions is the worker bench: ${WORKER_AGENT_LIST}.`,
      'Always delegate complex work to subagents (Agent tool) to keep your context clean.',
    ].join('\n'),
  },
)

// Register tool list
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'create_task',
      description: 'Create a task and assign it to another agent. Auto-nudges the target agent and posts to the team Telegram group.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: `Target agent: ${TEAM_AGENT_LIST}` },
          description: { type: 'string', description: 'What needs to be done' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Task priority (default: normal)' },
        },
        required: ['to', 'description'],
      },
    },
    {
      name: 'claim_task',
      description: 'Claim a pending task assigned to you. Sets status to in_progress.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'The task ID to claim' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'complete_task',
      description: 'Mark a task as completed with a result summary. Posts to team group.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number', description: 'The task ID to complete' },
          result: { type: 'string', description: 'Summary of what was done' },
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
          agent: { type: 'string', description: `Target agent: ${TEAM_AGENT_LIST}` },
          message: { type: 'string', description: 'The message to send' },
        },
        required: ['agent', 'message'],
      },
    },
    {
      name: 'open_decision',
      description: 'Create a decision record for a non-trivial escalated choice. Workers use this to escalate to Boss after gathering counter-narratives; Boss uses it to structure cross-sector review.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name for the decision' },
          description: { type: 'string', description: 'What needs to be decided and what constraint matters' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Decision urgency (default: normal)' },
          assign_agents: { type: 'array', items: { type: 'string' }, description: 'Optional agent list to request positions from' },
          auto_assign: { type: 'boolean', description: 'If true, create review tasks for the selected/default agents (default: true)' },
        },
        required: ['title', 'description'],
      },
    },
    {
      name: 'submit_position',
      description: 'Submit your current position on a decision. Replaces your previous active position for that decision.',
      inputSchema: {
        type: 'object',
        properties: {
          decision_id: { type: 'number', description: 'Decision ID' },
          stance: { type: 'string', enum: ['proposal', 'oppose', 'counterproposal', 'risk', 'evidence'], description: 'What kind of position this is' },
          summary: { type: 'string', description: 'Short recommendation or claim' },
          rationale: { type: 'string', description: 'Why you believe this position holds up' },
          confidence: { type: 'number', description: 'Confidence as 0-1, 1-10, or percent' },
          evidence: { type: 'string', description: 'Optional supporting evidence, code references, or data' },
        },
        required: ['decision_id', 'stance', 'summary', 'rationale', 'confidence'],
      },
    },
    {
      name: 'critique_position',
      description: 'Challenge another agent position with a concrete critique. Use for risk, evidence, operational, or contrarian review.',
      inputSchema: {
        type: 'object',
        properties: {
          decision_id: { type: 'number', description: 'Decision ID' },
          position_id: { type: 'number', description: 'Position ID being challenged' },
          dimension: { type: 'string', enum: ['risk', 'evidence', 'operations', 'strategy', 'contrarian'], description: 'What kind of critique this is' },
          summary: { type: 'string', description: 'What is weak, missing, or dangerous in the position' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How serious the critique is' },
          confidence: { type: 'number', description: 'Confidence as 0-1, 1-10, or percent' },
        },
        required: ['decision_id', 'position_id', 'summary', 'confidence'],
      },
    },
    {
      name: 'list_decisions',
      description: 'List recent decisions by status.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'in_review', 'decided', 'cancelled'], description: 'Optional status filter' },
          limit: { type: 'number', description: 'Max results (default: 20)' },
        },
      },
    },
    {
      name: 'get_decision_brief',
      description: 'Show the current state of a decision, including positions and critiques.',
      inputSchema: {
        type: 'object',
        properties: {
          decision_id: { type: 'number', description: 'Decision ID' },
        },
        required: ['decision_id'],
      },
    },
    {
      name: 'finalize_decision',
      description: 'Close a decision with a final verdict and rationale. Boss only. This also writes learning memories so future decisions improve.',
      inputSchema: {
        type: 'object',
        properties: {
          decision_id: { type: 'number', description: 'Decision ID' },
          final_summary: { type: 'string', description: 'The final call in one sentence' },
          final_rationale: { type: 'string', description: 'Why this verdict was chosen over alternatives' },
          final_confidence: { type: 'number', description: 'Confidence as 0-1, 1-10, or percent' },
          chosen_position_id: { type: 'number', description: 'Optional winning position ID' },
        },
        required: ['decision_id', 'final_summary', 'final_rationale', 'final_confidence'],
      },
    },
    {
      name: 'save_memory',
      description: 'Save a memory/learning for yourself. Persists across sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The memory content' },
          category: { type: 'string', enum: ['learning', 'preference', 'fact', 'role', 'task_summary', 'decision', 'calibration'], description: 'Memory category' },
          importance: { type: 'number', description: 'Importance 1-5 (default: 3). Higher = persists longer.' },
          pinned: { type: 'boolean', description: 'Pin to prevent decay (default: false). Use for role definitions.' },
          classification: { type: 'string', enum: ['foundational', 'strategic', 'operational', 'observational', 'ephemeral'], description: 'Decay class. Omit to infer automatically.' },
          quality: { type: 'number', description: 'Learning quality as 0-1, 1-10, or percent' },
          evidence: { type: 'string', description: 'Optional proof, example, or rationale for why this memory should be trusted' },
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
          category: { type: 'string', enum: ['learning', 'preference', 'fact', 'task_summary', 'role', 'decision', 'calibration'], description: 'Filter by category' },
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
      name: 'challenge_memory',
      description: 'Mark a learning as challenged when it is outdated, contradicted, or weakly supported.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'number', description: 'The memory ID to challenge' },
          reason: { type: 'string', description: 'Why this memory should be treated with skepticism' },
          confidence: { type: 'number', description: 'Confidence as 0-1, 1-10, or percent' },
        },
        required: ['memory_id', 'reason'],
      },
    },
    {
      name: 'supersede_memory',
      description: 'Replace a stale learning with a better one. The old memory is marked superseded and archived on the next consolidation pass.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'number', description: 'The memory ID being replaced' },
          content: { type: 'string', description: 'The new replacement learning' },
          evidence: { type: 'string', description: 'Why the old memory is no longer the best guidance' },
          importance: { type: 'number', description: 'Importance 1-5 for the replacement memory' },
          quality: { type: 'number', description: 'Quality as 0-1, 1-10, or percent' },
          classification: { type: 'string', enum: ['foundational', 'strategic', 'operational', 'observational', 'ephemeral'], description: 'Optional decay class override' },
        },
        required: ['memory_id', 'content'],
      },
    },
    {
      name: 'interrupt_agent',
      description: 'Send Ctrl+C to an agent\'s tmux session. Use when a sub-agent or runner is stuck, hung, or needs to be force-stopped.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: `Target agent: ${TEAM_AGENT_LIST}` },
          reason: { type: 'string', description: 'Why the interrupt is needed' },
        },
        required: ['agent', 'reason'],
      },
    },
    {
      name: 'write_status',
      description: 'Write a JSONL status entry for a delegated task. Sub-agents call this to report progress.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: `The parent agent name (${TEAM_AGENT_LIST})` },
          task_id: { type: 'number', description: 'The task ID being worked on' },
          status: { type: 'string', enum: ['working', 'blocked', 'complete', 'idle'], description: 'Current status' },
          detail: { type: 'string', description: 'What is happening right now' },
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
          agent: { type: 'string', description: `The agent whose status to read (${TEAM_AGENT_LIST})` },
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
  ],
}))

// Handle tool calls
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'create_task': {
        const to = (args.to as string).toLowerCase()
        const description = args.description as string
        const priority = (args.priority as string) ?? 'normal'

        if (!isKnownAgent(to)) {
          return { content: [{ type: 'text', text: `Unknown agent: ${to}`, isError: true }] }
        }

        const task = db.createTask({ from: SELF_LABEL, to, description, priority })

        const nudgeMsg = `You have a new task (#${task.id}) from ${SELF_LABEL}: ${description}`
        await nudgeAgent(to, nudgeMsg)
        await postToGroup(formatTaskCreated(task))
        audit.log(SELF_LABEL, 'task_created', { to, description, priority }, task.id)

        return { content: [{ type: 'text', text: `Task #${task.id} created and assigned to ${to}. Agent nudged.` }] }
      }

      case 'claim_task': {
        const taskId = args.task_id as number
        const task = db.claimTask(taskId, SELF_LABEL)

        if (!task) {
          audit.log(SELF_LABEL, 'task_failed', { task_id: taskId, reason: 'not found or already claimed' }, taskId)
          return { content: [{ type: 'text', text: `Cannot claim task #${taskId} — either it doesn't exist or is already claimed.`, isError: true }] }
        }

        await postToGroup(formatTaskClaimed(task))
        audit.log(SELF_LABEL, 'task_claimed', { task_id: taskId }, taskId)
        return { content: [{ type: 'text', text: `Claimed task #${task.id}: ${task.description}` }] }
      }

      case 'complete_task': {
        const taskId = args.task_id as number
        const result = args.result as string
        const task = db.completeTask(taskId, result)

        if (!task) {
          audit.log(SELF_LABEL, 'task_failed', { task_id: taskId, reason: 'not found or not in progress' }, taskId)
          return { content: [{ type: 'text', text: `Cannot complete task #${taskId} — either it doesn't exist or isn't in progress.`, isError: true }] }
        }

        const nudgeMsg = `Task #${task.id} completed by ${SELF_LABEL}: ${result}`
        await nudgeAgent(task.from_agent, nudgeMsg)
        await postToGroup(formatTaskCompleted(task))

        // Auto-extract task summary as memory
        const priorityToImportance: Record<string, number> = { low: 1, normal: 2, high: 3, urgent: 4 }
        mem.saveMemory({
          agent: SELF_LABEL,
          content: `Task #${task.id}: ${task.description} → Result: ${result}`,
          category: 'task_summary',
          importance: priorityToImportance[task.priority] ?? 2,
          source_task_id: task.id,
        })
        audit.log(SELF_LABEL, 'task_completed', { task_id: taskId, result }, taskId)

        return { content: [{ type: 'text', text: `Task #${task.id} completed. Result: ${result}` }] }
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
        await postToGroup(formatNote(taskId, SELF_LABEL, message))
        audit.log(SELF_LABEL, 'note_added', { task_id: taskId, message }, taskId)

        return { content: [{ type: 'text', text: `Note added to task #${taskId}.` }] }
      }

      case 'nudge_agent': {
        const agent = (args.agent as string).toLowerCase()
        const message = args.message as string

        if (!isKnownAgent(agent)) {
          return { content: [{ type: 'text', text: `Unknown agent: ${agent}`, isError: true }] }
        }

        const result = await nudgeAgent(agent, message)

        if (!result.ok) {
          return { content: [{ type: 'text', text: `Nudge failed: ${result.error}`, isError: true }] }
        }

        await postToGroup(formatNudge(SELF_LABEL, agent, message))
        audit.log(SELF_LABEL, 'agent_nudged', { target: agent, message })
        return { content: [{ type: 'text', text: `Nudged ${agent}: ${message}` }] }
      }

      case 'open_decision': {
        const title = args.title as string
        const description = args.description as string
        const priority = (args.priority as string) ?? 'normal'
        const autoAssign = args.auto_assign === undefined ? true : Boolean(args.auto_assign)

        const decision = decisions.createDecision({
          title,
          description,
          createdBy: SELF_LABEL,
          priority,
        })

        let reviewers = parseAgentList(args.assign_agents)
        if (autoAssign && reviewers.length === 0) {
          reviewers = WORKER_AGENTS.filter((agent) => agent !== SELF_LABEL)
        }

        const reviewTasks: number[] = []
        if (autoAssign) {
          for (const reviewer of reviewers) {
            const reviewTask = db.createTask({
              from: SELF_LABEL,
              to: reviewer,
              description: `Decision #${decision.id}: ${title}. Review it and submit your own position with submit_position.`,
              priority,
            })
            reviewTasks.push(reviewTask.id)
            await nudgeAgent(
              reviewer,
              `Decision #${decision.id} needs your judgment: ${title}. Submit a position when ready.`,
            )
            await postToGroup(formatTaskCreated(reviewTask))
            audit.log(SELF_LABEL, 'decision_review_requested', { decision_id: decision.id, reviewer }, reviewTask.id)
          }
        }

        let bossTaskId: number | null = null
        if (SELF_LABEL !== BOSS_AGENT) {
          const bossTask = db.createTask({
            from: SELF_LABEL,
            to: BOSS_AGENT,
            description: `Decision #${decision.id}: ${title}. Sector escalation opened by ${SELF_LABEL}; review positions and make the final call with finalize_decision once the record is complete.`,
            priority,
          })
          bossTaskId = bossTask.id
          await nudgeAgent(
            BOSS_AGENT,
            `Decision #${decision.id} has been escalated by ${SELF_LABEL}: ${title}. You are the final decision-maker after review.`,
          )
          await postToGroup(formatTaskCreated(bossTask))
          audit.log(SELF_LABEL, 'decision_escalated_to_boss', { decision_id: decision.id }, bossTask.id)
        }

        await postToGroup(`🧠 Decision #${decision.id} opened by ${SELF_LABEL}: ${title}`)
        audit.log(
          SELF_LABEL,
          'decision_opened',
          { decision_id: decision.id, title, priority, reviewers, auto_assign: autoAssign },
        )

        const assignmentText =
          reviewTasks.length > 0 ? ` Review tasks created for: ${reviewers.join(', ')}.` : ''
        const bossText =
          bossTaskId !== null ? ` Boss escalation task: #${bossTaskId}.` : ''
        return {
          content: [
            {
              type: 'text',
              text: `Decision #${decision.id} opened [${decision.status}/${decision.priority}] ${decision.title}.${assignmentText}${bossText}`,
            },
          ],
        }
      }

      case 'submit_position': {
        const position = decisions.submitPosition({
          decisionId: args.decision_id as number,
          agent: SELF_LABEL,
          stance: args.stance as string,
          summary: args.summary as string,
          rationale: args.rationale as string,
          confidence: normalizeScore(args.confidence, 0.6),
          evidence: args.evidence as string | undefined,
        })

        if (!position) {
          return { content: [{ type: 'text', text: 'Could not submit position. The decision may be closed or missing.', isError: true }] }
        }

        audit.log(SELF_LABEL, 'decision_position_submitted', {
          decision_id: position.decision_id,
          position_id: position.id,
          stance: position.stance,
          confidence: position.confidence,
        })

        return {
          content: [
            {
              type: 'text',
              text: `Position #${position.id} submitted for decision #${position.decision_id} [${position.stance}] conf:${position.confidence.toFixed(2)} ${position.summary}`,
            },
          ],
        }
      }

      case 'critique_position': {
        const critique = decisions.critiquePosition({
          decisionId: args.decision_id as number,
          positionId: args.position_id as number,
          agent: SELF_LABEL,
          dimension: args.dimension as string | undefined,
          summary: args.summary as string,
          severity: args.severity as string | undefined,
          confidence: normalizeScore(args.confidence, 0.7),
        })

        if (!critique) {
          return { content: [{ type: 'text', text: 'Could not submit critique. Check that the position exists, belongs to the decision, and is not your own.', isError: true }] }
        }

        audit.log(SELF_LABEL, 'decision_position_critiqued', {
          decision_id: critique.decision_id,
          position_id: critique.position_id,
          critique_id: critique.id,
          dimension: critique.dimension,
          severity: critique.severity,
          confidence: critique.confidence,
        })

        return {
          content: [
            {
              type: 'text',
              text: `Critique #${critique.id} added to position #${critique.position_id} [${critique.dimension}/${critique.severity}] conf:${critique.confidence.toFixed(2)}`,
            },
          ],
        }
      }

      case 'list_decisions': {
        const results = decisions.listDecisions({
          status: args.status as string | undefined,
          limit: args.limit as number | undefined,
        })

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'No decisions found.' }] }
        }

        return {
          content: [
            {
              type: 'text',
              text: results
                .map((decision) => `#${decision.id} [${decision.status}/${decision.priority}] ${decision.title} | by ${decision.created_by}`)
                .join('\n'),
            },
          ],
        }
      }

      case 'get_decision_brief': {
        const brief = decisions.getDecisionBrief(args.decision_id as number)
        if (!brief) {
          return { content: [{ type: 'text', text: `Decision #${args.decision_id as number} not found.`, isError: true }] }
        }

        audit.log(SELF_LABEL, 'decision_brief_viewed', { decision_id: brief.decision.id })
        return { content: [{ type: 'text', text: formatDecisionBrief(brief) }] }
      }

      case 'finalize_decision': {
        if (SELF_LABEL !== BOSS_AGENT) {
          audit.log(SELF_LABEL, 'decision_finalize_denied', {
            decision_id: args.decision_id as number,
            reason: 'boss_only',
          })
          return {
            content: [
              {
                type: 'text',
                text: 'Only Boss can finalize a formal escalated decision. Submit your position or critique, then escalate to Boss for the final call.',
                isError: true,
              },
            ],
          }
        }

        const decisionId = args.decision_id as number
        const finalConfidence = normalizeScore(args.final_confidence, 0.7)
        const chosenPositionId = args.chosen_position_id as number | undefined

        const decision = decisions.finalizeDecision({
          decisionId,
          finalSummary: args.final_summary as string,
          finalRationale: args.final_rationale as string,
          finalConfidence,
          chosenPositionId,
        })

        if (!decision) {
          return { content: [{ type: 'text', text: 'Could not finalize decision. It may already be closed, missing, or have no active positions.', isError: true }] }
        }

        const brief = decisions.getDecisionBrief(decision.id)
        const sharedImportance = decision.priority === 'urgent' ? 5 : decision.priority === 'high' ? 4 : 3

        mem.saveMemory({
          agent: 'shared',
          content: `Decision #${decision.id} (${decision.title}) → ${decision.final_summary}`,
          category: 'decision',
          classification: 'strategic',
          importance: sharedImportance,
          quality: finalConfidence,
          source_type: 'decision',
          evidence: decision.final_rationale ?? undefined,
        })

        if (brief) {
          for (const position of brief.positions.filter((entry) => entry.status === 'active')) {
            const adopted = decision.chosen_position_id === position.id
            mem.saveMemory({
              agent: position.agent,
              content: adopted
                ? `Decision calibration #${decision.id} (${decision.title}): your ${position.stance} position held up. Pattern: ${position.summary}`
                : `Decision calibration #${decision.id} (${decision.title}): your ${position.stance} position was not selected. Compare your reasoning against the final rationale before reusing it.`,
              category: 'calibration',
              classification: adopted ? 'strategic' : 'observational',
              importance: adopted ? 4 : 2,
              quality: adopted ? finalConfidence : 0.55,
              source_type: 'decision',
              evidence: decision.final_rationale ?? position.rationale,
            })
          }
        }

        await postToGroup(`✅ Decision #${decision.id} finalized by ${SELF_LABEL}: ${decision.final_summary}`)
        audit.log(SELF_LABEL, 'decision_finalized', {
          decision_id: decision.id,
          chosen_position_id: decision.chosen_position_id,
          final_confidence: decision.final_confidence,
        })

        return {
          content: [
            {
              type: 'text',
              text: `Decision #${decision.id} finalized: ${decision.final_summary}`,
            },
          ],
        }
      }

      case 'save_memory': {
        const content = args.content as string
        const category = args.category as string
        const importance = (args.importance as number) ?? 3
        const pinned = (args.pinned as boolean) ?? false

        const memory = mem.saveMemory({
          agent: SELF_LABEL,
          content,
          category,
          importance,
          pinned,
          classification: args.classification as string | undefined,
          quality: args.quality === undefined ? undefined : normalizeScore(args.quality, 0.6),
          evidence: args.evidence as string | undefined,
        })
        audit.log(SELF_LABEL, 'memory_saved', {
          category,
          importance: memory.importance,
          classification: memory.classification,
          quality: memory.quality,
          state: memory.state,
        }, undefined, memory.id)

        return { content: [{ type: 'text', text: `Memory #${memory.id} stored [${memory.classification}/${memory.state}] importance:${memory.importance} quality:${memory.quality.toFixed(2)}${memory.pinned ? ' pinned' : ''}` }] }
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
          (m) => `#${m.id} [${m.category}/${m.classification}/${m.state}] imp:${m.importance} q:${m.quality.toFixed(2)} ${m.pinned ? '📌' : ''} ${m.content}`,
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

      case 'challenge_memory': {
        const memoryId = args.memory_id as number
        const challenged = mem.challengeMemory(
          memoryId,
          args.reason as string,
          normalizeScore(args.confidence, 0.7),
        )

        if (!challenged) {
          return { content: [{ type: 'text', text: `Memory #${memoryId} not found.`, isError: true }] }
        }

        audit.log(SELF_LABEL, 'memory_challenged', {
          memory_id: memoryId,
          state: challenged.state,
          quality: challenged.quality,
          challenge_count: challenged.challenge_count,
        }, undefined, memoryId)

        return {
          content: [
            {
              type: 'text',
              text: `Memory #${memoryId} challenged. State: ${challenged.state}. Quality: ${challenged.quality.toFixed(2)}.`,
            },
          ],
        }
      }

      case 'supersede_memory': {
        const memoryId = args.memory_id as number
        const replacement = mem.supersedeMemory(memoryId, {
          content: args.content as string,
          evidence: args.evidence as string | undefined,
          importance: args.importance as number | undefined,
          quality: args.quality === undefined ? undefined : normalizeScore(args.quality, 0.7),
          classification: args.classification as string | undefined,
        })

        if (!replacement) {
          return { content: [{ type: 'text', text: `Memory #${memoryId} not found.`, isError: true }] }
        }

        audit.log(SELF_LABEL, 'memory_superseded', {
          old_memory_id: memoryId,
          new_memory_id: replacement.id,
          classification: replacement.classification,
        }, undefined, replacement.id)

        return {
          content: [
            {
              type: 'text',
              text: `Memory #${memoryId} superseded by memory #${replacement.id}.`,
            },
          ],
        }
      }

      case 'interrupt_agent': {
        const agent = (args.agent as string).toLowerCase()
        const reason = args.reason as string

        if (!isKnownAgent(agent)) {
          return { content: [{ type: 'text', text: `Unknown agent: ${agent}`, isError: true }] }
        }

        const session = AGENT_SESSIONS[agent]

        const proc = Bun.spawn(['tmux', 'send-keys', '-t', session, 'C-c'], { stdout: 'pipe', stderr: 'pipe' })
        const exitCode = await proc.exited

        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text()
          return { content: [{ type: 'text', text: `Interrupt failed: ${stderr.trim()}`, isError: true }] }
        }

        audit.log(SELF_LABEL, 'agent_interrupted', { target: agent, reason })
        await postToGroup(`🛑 ${SELF_LABEL} interrupted ${agent}: ${reason}`)
        return { content: [{ type: 'text', text: `Sent Ctrl+C to ${agent} (${session}). Reason: ${reason}` }] }
      }

      case 'write_status': {
        const agent = (args.agent as string).toLowerCase()
        const taskId = args.task_id as number
        const status = args.status as string
        const detail = args.detail as string

        if (!isKnownAgent(agent)) {
          return { content: [{ type: 'text', text: `Unknown agent: ${agent}`, isError: true }] }
        }

        mkdirSync(STATUS_DIR, { recursive: true })
        const filePath = join(STATUS_DIR, `${agent}-tasks.jsonl`)
        const entry = JSON.stringify({ task_id: taskId, ts: new Date().toISOString(), status, detail })
        appendFileSync(filePath, entry + '\n')

        audit.log(SELF_LABEL, 'status_written', { agent, task_id: taskId, status, detail }, taskId)
        return { content: [{ type: 'text', text: `Status written for ${agent} task #${taskId}: [${status}] ${detail}` }] }
      }

      case 'read_status': {
        const agent = (args.agent as string).toLowerCase()
        const taskId = args.task_id as number | undefined
        const lastN = (args.last_n as number) ?? 20

        if (!isKnownAgent(agent)) {
          return { content: [{ type: 'text', text: `Unknown agent: ${agent}`, isError: true }] }
        }

        const filePath = join(STATUS_DIR, `${agent}-tasks.jsonl`)
        if (!existsSync(filePath)) {
          return { content: [{ type: 'text', text: `No status file for ${agent}. No delegated tasks have reported yet.` }] }
        }

        const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)
        let entries = lines.map(l => JSON.parse(l))

        if (taskId !== undefined) {
          entries = entries.filter((e: any) => e.task_id === taskId)
        }

        entries = entries.slice(-lastN)

        if (entries.length === 0) {
          return { content: [{ type: 'text', text: taskId ? `No status entries for task #${taskId}.` : `No status entries for ${agent}.` }] }
        }

        const output = entries.map((e: any) => `[${e.ts}] task#${e.task_id} ${e.status}: ${e.detail}`).join('\n')
        return { content: [{ type: 'text', text: output }] }
      }

      case 'clear_status': {
        const agent = (args.agent as string).toLowerCase()
        const taskId = args.task_id as number

        if (!isKnownAgent(agent)) {
          return { content: [{ type: 'text', text: `Unknown agent: ${agent}`, isError: true }] }
        }

        const filePath = join(STATUS_DIR, `${agent}-tasks.jsonl`)
        if (!existsSync(filePath)) {
          return { content: [{ type: 'text', text: `No status file for ${agent}.` }] }
        }

        const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)
        const remaining = lines.filter(l => {
          const entry = JSON.parse(l)
          return entry.task_id !== taskId
        })

        if (remaining.length === 0) {
          unlinkSync(filePath)
        } else {
          writeFileSync(filePath, remaining.join('\n') + '\n')
        }

        audit.log(SELF_LABEL, 'status_cleared', { agent, task_id: taskId }, taskId)
        return { content: [{ type: 'text', text: `Cleared status entries for ${agent} task #${taskId}.` }] }
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

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}`, isError: true }] }
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err}`, isError: true }] }
  }
})

await mcp.connect(new StdioServerTransport())

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
