import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Task } from './db'
import { TELEGRAM_GROUP_ID, DB_PATH, cardDeepLink } from './config'

// ---------------------------------------------------------------------------
// Board WATCHER bot token for GROUP lifecycle posts (#1855)
//
// All GROUP lifecycle events (create/claim/complete/note/decision/nudge digest)
// now speak with ONE voice — the board watcher bot (@Iceproncessfinancebot,
// id 8761954986) — instead of inheriting each agent's per-session
// TELEGRAM_BOT_TOKEN. This is the PROCESS half of the bot split: PROCESS (board
// state-changes → group) = watcher bot; DIALOGUE (DM/nudge-to-agent) = agent
// bots. Group messages still NAME their agent in the text (e.g. "sadie
// completed #1785"); only the SENDING bot identity changes.
//
// The DM/agent path is unaffected — dispatchAgentNudge() in nudge.ts delivers
// inter-agent nudges via tmux send-keys, never through this token or
// sendToGroup(), so it keeps its agent-bot/per-pane identity untouched.
//
// 🔒 The token VALUE is never logged or embedded here — it is read at call time
// from ~/.secrets/watcher-bot-token (overridable for tests via
// WATCHER_BOT_TOKEN env / WATCHER_BOT_TOKEN_FILE path), mirroring the step-1
// daemon's resolveBotToken(). Fail-loud per #2198: a missing/empty token throws
// a visible error rather than silently no-op'ing.
// ---------------------------------------------------------------------------

const WATCHER_BOT_TOKEN_FILE =
  process.env.WATCHER_BOT_TOKEN_FILE ??
  join(process.env.HOME ?? '/tmp', '.secrets', 'watcher-bot-token')

let _watcherTokenCache: string | null = null

/**
 * Resolve the board watcher bot token for GROUP lifecycle posts.
 *
 * Precedence (mirrors the step-1 daemon's resolveBotToken):
 *   1. WATCHER_BOT_TOKEN env var (tests / explicit override)
 *   2. WATCHER_BOT_TOKEN_FILE (default ~/.secrets/watcher-bot-token), read +
 *      cached at first use.
 *
 * Fail-loud (#2198): throws if no token can be resolved — never returns a falsy
 * value that would make the caller silently skip the post.
 */
export function getWatcherToken(): string {
  const fromEnv = process.env.WATCHER_BOT_TOKEN
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()

  if (_watcherTokenCache) return _watcherTokenCache

  try {
    if (existsSync(WATCHER_BOT_TOKEN_FILE)) {
      const contents = readFileSync(WATCHER_BOT_TOKEN_FILE, 'utf8').trim()
      if (contents !== '') {
        _watcherTokenCache = contents
        return contents
      }
    }
  } catch (err) {
    throw new Error(
      `[notify] FATAL: watcher bot token unreadable at ${WATCHER_BOT_TOKEN_FILE}: ${err}`,
    )
  }

  throw new Error(
    `[notify] FATAL: watcher bot token missing — set WATCHER_BOT_TOKEN env or create ${WATCHER_BOT_TOKEN_FILE}. Refusing to post group lifecycle events with no board-bot identity (#1855/#2198).`,
  )
}

/** Test hook: clear the cached watcher token (so a changed env/file re-reads). */
export function __resetWatcherToken(): void {
  _watcherTokenCache = null
}

/** Escape special characters for Telegram MarkdownV2 */
export function esc(text: string | null | undefined): string {
  if (text == null) return ''
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

/**
 * Escape a URL for use inside a MarkdownV2 inline link `(URL)`. Per the Telegram
 * MarkdownV2 spec, inside the parentheses of an inline link ONLY `)` and `\`
 * must be escaped — escaping the rest (e.g. `.`/`-`/`?`/`=`) the way `esc()`
 * does would corrupt the URL. #1785.
 */
export function escLinkUrl(url: string): string {
  return url.replace(/([)\\])/g, '\\$1')
}

/** A MarkdownV2 deep-link line for a card. Single source for the spine link. */
export function cardDeepLinkMd(taskId: number | string): string {
  return `🔗 [Open card](${escLinkUrl(cardDeepLink(taskId))})`
}

export function formatTaskCreated(task: Task): string {
  return `📋 *Task \\#${task.id} assigned*\nFrom: ${esc(task.from_agent)} → To: ${esc(task.to_agent)}\nPriority: ${esc(task.priority)}\n${esc(task.description)}\n${cardDeepLinkMd(task.id)}`
}

export function formatTaskClaimed(task: Task): string {
  return `🔨 *Task \\#${task.id} claimed by ${esc(task.to_agent)}*\n${esc(task.description)}`
}

export function formatTaskCompleted(task: Task): string {
  return `✅ *Task \\#${task.id} completed by ${esc(task.to_agent)}*\n${esc(task.description)}\nResult: ${esc(task.result ?? '')}`
}

export function formatNote(taskId: number, from: string, message: string): string {
  return `💬 *Note on task \\#${taskId}* from ${esc(from)}:\n${esc(message)}`
}

export function formatNudge(from: string, to: string, message: string): string {
  return `📨 *${esc(from)} → ${esc(to)}:*\n${esc(message)}`
}

export function formatDecisionOpened(decision: { id: number; title: string; opened_by: string }): string {
  return `\u{1F5F3} *Decision \\#${decision.id} opened by ${esc(decision.opened_by)}*\n${esc(decision.title)}`
}

function trunc(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max) + '\u2026' : text
}

export function formatPositionSubmitted(decisionId: number, agent: string, position: string, rationale?: string | null): string {
  const body = rationale ? `${trunc(position)}\n${trunc(rationale)}` : trunc(position)
  return `\u{1F5E3} *Position on decision \\#${decisionId} from ${esc(agent)}*\n${esc(body)}`
}

export function formatCritiqueSubmitted(decisionId: number, agent: string, target: string, critique: string): string {
  return `\u{1F50D} *Critique on decision \\#${decisionId} from ${esc(agent)}* \\(${esc(target)}\\)\n${esc(trunc(critique))}`
}

export function formatDecisionFinalized(decision: { id: number; title: string; finalized_by: string | null; outcome: string | null }): string {
  return `\u2705 *Decision \\#${decision.id} finalized by ${esc(decision.finalized_by ?? 'unknown')}*\n${esc(decision.title)}\nOutcome: ${esc(decision.outcome ?? '')}`
}

export function formatDecisionExpired(decision: { id: number; title: string }): string {
  return `\u23F0 *Decision \\#${decision.id} expired*\n${esc(decision.title)}`
}

// Test-mode guard: prevents tests from posting real Telegram group messages
// when they use isolated test DBs but call through real side-effectful functions.
const POST_DISABLED =
  process.env.NODE_ENV === 'test' ||
  process.env.THREADWORK_NUDGE_DISABLE === '1'

// ---------------------------------------------------------------------------
// Per-card group THREADING (#1785)
//
// One group thread per card: the FIRST state-change post for a card becomes the
// thread "spine" (root). Subsequent posts for that card reply_to the stored root
// message_id so they collapse into a single thread. The root message_id is
// persisted in the existing `telegram_conversation_state` table (context_kind=
// 'group_thread') keyed by task_id — reusing its message_id/chat_id columns.
//
// notify.ts opens its OWN short-lived bun:sqlite RW connection to the same
// tasks.db (WAL + busy_timeout) so threading works without threading a Database
// handle through every server.ts call site. This is the same multi-connection
// pattern the sync-daemon already uses against this file.
// ---------------------------------------------------------------------------

const GROUP_THREAD_KIND = 'group_thread'

