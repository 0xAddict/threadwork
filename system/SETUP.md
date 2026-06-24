# Threadwork System — Full Setup / Reconstruction Guide

**Audience:** an agent (or human) who has cloned `github.com/0xAddict/threadwork`
and needs to stand up the *whole* threadwork system on a fresh macOS machine —
not just the task-board MCP, but the launchd daemons, hooks, skills, secrets, and
the dashboard.

This guide **supersedes and extends** the one-pager at
`~/threadwork-restore-procedure.md`. That file is the quick "what's backed up /
what's not" reference; this file is the step-by-step rebuild.

> **Scope note (Gwei, TG 7096):** this backup captures the **structure of the
> build** plus written setup instructions — *not* table row data. A fresh
> `tasks.db` is created from `system/schema.sql`; historical task rows are **not**
> restored.

---

## 0. What's in this repo (the backup)

| Path | What it is |
|------|------------|
| repo root (`server.ts`, `db.ts`, `notify.ts`, `nudge.ts`, `watchdog.ts`, `config.ts`, `migrations/`, `tests/`, `package.json`, `bun.lock`) | the **task-board MCP server** (runtime + tasks board + memory + decisions) |
| `bin/` | task-board's own daemons (`heartbeat-daemon.sh`, `heartbeat-daemon-v2.sh`, `inhibit-cli`, etc.) — the live `~/bin/heartbeat-daemon-v2.sh` is a symlink into here |
| `scripts/` | `install.sh` (symlinks repo → `~/.claude`), `launch-all.sh` (boots the tmux agent sessions), `telegram-pool.sh`, migration runners |
| `hooks/` | the live `~/.claude/hooks` files (PreToolUse / SessionStart / SubagentStop hooks: context-budget-watch, session-boot, subagent-heartbeat, subagent-stall-watcher, etc.) |
| `skills/` | the live `~/.claude/skills` (task-delegation, recycle, harness, etc.) |
| `config/` | `settings.json` (Claude Code settings, no secrets), `.env.example`, `access.json.example` |
| `templates/` | install-time templates (`access.json.example`, `com.threadwork.agents.plist`) |
| `bots/` | bot `.conf` files |
| `CLAUDE.md` (repo root) | the **agent operating manual** (delegation-first architecture, recycle SOP, watchdog infra) — deploy to `~/.claude/CLAUDE.md` |
| **`system/launchd/`** | **all `com.threadwork.*` launchd plists** (22 files: 21 active + 1 `.disabled`). Secrets/UUID/chat-IDs scrubbed to `REPLACE_WITH_*` placeholders. |
| **`system/bin/`** | **the `~/bin` threadwork daemon scripts** (20 `.sh`) not already in repo `bin/`. Hardcoded tokens/keys scrubbed. |
| **`system/schema.sql`** | `tasks.db` **schema only** (CREATE statements, no rows) |
| **`system/mcp-config.example.json`** | scrubbed example of the task-board MCP registration |
| **`system/SETUP.md`** | this file |

---

## 1. Prerequisites

