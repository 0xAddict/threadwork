#!/usr/bin/env bun
// watchdog.ts — Detect stuck agents and escalate
import { TaskDB, type Task } from './db'
import { AuditLog } from './audit'
import { nudgeAgent } from './nudge'
import { postToGroup } from './notify'
import { DB_PATH, AGENT_SESSIONS } from './config'

export function findStaleTasks(taskDb: TaskDB, minutesThreshold: number, audit?: AuditLog): Task[] {
  const db = (taskDb as any).db
  const stale = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'in_progress'
    AND claimed_at < datetime('now', '-' || ? || ' minutes')
  `).all(minutesThreshold) as Task[]

  if (!audit) return stale

  return stale.filter(task => {
    const activity = audit.getAgentActivity(task.to_agent, minutesThreshold)
    return activity.length === 0
  })
}

export function findUnclaimedTasks(taskDb: TaskDB, minutesThreshold: number): Task[] {
  const db = (taskDb as any).db
  return db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
    AND created_at < datetime('now', '-' || ? || ' minutes')
  `).all(minutesThreshold) as Task[]
}

export function determineAction(nudgeCount: number): 'first_nudge' | 'second_nudge' | 'escalate' {
  if (nudgeCount === 0) return 'first_nudge'
  if (nudgeCount === 1) return 'second_nudge'
  return 'escalate'
}

function incrementNudgeCount(taskDb: TaskDB, taskId: number): void {
  const db = (taskDb as any).db
  db.prepare('UPDATE tasks SET nudge_count = nudge_count + 1 WHERE id = ?').run(taskId)
}

async function checkDeadSessions(audit: AuditLog): Promise<void> {
  for (const [agent, session] of Object.entries(AGENT_SESSIONS)) {
    const proc = Bun.spawnSync(['tmux', 'has-session', '-t', session], { stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode !== 0) {
      audit.log('watchdog', 'session_dead', { agent, session })
      await postToGroup(`⚠️ ${agent} session (${session}) is dead.`)
    }
  }
}

const isMainScript = process.argv[1]?.endsWith('watchdog.ts')
if (isMainScript) {
  const taskDb = new TaskDB(DB_PATH)
  const audit = new AuditLog(taskDb)

  console.log(`[${new Date().toISOString()}] Watchdog running...`)

  const staleTasks = findStaleTasks(taskDb, 10, audit)
  for (const task of staleTasks) {
    const action = determineAction(task.nudge_count ?? 0)

    if (action === 'first_nudge') {
      const msg = `⏰ Task #${task.id} has been in progress for 10+ minutes with no activity. Status update? If blocked, use send_note to explain.`
      await nudgeAgent(task.to_agent, msg)
      incrementNudgeCount(taskDb, task.id)
      audit.log('watchdog', 'watchdog_nudge', { task_id: task.id, nudge_count: 1 }, task.id)
      console.log(`  Nudged ${task.to_agent} for task #${task.id} (first)`)

    } else if (action === 'second_nudge') {
      const msg = `⚠️ Task #${task.id} still stuck after 20+ minutes. Escalating to Boss in 10 minutes if no response.`
      await nudgeAgent(task.to_agent, msg)
      incrementNudgeCount(taskDb, task.id)
      audit.log('watchdog', 'watchdog_nudge', { task_id: task.id, nudge_count: 2 }, task.id)
      console.log(`  Nudged ${task.to_agent} for task #${task.id} (warning)`)

    } else {
      const escalationDesc = `ESCALATION: Task #${task.id} assigned to ${task.to_agent} stuck for 30+ minutes. Original: ${task.description}`
      taskDb.createTask({ from: 'watchdog', to: 'boss', description: escalationDesc, priority: 'urgent' })
      const db = (taskDb as any).db
      db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(task.id)
      audit.log('watchdog', 'watchdog_escalation', { task_id: task.id, agent: task.to_agent }, task.id)
      await nudgeAgent('boss', `🚨 Escalation: Task #${task.id} (${task.to_agent}) stuck 30+ min. New urgent task created for you.`)
      await postToGroup(`🚨 Escalation: Task #${task.id} (${task.to_agent}) auto-escalated to Boss after 30 minutes.`)
      console.log(`  Escalated task #${task.id} from ${task.to_agent} to Boss`)
    }
  }

  const unclaimed = findUnclaimedTasks(taskDb, 15)
  for (const task of unclaimed) {
    await nudgeAgent(task.to_agent, `📬 Reminder: Task #${task.id} is pending and assigned to you: ${task.description}`)
    audit.log('watchdog', 'watchdog_nudge', { task_id: task.id, reason: 'unclaimed 15+ min' }, task.id)
    console.log(`  Reminded ${task.to_agent} about unclaimed task #${task.id}`)
  }

  await checkDeadSessions(audit)

  taskDb.close()
  console.log(`  Done. Stale: ${staleTasks.length}, Unclaimed: ${unclaimed.length}`)
}
