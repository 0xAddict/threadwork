# Threadwork Ecosystem Inventory

**Date:** 2026-04-10
**Task:** #272 (sadie)
**Purpose:** Component inventory feeding the Nano Banana 2 infrastructure diagram prompt.

## 1. Orchestration Layer

| Component | Path / ID | Role |
|---|---|---|
| tmux session `claude-boss` | running | CEO/orchestrator, only agent who creates top-level tasks |
| tmux session `claude-steve` | running | Worker |
| tmux session `claude-sadie` | running | Worker (this agent) |
| tmux session `claude-kiera` | running | Worker |
| tmux session `claude-snoopy` | running | Human-facing bot session |
| tmux session `claude-watchdog` | running | Dedicated watchdog shell |
| tmux session `kairos` | running | Separate orchestrator/daemon shell |
| `{agent}-runner` sub-agent | spawned per-session | Haiku, simple/bounded tasks |
| `{agent}-agent` sub-agent | spawned per-session | Sonnet, complex multi-step tasks |
| `telegram-pool.sh` | `~/threadwork/scripts/telegram-pool.sh` | Assigns a free Telegram bot token to each launching session, lockfile per agent |
| `launch-all.sh` | `~/threadwork/scripts/launch-all.sh` | Ensures all sessions are alive, auto-accepts trust prompt, injects boot briefing |
| per-agent conf | `~/.claude/bots/{boss,steve,sadie,kiera,snoopy}.conf` | Bot tokens + per-bot MCP config |

## 2. Task Board MCP (`~/.claude/mcp-servers/task-board/`)

**Runtime:** `bun run server.ts` (~70K LOC). Config at `~/.claude/mcp-servers/task-board/mcp.json`.

### 2.1 Live database (`tasks.db`)

24 tables currently populated:

| Table | Rows | Purpose |
|---|---|---|
| `tasks` | 272 | Core task rows — has triggers `trg_require_supervision` + `trg_prevent_supervision_removal` |
| `audit_log` | 12,882 | Every action logged |
| `memories` | 413 | Per-agent semantic memory |
| `notes` | 333 | Task note stream → Telegram group |
| `progress_events` | 313 | Heartbeat history |
| `task_status_events` | 84 | write_status entries |
| `gate_violations` | 73 | Spec-gate / enforce-delegation violations |
| `decision_positions` | 45 | Multi-agent decision arguments |
| `decisions` | 23 | Formal decision rows |
| `debrief_runs` | 14 | Debrief history |
| `consolidation_runs` | 9 | Memory consolidation history |
| `memory_archive` | 6 | Decayed memories |
| `agent_sessions` | 5 | Live session registrations |
| `tw_nudge_debounce` | 5 | Rate-limiter for nudge_agent |
| `findings` | 4 | Structured research outputs |
| `feature_flags` | 3 | Runtime flags (e.g. `THREADWORK_DEBOUNCE_ENABLED`) |
| `artifacts` | 3 | File content linked to tasks |
| `decision_critiques` | 2 | Peer critique of positions |
| `managed_bots` | 1 | BotFather-managed bot registry |
| `watchdog_lease` | 1 | Singleton lock for watchdog loop |
| `v_nudge_metrics_24h`, `v_nudge_metrics_24h_total` | views | Observability |
| `consolidation_locks`, `debrief_locks` | 0 | Advisory locks |

### 2.2 MCP tool surface (60+)

- **Tasks:** create_task, delegate_task, claim_task, complete_task, list_tasks, get_children, get_progress
- **Status:** write_status, read_status, clear_status, report_progress
- **Memory:** save_memory, recall_memories, pin_memory, promote_memory, challenge_memory, supersede_memory, consolidate_memories, get_memory_health_report
- **Sub-agents:** spawn_subagent, close_subagent
- **Decisions:** open_decision, submit_position, critique_position, list_decisions, get_decision_brief, finalize_decision
- **Findings/artifacts:** write_finding, read_findings, read_finding_raw, write_artifact
- **Supervision:** get_boot_briefing, force_debrief, run_hygiene, get_violations, get_db_stats, query_audit_log
- **Comms:** send_note, nudge_agent, interrupt_agent

