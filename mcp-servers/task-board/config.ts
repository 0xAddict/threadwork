import { join } from 'path'

export const DB_PATH = join(
  process.env.HOME ?? '/tmp',
  '.claude',
  'mcp-servers',
  'task-board',
  'tasks.db',
)

// Telegram group for task status broadcasts.
// Set via TELEGRAM_GROUP_ID env var or override here.
export const TELEGRAM_GROUP_ID =
  process.env.TELEGRAM_GROUP_ID ?? ''

// Bot token is passed via env var TELEGRAM_BOT_TOKEN by the pool script
export const getTelegramToken = (): string | undefined =>
  process.env.TELEGRAM_BOT_TOKEN

// Map of agent labels to tmux session names
export const AGENT_SESSIONS: Record<string, string> = {
  boss: 'claude-boss',
  steve: 'claude-steve',
  sadie: 'claude-sadie',
  kiera: 'claude-kiera',
}

// The agent label for this session (set by pool script via env var)
export const SELF_LABEL = process.env.AGENT_LABEL ?? 'unknown'
