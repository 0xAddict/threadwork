import type { Task } from './db'
import { TELEGRAM_GROUP_ID, getTelegramToken } from './config'

export function formatTaskCreated(task: Task): string {
  return `📋 Task #${task.id} assigned\nFrom: ${task.from_agent} → To: ${task.to_agent}\nPriority: ${task.priority}\n${task.description}`
}

export function formatTaskClaimed(task: Task): string {
  return `🔨 Task #${task.id} claimed by ${task.to_agent}\n${task.description}`
}

export function formatTaskCompleted(task: Task): string {
  return `✅ Task #${task.id} completed by ${task.to_agent}\n${task.description}\nResult: ${task.result}`
}

export function formatNote(taskId: number, from: string, message: string): string {
  return `💬 Note on task #${taskId} from ${from}:\n${message}`
}

export async function postToGroup(text: string): Promise<void> {
  const token = getTelegramToken()
  if (!token) return

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_GROUP_ID,
        text,
      }),
    })
  } catch {
    // Silently fail — notification is best-effort
  }
}