## 3. Enforcement Layer (hooks + spec-gate)

| Hook | Type | Path | Purpose |
|---|---|---|---|
| `enforce-delegation.sh` | PreToolUse | `~/.claude/hooks/` | Blocks Level-2 workers from direct tool use when `agent_id` is absent (main thread) |
| `thinking-to-telegram.py` | SubagentStop | `~/.claude/hooks/` | Forwards sub-agent thinking blocks to Snoopy's DM (chat_id 1712539766) |
| `session-boot.sh` | SessionStart | `~/.claude/hooks/` | Loads role + memory on agent boot |
| `activate-lessons.sh` | (session) | `~/.claude/hooks/` | Activates learned-lessons pins |
| `telegram-typing-start.sh` | UserPromptSubmit | `~/threadwork/scripts/` | Shows typing indicator while agent thinks |
| `telegram-typing-stop.sh` | PostToolUse(telegram.reply) | `~/threadwork/scripts/` | Clears typing indicator after reply |
| `agent-levels.json` | config | `~/.claude/hooks/` | Maps agent name → enforcement level (0=snoopy/free, 1=boss/log, 2=worker/block) |
| `spec_gate.sh` | (v1, not yet hooked) | `~/threadwork/scripts/` | 5-subcommand hard gate (contract-sign/verify, lane-scope, lane-verify, sprint-close) — wired into PreToolUse on complete_task per task #264 design |

## 4. Supervision / Watchdog Layer

| Component | Path / schedule | Role |
|---|---|---|
| `watchdog.ts` | `~/threadwork/watchdog.ts` (41K) | Persistent singleton loop, holds `watchdog_lease` row, reconciles due tasks, checks session liveness, idempotent escalation |
| `com.threadwork.watchdog.plist` | launchd, StartInterval 120s | Supervises the watchdog process |
| `com.threadwork.agents.plist` | launchd, StartInterval 300s + RunAtLoad | Runs `launch-all.sh` to resurrect dead tmux sessions |
| `com.threadwork.heartbeat.plist` | launchd, RunAtLoad | System heartbeat publisher |
| per-agent `/loop 2m` monitor | live in each agent session | Reads `read_status`, escalates after 3 idle checks via nudge_agent → interrupt_agent (tmux send-keys C-c) |
| `consolidator.ts` / `consolidate.ts` | `~/threadwork/` (16K + 4K) | Background memory consolidation |
| `debrief.ts` | `~/threadwork/` (24K) | Periodic team debrief runs |
| `decision.ts` | `~/threadwork/` (12K) | Decision-framework loop (open → positions → critique → finalize) |
| `notify.ts` / `nudge.ts` | `~/threadwork/` | Group posting + nudge delivery |
| `audit.ts` | `~/threadwork/` | Audit-log writer |
| `managed-bots.ts` | `~/threadwork/` | BotFather-managed bot pool |

## 5. Harness Layer (for long-running app builds)

| Component | Path | Role |
|---|---|---|
| `/harness` skill | `~/.claude/skills/harness/SKILL.md` | Launches Generator + Verifier with sprint contracts |
| `harness-generator` agent | `~/.claude/agents/harness/generator.md` | Opus builder, writes contracts + implements |
| `harness-verifier` agent | `~/.claude/agents/harness/verifier.md` | Sonnet grader, Func>=9 rubric |
| `.harness/` dir | per-project | `roadmap.md`, `decision-log.md`, `sprints/sprint-N/{proposed-contract.md, approved-contract.md, implementation-log.md, verifier-report.md, status.txt, evidence/}` |
| v2 (task #264) | `~/threadwork/sprints/2026-04-10-explorer-planner-executor-verifier-architecture.md` | Proposed parallelized Explorer → Planner → N×Executor → N×Verifier upgrade with spec_gate.sh |

## 6. Messaging Layer

| Component | Role |
|---|---|
| Telegram plugin (`mcp__plugin_telegram_telegram__*`) | reply, edit_message, react, download_attachment — direct user/group messaging |
| Team Telegram group | Auto-posts on create_task / complete_task / send_note |
| User DM (chat_id 1712539766) | Thinking blocks, phase updates, image deliveries |
| `snoopy-bot.ts` | Legacy snoopy-side bot logic |
| `notify.ts` | `postToGroup()` helper used by watchdog + decisions |

## 7. External MCP Integrations (14+ namespaces)

| Namespace | Purpose |
|---|---|
| `mcp__claude_ai_Supabase__*` | Full admin — SQL, migrations, edge functions, branches, storage |
| `mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Two8_Gmail__*`, `mcp__coachstokes-mcp__gmail_*` | Three Gmail surfaces (personal, two8, coachstokes) |
| `mcp__claude_ai_Google_Calendar__*`, `mcp__coachstokes-mcp__calendar_*` | Google Calendar read/write |
| `mcp__claude_ai_Resend_Cloud_MCP__*` | Transactional email (Resend) |
| `mcp__claude_ai_Friecrawl_Stokes__*` | Firecrawl web scraping |
| `mcp__claude_ai_Veeqo_MCP__*` | Veeqo inventory |
| `mcp__gymbandz-shopify-mcp__*` | Shopify store ops |
| `mcp__netlify__*` | Deploy/project/extension/team services |
| `mcp__fast-playwright__*` | Playwright automation |
| `mcp__plugin_chrome-devtools-mcp_chrome-devtools__*` | Chrome DevTools Protocol |
| `mcp__claude-in-chrome__*` | Claude-in-Chrome extension bridge |
| `mcp__macos-automator__*`, `mcp__macos-control__*` | AppleScript + UI automation + screen OCR |
| `mcp__nano-banana-mcp__*` | Gemini image gen (NB2 Flash) — **this task's output path** |
| `mcp__plugin_context7_context7__*` | Live library docs |
| `mcp__plugin_mintlify_Mintlify__*` | Docs search |
| `mcp__shadcn__*` | shadcn/ui blocks + components |
| `mcp__plugin_sentry_sentry__*` | Sentry error tracking |
| `mcp__plugin_supabase_supabase__*` | Secondary Supabase plugin surface |
| `/Users/coachstokes/.volta/bin/codex` | OpenAI Codex CLI (ChatGPT auth) |
| `/Users/coachstokes/bin/llm-council.py` | LLM Council (OpenRouter, 4 models — currently blocked on missing API key) |

## 8. Skills Layer (`~/.claude/skills/`)

harness, council, spec-gate, task-delegation, watchdog-monitor, structured-image-gen, timer, voice-transcribe, elevenlabs-tts, plus plugin skills from: `claude-plugins-official` (netlify, arsenal, superpowers, research, alpha/alpha-verify, cleanup), `openai-codex` (codex-cli-runtime, codex-result-handling), `the-arsenal`.

## 9. Subsystem Groupings (for the diagram)

1. **USER LAYER** — Human via Telegram DM (Snoopy) + team group
2. **AGENT LAYER** — 7 tmux sessions, each with runner + sub-agent
3. **CONTROL PLANE** — Task Board MCP (SQLite 24 tables, 60+ tools, triggers, views)
4. **ENFORCEMENT PLANE** — 5 hooks + agent-levels.json + spec_gate.sh + DB triggers
5. **SUPERVISION PLANE** — watchdog.ts + 3 launchd agents + per-agent monitor loops + consolidator + debrief + decision loops
6. **HARNESS PLANE** — Generator/Verifier + sprint contracts + .harness/ dirs
7. **MESSAGING PLANE** — Telegram bridge + notify.ts + snoopy-bot + typing indicators
8. **INTEGRATION PLANE** — 14+ external MCP namespaces + Codex CLI + LLM Council

Data flows:
- Agent → Task Board (MCP tool calls) → SQLite writes + audit_log + Telegram group post
- Watchdog (launchd cron) → watchdog_lease → SQLite read → nudge_agent → tmux send-keys → agent session
- Agent sub-agent → thinking-to-telegram hook → Snoopy DM
- Agent → enforce-delegation hook → block or allow → MCP tool call
- Harness sprint → spec_gate.sh → PreToolUse hook on complete_task → decision:block JSON
- Memory consolidator → memories table → memory_archive (decay) → boot briefing load
