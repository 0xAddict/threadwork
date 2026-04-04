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
export const CONSOLIDATION_DRY_RUN = true // Flip to false after 2-week validation
export const CONSOLIDATION_CHECK_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes
