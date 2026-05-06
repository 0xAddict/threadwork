import type { Task } from './db'
import { TELEGRAM_GROUP_ID, getTelegramToken } from './config'

/** Escape special characters for Telegram MarkdownV2 */
export function esc(text: string | null | undefined): string {
  if (text == null) return ''
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

export function formatTaskCreated(task: Task): string {
  return `📋 *Task \\#${task.id} assigned*\nFrom: ${esc(task.from_agent)} → To: ${esc(task.to_agent)}\nPriority: ${esc(task.priority)}\n${esc(task.description)}`
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

export async function postToGroup(text: string): Promise<void> {
  if (POST_DISABLED) return
  const token = getTelegramToken()
  if (!token) return

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_GROUP_ID,
        text,
        parse_mode: 'MarkdownV2',
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      console.error(`[notify] Telegram API error (${res.status}):`, body)
      // Retry without MarkdownV2 as fallback
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_GROUP_ID,
          text: text.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1'),
        }),
      })
    }
  } catch (err) {
    console.error(`[notify] postToGroup failed:`, err)
  }
}
