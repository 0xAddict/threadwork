import type { Task } from './db'
import { TELEGRAM_GROUP_ID, getTelegramToken } from './config'

/** Escape special characters for Telegram MarkdownV2 */
function esc(text: string): string {
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

export async function postToGroup(text: string): Promise<void> {
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