- macOS (the launchd plists target `~/Library/LaunchAgents`).
- [`bun`](https://bun.sh) at `~/.bun/bin/bun` (the MCP server + watchdog run under bun).
- `node` (some MCPs / dashboard tooling).
- `sqlite3` CLI (ships with macOS).
- `tmux` (agent sessions run in tmux panes named `claude-boss`, `claude-steve`, `claude-sadie`, `claude-kiera`, `claude-snoopy`).
- `git`, and the Claude Code CLI installed and logged in.
- A password manager / secure store holding the secrets listed in §6.

---

## 2. Clone + place the repo

```bash
git clone https://github.com/0xAddict/threadwork.git
# The repo IS the task-board MCP. Place it at the canonical path:
mkdir -p ~/.claude/mcp-servers
rsync -a --exclude .git threadwork/ ~/.claude/mcp-servers/task-board/
cd ~/.claude/mcp-servers/task-board
```

(Or clone directly into `~/.claude/mcp-servers/task-board`.)

---

## 3. Install the task-board MCP server

```bash
cd ~/.claude/mcp-servers/task-board
bun install --frozen-lockfile   # or: npm ci   (package-lock.json is present)
```

This installs `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk`.

---

## 4. Register the MCP with Claude Code

Two equivalent options:

**A. Let the installer do it (recommended).** `scripts/install.sh` symlinks the
repo files into `~/.claude`, generates a resolved `mcp.json`, runs `bun install`,
wires the hooks, and copies the bot/access templates:

```bash
cd ~/.claude/mcp-servers/task-board
./scripts/install.sh
```

**B. Manual.** Merge the `task-board` block from
`system/mcp-config.example.json` into the top-level `mcpServers` map in
`~/.claude.json` (replace `${HOME}` with your real absolute home path — Claude
Code does **not** expand env vars there):

```json
"task-board": {
  "type": "stdio",
  "command": "/Users/<you>/.bun/bin/bun",
  "args": ["run", "/Users/<you>/.claude/mcp-servers/task-board/server.ts"],
  "env": {}
}
```

The task-board server needs **no secrets in its registration** (`env: {}`); it
reads what it needs from the DB and from `notify.ts` config at runtime.

Restart Claude Code (or run `/mcp` and reconnect). You should see
`task-board ✔ connected` with ~40 tools. (See the `mcp-restart-ceremony` skill.)

---

## 5. Initialise a fresh database

Task **row data is not restored** — create an empty DB from the schema:

```bash
cd ~/.claude/mcp-servers/task-board
sqlite3 tasks.db < system/schema.sql
# verify:
sqlite3 tasks.db '.tables'
```

If `migrations/` contains migrations newer than the captured schema, apply them:

```bash
bun run scripts/run-migration.ts    # (idempotent; check the script's flags)
```

The server also seeds agent roles on first run — confirm with `seed-roles.ts`
if roles are missing.

---

## 6. Recreate secrets (NOT in git — restore from the password manager)

All of these are `.gitignore`d by design. Recreate each file by hand. **Modes
should be `600`.**

| File | Keys | Used by |
|------|------|---------|
| `~/.threadwork/secrets.env` | `TELEGRAM_TOKEN`, `SUPABASE_SERVICE_KEY` (both `export`ed) | sourced by `com.threadwork.heartbeat-v2` and `com.threadwork.alert-review-soak` plists |
| `~/.claude/.env` | `GEMINI_API_KEY` | hooks / classifiers (e.g. context budget, pane classifier) |
| `~/.claude/mcp-servers/task-board/.env` | `ELEVENLABS_API_KEY` | TTS replies (`tts-reply.sh`, elevenlabs-tts skill) |
| `~/threadwork-dashboard/.env` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (high-sev) | dashboard + board-sync daemon (`SYNC_DAEMON_ENV_FILE`) |
| `~/.secrets/watcher-bot-token` | single Telegram bot token value | board-watcher / board-sync alert plists (`WATCHER_BOT_TOKEN_FILE`) |
| `~/.claude/state/apify-token.txt` | Apify API token | enrichment (n8n / IG) |
| `~/.claude/state/apollo-api-key.txt` | Apollo API key | LinkedIn/professional enrichment |
| `~/.claude/channels/telegram/access.json` | channel allowlist (chat IDs, pairing) | Telegram access control — start from `config/access.json.example` or `templates/access.json.example` |

**Scrubbed in-script placeholders to fix after you restore secrets.** The
`system/bin/` scripts had hardcoded tokens removed and replaced with
`${ENVVAR:-REPLACE_WITH_*}` fallbacks. Either (a) set the matching env var
before the daemon runs (preferred — e.g. source `~/.threadwork/secrets.env`, or
add to the plist's `EnvironmentVariables`), or (b) edit the placeholder in the
script. Affected vars:

- `heartbeat-daemon.sh` → `TELEGRAM_TOKEN`, `SUPABASE_SERVICE_KEY`
- `kairos-monitor.sh` → `KAIROS_TELEGRAM_BOT_TOKEN` (dedicated Kairos bot), `SUPABASE_SERVICE_KEY`
- `memory-promotion-poller.sh`, `memory-promotion-nightly.sh`, `stokes-daily-tracker-query.sh` → `TG_TOKEN`

**Scrubbed deployment identifiers** (set per-deployment): `REPLACE_WITH_TELEGRAM_CHAT_ID`
(was the operator's Telegram chat ID) appears in several scripts and plists;
`REPLACE_WITH_INSTALL_UUID` appears in `com.threadwork.bootstrap.plist` and
`com.threadwork.kairos-pool.plist` (generate a fresh UUID with `uuidgen`).

> **Known caveat (carried from restore-procedure.md):** two *pre-existing*
> Telegram bot tokens live in git **history** (`managed-bots.ts`,
> `docs/2026-04-01-agent-memory-plan.md`). They predate this backup; rotation is
> queued as a separate task. A fresh deploy should rotate those bots.

---

## 7. Place the agent config + operating manual

```bash
cd ~/.claude/mcp-servers/task-board
cp config/settings.json   ~/.claude/settings.json     # Claude Code settings (hooks wiring lives here)
cp CLAUDE.md              ~/.claude/CLAUDE.md          # the agent operating manual
# skills + hooks are symlinked by scripts/install.sh; if doing it manually:
ln -sfn "$PWD/skills"  ~/.claude/skills    # or copy
# hooks: install.sh symlinks each hooks/*.sh|*.py|*.json|*.txt into ~/.claude/hooks
```

`~/.claude/settings.json` is what tells Claude Code to fire the hooks (PreToolUse,
SessionStart, SubagentStop). After placing it, restart the session or run
`/hooks` so the harness picks them up.

---

## 8. Place the `~/bin` daemons

```bash
cd ~/.claude/mcp-servers/task-board
mkdir -p ~/bin
cp system/bin/*.sh ~/bin/
chmod +x ~/bin/*.sh

# heartbeat-daemon-v2 is canonical in the repo's bin/; keep the live symlink:
ln -sfn "$PWD/bin/heartbeat-daemon-v2.sh" ~/bin/heartbeat-daemon-v2.sh
```

(Several of these read tokens from env / sourced secrets — see §6.)

---

## 9. Install the launchd jobs

The plists in `system/launchd/` were captured **with absolute `/Users/coachstokes`
paths**. On a different machine/user you MUST rewrite those paths first.

```bash
cd ~/.claude/mcp-servers/task-board/system/launchd
DEST=~/Library/LaunchAgents
mkdir -p "$DEST"

for f in com.threadwork.*.plist; do
  # rewrite the captured home path to the current user's home, then install
  sed "s#/Users/coachstokes#$HOME#g" "$f" > "$DEST/$f"
done

# Then fill in the scrubbed placeholders that live INSIDE plist EnvironmentVariables:
#   REPLACE_WITH_TELEGRAM_CHAT_ID  → your operator chat ID
#   REPLACE_WITH_INSTALL_UUID      → uuidgen
# Edit the installed copies in ~/Library/LaunchAgents before loading.

# Load each job:
for f in "$DEST"/com.threadwork.*.plist; do
  launchctl load "$f"
done
```

Notes:
- `com.threadwork.stokes-reply-watcher.plist.disabled-*` is **intentionally
  disabled** — rename to drop the `.disabled-*` suffix only if you want it active.
- Some plists reference the **dashboard** repo
  (`~/threadwork-dashboard/...`: `board-sync*`, `board-watcher*`) — install the
  dashboard (§11) before loading those, or they'll fail.
- Some reference `~/.threadwork/bin/update-check.sh` and `~/.claude/kairos-pool.sh`
  — those scripts live outside this repo's `system/bin/`; ensure they exist
  (kairos-pool is created by the broader install; `update-check` is part of the
  `~/.threadwork` bootstrap set).
- `com.threadwork.agents.plist` (the main 4-agent launcher) is generated by
  `scripts/install.sh` from `templates/com.threadwork.agents.plist`, **not** from
  `system/launchd/` — it was excluded here because only a `.bak` of it existed
  live. Use the installer for that one.

To verify a job loaded: `launchctl list | grep com.threadwork`.

---

## 10. Boot the agent tmux sessions

```bash
~/.claude/launch-all.sh     # (symlinked from scripts/launch-all.sh by install.sh)
```

This creates the `claude-boss / steve / sadie / kiera / snoopy` tmux sessions,
sources `telegram-pool.sh`, auto-accepts the workspace-trust prompt, and loads
each agent's boot briefing. On a fresh machine the first launch will hit the
Claude Code trust prompt — `launch-all.sh` handles it with a timed key-send.

---

## 11. Dashboard (separate repo)

The dashboard is its own repo with its own Supabase project:

```bash
git clone https://github.com/Coachstokes/threadwork-dashboard.git ~/threadwork-dashboard
cd ~/threadwork-dashboard
npm install
# restore ~/threadwork-dashboard/.env (see §6): VITE_SUPABASE_URL,
# VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY  (+ .env.test.local if present)
```

The `board-sync` / `board-watcher` launchd jobs (installed in §9) drive the
sync-daemon under `~/threadwork-dashboard/sync-daemon/` and
`~/threadwork-dashboard/board-watcher/`. They read
`SYNC_DAEMON_ENV_FILE=~/threadwork-dashboard/.env` and
`WATCHER_BOT_TOKEN_FILE=~/.secrets/watcher-bot-token`.

---

## 12. Verify the rebuild

- [ ] `bun test` passes in the task-board repo (or at least the server boots: `bun server.ts`).
- [ ] `/mcp` shows `task-board ✔ connected` (~40 tools).
- [ ] `sqlite3 tasks.db '.tables'` lists the expected tables.
- [ ] `launchctl list | grep com.threadwork` shows the loaded jobs (no exit-code errors).
- [ ] `tmux ls` shows the 5 agent sessions.
- [ ] A test `nudge_agent` / `create_task` round-trips and posts to the team Telegram group.
- [ ] Heartbeat daemons are writing to their DBs/logs (after secrets are in place).
- [ ] Dashboard loads and the board-sync heartbeat is fresh.

---

## 13. Ongoing backup discipline (recommendation)

Per `~/threadwork-restore-procedure.md`: run a **source-only** periodic
`git add <explicit paths> && commit && push`. Do **not** auto-commit runtime
churn (`tasks.db*`, `.harness/sprints/*/status.txt`, `briefings/*.json`,
`artifacts/`, `*.log`, `recovery/`) — those are gitignored to keep the repo
clean. When the launchd/bin/hook structure changes, re-capture the relevant
`system/` files (re-scrub secrets first).
