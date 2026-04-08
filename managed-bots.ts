import type { TaskDB } from './db'

// Snoopy manager bot
const MANAGER_BOT_TOKEN = '8691345606:AAHhbsb8BnGfK0j6SaHEdic5h79Y826TgD4'
const MANAGER_BOT_USERNAME = 'taskrunner1bot'
const TELEGRAM_API = 'https://api.telegram.org/bot'

export type BotStatus = 'pending' | 'created' | 'failed' | 'recovered'

export interface ManagedBot {
  id: number
  intended_username: string
  display_name: string | null
  token: string | null
  bot_id: number | null
  status: BotStatus
  created_at: string
  recovered_at: string | null
  error_log: string | null
}

export interface CreateBotInput {
  intended_username: string
  display_name?: string
}

export class ManagedBotsDB {
  private taskDb: TaskDB

  constructor(taskDb: TaskDB) {
    this.taskDb = taskDb
    this.migrate()
  }

  private migrate(): void {
    this.taskDb.run(db => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS managed_bots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          intended_username TEXT NOT NULL,
          display_name TEXT,
          token TEXT,
          bot_id INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          recovered_at TEXT,
          error_log TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_managed_bots_username ON managed_bots(intended_username);
        CREATE INDEX IF NOT EXISTS idx_managed_bots_bot_id ON managed_bots(bot_id);
        CREATE INDEX IF NOT EXISTS idx_managed_bots_status ON managed_bots(status);
      `)
    })
  }

  /** Insert a pre-creation record before attempting BotFather flow */
  insert(input: CreateBotInput): ManagedBot {
    return this.taskDb.run(db => {
      const stmt = db.prepare(`
        INSERT INTO managed_bots (intended_username, display_name, status)
        VALUES (?, ?, 'pending')
        RETURNING *
      `)
      return stmt.get(input.intended_username, input.display_name ?? null) as ManagedBot
    })
  }

  /** Update bot record after successful creation */
  markCreated(id: number, token: string, bot_id: number): ManagedBot {
    return this.taskDb.run(db => {
      const stmt = db.prepare(`
        UPDATE managed_bots
        SET token = ?, bot_id = ?, status = 'created'
        WHERE id = ?
        RETURNING *
      `)
      return stmt.get(token, bot_id, id) as ManagedBot
    })
  }

  /** Mark a creation attempt as failed with error details */
  markFailed(id: number, error: string): ManagedBot {
    return this.taskDb.run(db => {
      const stmt = db.prepare(`
        UPDATE managed_bots
        SET status = 'failed', error_log = COALESCE(error_log || '\n', '') || ?
        WHERE id = ?
        RETURNING *
      `)
      return stmt.get(`[${new Date().toISOString()}] ${error}`, id) as ManagedBot
    })
  }

  /** Mark a bot as recovered after token retrieval */
  markRecovered(id: number, token: string): ManagedBot {
    return this.taskDb.run(db => {
      const stmt = db.prepare(`
        UPDATE managed_bots
        SET token = ?, status = 'recovered', recovered_at = datetime('now')
        WHERE id = ?
        RETURNING *
      `)
      return stmt.get(token, id) as ManagedBot
    })
  }

  /** Look up a bot by intended username */
  getByUsername(username: string): ManagedBot | null {
    return this.taskDb.run(db => {
      return db.prepare('SELECT * FROM managed_bots WHERE intended_username = ?').get(username) as ManagedBot | null
    })
  }

  /** Look up a bot by Telegram bot_id */
  getByBotId(bot_id: number): ManagedBot | null {
    return this.taskDb.run(db => {
      return db.prepare('SELECT * FROM managed_bots WHERE bot_id = ?').get(bot_id) as ManagedBot | null
    })
  }

  /** Get bot by internal DB id */
  getById(id: number): ManagedBot | null {
    return this.taskDb.run(db => {
      return db.prepare('SELECT * FROM managed_bots WHERE id = ?').get(id) as ManagedBot | null
    })
  }

  /** List all managed bots */
  listAll(): ManagedBot[] {
    return this.taskDb.run(db => {
      return db.prepare('SELECT * FROM managed_bots ORDER BY created_at DESC').all() as ManagedBot[]
    })
  }

  /** List bots by status */
  listByStatus(status: BotStatus): ManagedBot[] {
    return this.taskDb.run(db => {
      return db.prepare('SELECT * FROM managed_bots WHERE status = ? ORDER BY created_at DESC').all(status) as ManagedBot[]
    })
  }
}

// --- Telegram Bot API 9.6 Client ---

interface TelegramResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

/** Get the token for a managed bot by its bot_id */
export async function getManagedBotToken(bot_id: number, manager_token: string = MANAGER_BOT_TOKEN): Promise<string> {
  const res = await fetch(`${TELEGRAM_API}${manager_token}/getManagedBotToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot_id }),
  })
  const data = await res.json() as TelegramResponse<{ token: string }>
  if (!data.ok || !data.result) {
    throw new Error(`getManagedBotToken failed: ${data.description ?? 'unknown error'} (code: ${data.error_code})`)
  }
  return data.result.token
}

