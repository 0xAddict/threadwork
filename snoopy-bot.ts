/**
 * snoopy-bot.ts — Consolidation daemon integration
 *
 * Snoopy is now integrated into the standard agent launch system.
 * He boots via launch-all.sh / telegram-pool.sh like all other agents.
 *
 * Config: ~/.claude/bots/snoopy.conf
 * Session: claude-snoopy (tmux)
 * Pool entry: ~/.claude/telegram-pool.sh (BOTS array)
 *
 * The standalone Telegram polling + Claude API loop that was here
 * has been removed — Snoopy now uses the same Claude Code + Telegram
 * channel plugin architecture as Boss, Steve, Sadie, and Kiera.
 *
 * Removed: 2026-04-03
 *
 * Added: 2026-04-05 — AutoDream consolidation daemon trigger loop
 */

import { TaskDB } from './db'
import { MemoryDB } from './memory'
import { MemoryConsolidator } from './consolidator'
import { DB_PATH, CONSOLIDATION_DRY_RUN, CONSOLIDATION_CHECK_INTERVAL_MS, TELEGRAM_GROUP_ID, getTelegramToken } from './config'

const taskDb = new TaskDB(DB_PATH)
const mem = new MemoryDB(taskDb)
const consolidator = new MemoryConsolidator(mem, taskDb, CONSOLIDATION_DRY_RUN)

async function postToTelegram(text: string): Promise<void> {
  const token = getTelegramToken()
  if (!token) return
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_GROUP_ID, text }),
    })
  } catch { /* best effort */ }
}

async function checkAndRun(): Promise<void> {
  const triggers = consolidator.checkTriggers()
  const reasons: string[] = []
  if (triggers.time) reasons.push('time')
  if (triggers.volume) reasons.push('volume')
  if (triggers.idle) reasons.push('idle')

  if (reasons.length === 0 || !triggers.lock) return

  const triggerReason = `auto: ${reasons.join('+')}`
  console.log(`[consolidator] Triggered: ${triggerReason}`)

  const result = await consolidator.run(triggerReason)
  console.log(`[consolidator] ${result.summary}`)

  if (result.mutations > 5 || !CONSOLIDATION_DRY_RUN) {
    await postToTelegram(`[Consolidator] ${result.summary}`)
  }
}

// Start the trigger check loop
setInterval(checkAndRun, CONSOLIDATION_CHECK_INTERVAL_MS)
console.log(`[consolidator] Daemon started (dry_run=${CONSOLIDATION_DRY_RUN}, interval=${CONSOLIDATION_CHECK_INTERVAL_MS / 1000}s)`)
