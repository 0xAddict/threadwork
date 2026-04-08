import { join } from 'path'

export const DB_PATH = join(
  process.env.HOME ?? '/tmp',
  '.claude',
  'mcp-servers',
  'task-board',
  'tasks.db',
)

export const TELEGRAM_GROUP_ID = '-1003790554582'

// Bot token is passed via env var TELEGRAM_BOT_TOKEN by the pool script
export const getTelegramToken = (): string | undefined =>
  process.env.TELEGRAM_BOT_TOKEN

// Map of agent labels to tmux session names
export const AGENT_SESSIONS: Record<string, string> = {
  boss: 'claude-boss',
  steve: 'claude-steve',
  sadie: 'claude-sadie',
  kiera: 'claude-kiera',
  snoopy: 'claude-snoopy',
}

// The agent label for this session (set by pool script via env var)
export const SELF_LABEL = process.env.AGENT_LABEL ?? 'unknown'

if (SELF_LABEL === 'unknown') {
  console.error('[task-board] WARNING: AGENT_LABEL env var not set — SELF_LABEL is "unknown". Set AGENT_LABEL to one of: ' + Object.keys(AGENT_SESSIONS).join(', '))
}

// Absolute path to tmux binary
export const TMUX_PATH = '/Users/coachstokes/.local/bin/tmux'

// Status file directory for sub-agent JSONL status updates
export const STATUS_DIR = join(
  process.env.HOME ?? '/tmp',
  '.claude',
  'status',
)

// Consolidation daemon config
export const CONSOLIDATION_DRY_RUN = false // Flipped live by Snoopy on 2026-04-05
export const CONSOLIDATION_CHECK_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes

// Supervision defaults (Sprint 1 — Durable Supervision System)
export const SUPERVISION_DEFAULTS = {
  heartbeat_timeout_sec: 120,
  progress_timeout_sec: 600,
  watchdog_interval_sec: 30,
  claim_timeout_sec: 60,
}

export const DEFAULT_HEARTBEAT_TIMEOUT_SEC = 120
export const DEFAULT_PROGRESS_TIMEOUT_SEC = 600
export const WATCHDOG_CADENCE_SEC = 30
export const UNCLAIMED_CHECK_SEC = 60
export const SESSION_TIMEOUT_SEC = 180

// DTC Team Topology
export const TEAM_AGENTS = ['boss', 'steve', 'sadie', 'kiera', 'snoopy'] as const
export const WORKER_AGENTS = ['steve', 'sadie', 'kiera', 'snoopy'] as const
export const BOSS_AGENT = 'boss'

export const AGENT_OWNERSHIP: Record<string, string> = {
  boss: 'CEO/Orchestrator — delegates, decides, reviews',
  steve: 'Engineering — code, infrastructure, technical implementation',
  sadie: 'Operations — ads, analytics, campaign management',
  kiera: 'Intelligence — research, analysis, competitive intel',
  snoopy: 'CRM — customer lifecycle, bookings, communications',
}

export const AGENT_REPORTS_TO: Record<string, string> = {
  steve: 'boss',
  sadie: 'boss',
  kiera: 'boss',
  snoopy: 'boss',
  boss: 'human',
}

// Session Debrief Daemon defaults
export const DEBRIEF_DEFAULTS = {
  idle_threshold_min: 15,
  min_completed_tasks: 3,
  min_new_memories: 5,
  min_hours_since_last: 2,
  lock_ttl_min: 10,
}