/** Rotate and get a new token for a managed bot */
export async function replaceManagedBotToken(bot_id: number, manager_token: string = MANAGER_BOT_TOKEN): Promise<string> {
  const res = await fetch(`${TELEGRAM_API}${manager_token}/replaceManagedBotToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot_id }),
  })
  const data = await res.json() as TelegramResponse<{ token: string }>
  if (!data.ok || !data.result) {
    throw new Error(`replaceManagedBotToken failed: ${data.description ?? 'unknown error'} (code: ${data.error_code})`)
  }
  return data.result.token
}

/** Generate the managed bot creation link */
export function createManagedBotLink(suggested_username: string, manager_username: string = MANAGER_BOT_USERNAME): string {
  return `https://t.me/newbot/${manager_username}/${suggested_username}`
}

// --- Resilient Creation Flow ---

export interface CreateBotResult {
  bot: ManagedBot
  link: string
  recovered: boolean
}

/**
 * Full resilient bot creation flow:
 * 1. Write pre-creation DB record
 * 2. Generate creation link (human must tap it)
 * 3. After human confirms creation, call registerCreatedBot() with the bot_id
 *
 * If creation fails, call recoverBotToken() to attempt recovery.
 */
export function initiateCreation(db: ManagedBotsDB, input: CreateBotInput): { record: ManagedBot; link: string } {
  const record = db.insert(input)
  const link = createManagedBotLink(input.intended_username)
  return { record, link }
}

/** After human taps the creation link and bot is created, register it */
export async function registerCreatedBot(
  db: ManagedBotsDB,
  record_id: number,
  bot_id: number,
): Promise<ManagedBot> {
  const token = await getManagedBotToken(bot_id)
  return db.markCreated(record_id, token, bot_id)
}

/**
 * Retry wrapper: attempt to recover a token for a bot that was created but whose token was lost.
 * 1. Try getManagedBotToken
 * 2. If that fails, wait 5s and try replaceManagedBotToken
 */
export async function recoverBotToken(
  db: ManagedBotsDB,
  record_id: number,
  bot_id: number,
): Promise<ManagedBot> {
  // Attempt 1: getManagedBotToken
  try {
    const token = await getManagedBotToken(bot_id)
    return db.markRecovered(record_id, token)
  } catch (err1: any) {
    db.markFailed(record_id, `getManagedBotToken failed: ${err1.message}`)
  }

  // Wait 5s before fallback
  await new Promise(resolve => setTimeout(resolve, 5000))

  // Attempt 2: replaceManagedBotToken
  try {
    const token = await replaceManagedBotToken(bot_id)
    return db.markRecovered(record_id, token)
  } catch (err2: any) {
    db.markFailed(record_id, `replaceManagedBotToken also failed: ${err2.message}`)
    throw new Error(`Token recovery failed for bot_id ${bot_id}. Both getManagedBotToken and replaceManagedBotToken failed. Check error_log for details.`)
  }
}
