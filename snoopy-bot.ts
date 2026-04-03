/**
 * snoopy-bot.ts — DEPRECATED standalone bot
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
 */