let _threadDb: Database | null = null
function threadDb(): Database | null {
  if (POST_DISABLED) return null
  if (_threadDb) return _threadDb
  try {
    const db = new Database(DB_PATH, { readwrite: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    _threadDb = db
    return db
  } catch (err) {
    console.error('[notify] thread-state db open failed:', err)
    return null
  }
}

/** Look up the stored group-thread root message_id for a card, if any. */
function getThreadRoot(taskId: number): string | null {
  const db = threadDb()
  if (!db) return null
  try {
    const row = db
      .prepare(
        `SELECT message_id FROM telegram_conversation_state
         WHERE task_id = $task_id AND context_kind = $kind AND message_id IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get({ $task_id: taskId, $kind: GROUP_THREAD_KIND }) as
      | { message_id: string | null }
      | undefined
    return row?.message_id ?? null
  } catch (err) {
    console.error('[notify] getThreadRoot failed:', err)
    return null
  }
}

/** Persist the group-thread root message_id for a card (idempotent upsert). */
function setThreadRoot(taskId: number, messageId: string): void {
  const db = threadDb()
  if (!db) return
  try {
    const existing = db
      .prepare(
        `SELECT id FROM telegram_conversation_state
         WHERE task_id = $task_id AND context_kind = $kind LIMIT 1`,
      )
      .get({ $task_id: taskId, $kind: GROUP_THREAD_KIND }) as
      | { id: number }
      | undefined
    if (existing) {
      db.prepare(
        `UPDATE telegram_conversation_state
         SET message_id = $mid, updated_at = datetime('now')
         WHERE id = $id`,
      ).run({ $mid: messageId, $id: existing.id })
    } else {
      db.prepare(
        `INSERT INTO telegram_conversation_state
           (task_id, chat_id, message_id, context_kind, status)
         VALUES ($task_id, $chat_id, $mid, $kind, 'active')`,
      ).run({
        $task_id: taskId,
        $chat_id: TELEGRAM_GROUP_ID,
        $mid: messageId,
        $kind: GROUP_THREAD_KIND,
      })
    }
  } catch (err) {
    console.error('[notify] setThreadRoot failed:', err)
  }
}

/**
 * Low-level group send. Posts `text` (MarkdownV2 with plain-text fallback on
 * non-2xx) and RETURNS the Telegram message_id on success (or null). Optionally
 * replies to an existing message via reply_to_message_id (#1785 threading).
 */
async function sendToGroup(
  text: string,
  replyToMessageId?: string | null,
): Promise<string | null> {
  if (POST_DISABLED) return null
  // GROUP lifecycle posts speak as the board watcher bot (#1855). Fail-loud per
  // #2198: getWatcherToken() throws (visible error) if the token is absent,
  // rather than silently dropping the post the way the old `if (!token) return`
  // per-agent path did.
  const token = getWatcherToken()

  const basePayload: Record<string, unknown> = { chat_id: TELEGRAM_GROUP_ID, text }
  if (replyToMessageId) basePayload.reply_to_message_id = replyToMessageId

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...basePayload, parse_mode: 'MarkdownV2' }),
    })
    if (res.ok) {
      const json = (await res.json().catch(() => ({}))) as {
        result?: { message_id?: number | string }
      }
      const mid = json.result?.message_id
      return mid !== undefined ? String(mid) : null
    }
    const body = await res.text()
    console.error(`[notify] Telegram API error (${res.status}):`, body)
    // Retry without MarkdownV2 as fallback (unescape the MarkdownV2 backslashes)
    const res2 = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...basePayload,
        text: text.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1'),
      }),
    })
    if (res2.ok) {
      const json2 = (await res2.json().catch(() => ({}))) as {
        result?: { message_id?: number | string }
      }
      const mid2 = json2.result?.message_id
      return mid2 !== undefined ? String(mid2) : null
    }
    return null
  } catch (err) {
    console.error(`[notify] postToGroup failed:`, err)
    return null
  }
}

/**
 * Fire-and-forget group post (NO threading). Used for non-card posts (decisions,
 * watchdog alerts, debrief). Preserves the original postToGroup contract exactly
 * so existing call sites are unaffected.
 */
export async function postToGroup(text: string): Promise<void> {
  await sendToGroup(text)
}

/**
 * Threaded group post for a CARD (#1785). State-change events (create/claim/
 * complete/note) for a card collapse into one group thread:
 *   - opts.spine === true  → this post is the thread root; its message_id is
 *     stored as the card's spine.
 *   - otherwise            → reply_to the stored spine (if any). If no spine
 *     exists yet (e.g. first event seen was not a spine event), this post
 *     becomes the spine so later events can still thread to it.
 */
export async function postToGroupThreaded(
  text: string,
  taskId: number,
  opts: { spine?: boolean } = {},
): Promise<void> {
  if (POST_DISABLED) return
  const existingRoot = getThreadRoot(taskId)
  const replyTo = opts.spine ? null : existingRoot
  const mid = await sendToGroup(text, replyTo)
  if (!mid) return
  // Establish/refresh the spine root when this is a spine post, or when no root
  // existed yet (first-seen event becomes the anchor for future replies).
  if (opts.spine || !existingRoot) {
    setThreadRoot(taskId, mid)
  }
}

// ---------------------------------------------------------------------------
// Group-chat NUDGE digest / throttle (#1785)
//
// Nudges are the firehose: ~358/day to the group via formatNudge(). This is
// GROUP-CHAT noise control ONLY — it does NOT touch inter-agent nudge DELIVERY
// (dispatchAgentNudge still fires every time). We collapse rapid, repeated
// nudges to the SAME target into a single periodic roll-up:
//   - First nudge to a target in a window posts immediately.
//   - Further nudges to that target within THROTTLE_MS are counted, not posted.
//   - When the window elapses, the next nudge posts a roll-up with the collapsed
//     count ("+N more in the last Xs"), restarting the window.
// In-memory per-process state (each MCP server process throttles its own group
// posts); escalations are NOT routed here — callers pass urgent=true to bypass.
// ---------------------------------------------------------------------------

const NUDGE_GROUP_THROTTLE_MS = Number(
  process.env.THREADWORK_NUDGE_GROUP_THROTTLE_MS ?? 60_000,
)

interface NudgeWindow {
  windowStart: number
  collapsed: number
}
const _nudgeWindows = new Map<string, NudgeWindow>()

/**
 * Post a nudge to the group with digest throttling. Returns whether a message
 * was actually posted (false = collapsed into a pending roll-up). `urgent`
 * bypasses throttling entirely so escalations always surface immediately.
 */

/**
 * Pure throttle decision for a group nudge (no I/O, no POST_DISABLED guard) so
 * it is unit-testable. Mutates the per-target window state. Returns whether to
 * post and, if posting after a digest, how many prior nudges were collapsed.
 * `urgent` always posts (escalation bypass) and does not open/affect the window.
 */
export function nudgeThrottleDecision(
  to: string,
  urgent: boolean,
  now: number,
): { post: boolean; collapsed: number } {
  if (urgent) return { post: true, collapsed: 0 }
  const win = _nudgeWindows.get(to)
  if (!win || now - win.windowStart >= NUDGE_GROUP_THROTTLE_MS) {
    const collapsed = win?.collapsed ?? 0
    _nudgeWindows.set(to, { windowStart: now, collapsed: 0 })
    return { post: true, collapsed }
  }
  win.collapsed += 1
  return { post: false, collapsed: win.collapsed }
}

/** Test hook: clear all per-target nudge throttle windows. */
export function __resetNudgeWindows(): void {
  _nudgeWindows.clear()
}

export async function postNudgeToGroup(
  from: string,
  to: string,
  message: string,
  opts: { urgent?: boolean } = {},
): Promise<boolean> {
  if (POST_DISABLED) return false
  const decision = nudgeThrottleDecision(to, opts.urgent === true, Date.now())
  if (!decision.post) {
    // Within the throttle window: collapsed (count only, do not post).
    return false
  }
  // Post now. If a prior window collapsed nudges, surface the roll-up count.
  const suffix =
    decision.collapsed > 0
      ? `\n_\\+${decision.collapsed} more nudge${
          decision.collapsed === 1 ? '' : 's'
        } in the last ${Math.round(NUDGE_GROUP_THROTTLE_MS / 1000)}s_`
      : ''
  await sendToGroup(formatNudge(from, to, message) + suffix)
  return true
}
