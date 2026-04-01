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

export const TEAM_AGENTS = ['boss', 'steve', 'sadie', 'kiera', 'snoopy'] as const
export const WORKER_AGENTS = ['steve', 'sadie', 'kiera', 'snoopy'] as const

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

// Status file directory for sub-agent JSONL status updates
export const STATUS_DIR = join(
  process.env.HOME ?? '/tmp',
  '.claude',
  'status',
)
