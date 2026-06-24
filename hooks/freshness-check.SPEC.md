# freshness-check.sh — SPEC

Engineering reference for the PreToolUse freshness gate that guards
task-board claim/delegate/complete/send_note operations against stale-context
drift in long-running threadwork sessions.

## 1. Purpose

Threadwork agents (boss, steve, sadie, kiera) accumulate context rot the
longer a task sits idle: notes drift, decisions get reversed elsewhere, and
work may already be done. `freshness-check.sh` is a PreToolUse hook that
intercepts task-board mutations and forces the agent to acknowledge staleness
(by posting a `FRESHNESS:` verdict note) before continuing, or hard-blocks
once a task is very old. The hook is fail-open — any internal error, missing
DB, unknown mode, or kill-switch returns exit 0 so it can never deadlock
Claude Code.

## 2. Status

| Field | Value |
|---|---|
| Current version | post-#1074 (F1+F2+F3 patches applied 2026-05-09) |
| File | `~/.claude/hooks/freshness-check.sh` (703 lines, 26,435 bytes) |
| Ship date | 2026-05-09 (verifier 95/100) |
| Rollout scope | Phase A canary — `sadie`, `boss` only (allowlist `agents.enabled`) |
| Kill-switch | `FRESHNESS_HOOK_DISABLED=1` (env) — logs to `disabled.log` |
| Per-call bypass | `FRESHNESS_BYPASS=1` (env) — logs to `bypass.log` |
| Force-enable | `FRESHNESS_HOOK_ENABLED=1` (env) — overrides allowlist gate |

## 3. Trigger surface

Registered in `~/.claude/settings.json` under `PreToolUse` (lines 474-519, five
distinct matcher blocks):

```
mcp__task-board__claim_task     -> freshness-check.sh preclaim
mcp__task-board__claim_task     -> freshness-check.sh prerevisit
mcp__task-board__delegate_task  -> freshness-check.sh prerevisit
mcp__task-board__complete_task  -> freshness-check.sh prerevisit
mcp__task-board__send_note      -> freshness-check.sh prerevisit
```

`claim_task` fires both hooks (preclaim then prerevisit). Any other tool call
exits 0 immediately via the `TOOL_NAME` guard in each mode branch.

## 4. Behavior model — the 4-zone ladder

Applies to **prerevisit mode**. Age is computed in minutes from the most
recent activity timestamp (`COALESCE(last_progress_at, last_heartbeat_at,
claimed_at, created_at)`, hook line 588-591). Thresholds default to 5 / 30 /
120 minutes (see §7 for env-var overrides).

| Zone | Trigger | Action | Exit | Bypass |
|---|---|---|---|---|
| **0 grace** | `age < GRACE_MIN` (default 5) | ALLOW silently, audit `fresh-grace` | 0 | n/a |
| **1 keyword** | `GRACE_MIN ≤ age < KEYWORD_MIN` (default <30) | Scan last 5 notes for structural-change keywords; ALLOW if clean, BLOCK with full inject if any match | 0 / 2 | post FRESHNESS note (raises to Zone 2 logic on retry) or `FRESHNESS_BYPASS=1` |
| **2 standard** | `KEYWORD_MIN ≤ age < HARDBLOCK_HR*60` (default 30-120m) | Require a `FRESHNESS:` note from the same agent in last 5 min, else BLOCK with full inject | 0 / 2 | post FRESHNESS note, then retry within 5 min |
| **3 hardblock** | `age ≥ HARDBLOCK_HR*60` (default ≥120m / 2h) | HARD BLOCK with full inject regardless of FRESHNESS note | 2 | only `FRESHNESS_BYPASS=1` or address the staleness |

Zone 3 is evaluated **before** Zone 2 (line 668) so a fresh FRESHNESS note
cannot bypass a 2h+ task. Verified empirically: 3h task with 1-min-old
FRESHNESS note still returns exit 2.

### Zone 1 keyword list (hook line 429, verbatim)

```
[[:<:]](REVERSED|DECISION|BLOCKED|ESCALAT[A-Z]*|OVERRIDDEN|FURY|CORRECTION)[[:>:]]
```

BSD word-boundary anchors `[[:<:]]` / `[[:>:]]` prevent substring matches
(e.g. "decisional", "blocker", "indecisive" do **not** trigger). `ESCALAT[A-Z]*`
intentionally preserves prefix matching for ESCALATE/ESCALATED/ESCALATION/
ESCALATING/ESCALATOR (F1 spec author's call — brainstorm §4.1). Scan window
is `ORDER BY id DESC LIMIT 5` notes. Case-insensitive via `grep -Eoi`.

### `FRESHNESS:` note shape recognised in Zone 2 (line 402)

```
^FRESHNESS:\s*(STILL-FRESH|STALE|SUPERSEDED)\s+\S
```

Must include a non-whitespace reasoning token. Counts only notes posted by
the same `AGENT_LABEL` within the last 5 minutes. Result cached for 10s in
`$STATE_DIR/task-${TASK_ID}-${AGENT}.cache`.

## 5. Modes — preclaim vs prerevisit

| Aspect | preclaim | prerevisit |
|---|---|---|
| Tool matchers | `claim_task` only | `claim_task`, `delegate_task`, `complete_task`, `send_note` |
| Age unit | hours, from `created_at` | minutes, from last-activity (see §4) |
| Threshold | `FRESHNESS_HOURS_COLD` (default 24h) | 4-zone ladder (see §4) |
| Status skip | `status != 'pending'` → ALLOW (DB rejects non-pending claims anyway) | `status IN ('completed','cancelled')` → ALLOW |
| Bypass on block | FRESHNESS note in last 5 min (single check, no zones) | depends on zone (see §4) |
| Inject payload | Simpler — last 3 notes + threshold message | Full rich inject via `emit_stale_context` (notes, status, related tasks, pinned memories) |

Both modes share `run_common_checks` (line 321) for kill-switch / allowlist /
task-id validation / agent-label validation / per-call BYPASS / DB-missing
guards.

## 6. Skip rules (fail-open, exit 0)

In order of precedence:

1. **Global kill-switch** — `FRESHNESS_HOOK_DISABLED=1` (line 326). Logged to
   `~/.claude/state/freshness-hook/disabled.log`.
2. **Allowlist gate** — Phase A canary. Agent must appear in
   `~/.claude/state/freshness-hook/agents.enabled` (line 334-339) OR have
   `FRESHNESS_HOOK_ENABLED=1` in env. Currently allowlisted: `sadie`, `boss`.
3. **Invalid task_id** — non-numeric or missing (line 346).
4. **Invalid agent label** — must match `[a-z][a-z0-9_-]*` (line 351).
5. **Per-call BYPASS** — `FRESHNESS_BYPASS=1`. Logged to `bypass.log`.
6. **DB missing** — `~/.claude/mcp-servers/task-board/tasks.db` not found.
7. **No DB row** for task_id — unknown task, fail-open.
8. **Bad age value** from SQLite — defensively fail-open.
9. **Status skips** — preclaim: `status != 'pending'`; prerevisit:
   `status IN ('completed','cancelled')`.
10. **Boss-self coordination** — `from_agent='boss' AND to_agent='boss'`
    (lines 496, 617). Boss can always self-coordinate even on Zone 3.
11. **Watchdog / synthetic** — `from_agent='watchdog' OR is_synthetic=1`
    (lines 502, 623). Auto-spawned bookkeeping tasks bypass entirely.
12. **Unknown mode** — `$1` not `preclaim` or `prerevisit` (line 699).
13. **Tool-name guard** — `TOOL_NAME` not in the matcher set (lines 444,
    554). Defense-in-depth in case the hook is ever registered too broadly.

## 7. Configuration

### 7.1 Environment variables

| Var | Default | Purpose | Source line |
|---|---|---|---|
| `FRESHNESS_HOOK_DISABLED` | unset | global kill-switch, exit 0 + audit | 326 |
| `FRESHNESS_HOOK_ENABLED` | unset | overrides allowlist gate | 339 |
| `FRESHNESS_BYPASS` | unset | per-call emergency, exit 0 + audit | 358 |
| `FRESHNESS_HOURS_COLD` | `24` | preclaim threshold in hours | 60, 449 |
| `FRESHNESS_REVISIT_GRACE_MIN` | `5` | Zone 0 upper bound, minutes | 63, 570 |
| `FRESHNESS_REVISIT_KEYWORD_MIN` | `30` | Zone 1 upper bound, minutes | 64, 575 |
| `FRESHNESS_REVISIT_HARDBLOCK_HR` | `2` | Zone 3 lower bound, hours (converted to minutes) | 65, 580 |

All numeric vars are validated against `[!0-9]` and fall back to default on
malformed input (no crash on `FRESHNESS_HOURS_COLD=foo`).

### 7.2 `agents.enabled` allowlist

- **Path:** `~/.claude/state/freshness-hook/agents.enabled`
- **Format:** one lowercase agent label per line. `#` comment lines and
  blank lines are stripped via `grep -v '^[[:space:]]*#'`. Matched
  case-sensitive with `grep -qFx`.
- **Current contents (do NOT modify per task instructions):**
  ```
  sadie
  boss
  ```
- **To add an agent:** append the label as a new line, e.g.
  `echo steve >> ~/.claude/state/freshness-hook/agents.enabled`. No restart
  needed — the file is read every invocation.
- **To remove:** delete the line. Same hot-reload behaviour.
- **To bypass file entirely:** set `FRESHNESS_HOOK_ENABLED=1` in that
  agent's environment (forces enable regardless of allowlist).

### 7.3 Pinned-memory match config (F2)

The rich inject's "PINNED MEMORIES" section is hardened against
cross-context leakage. Three guards combine (line 207-275):

1. **Stoplist** (line 224, verbatim, space-bounded for exact word match):
   ```
   the and with for from this that have are was will can not our any all
   but you may use see task agent verify check update status result keyword
   freshness system briefing claude session handoff zone note review revisit
   ```
   Words on this list are filtered before keyword extraction.

2. **Overlap-2 SQL** (line 256-262): require ≥2 distinct keyword `LIKE`
   hits per memory. Implemented via SQLite boolean arithmetic
   `((content LIKE x) + (content LIKE y) [+ (content LIKE z)]) >= 2`.

3. **Category allow-list** (line 250, verbatim):
   ```
   'fact','decision','preference','feedback','project'
   ```
   Excludes `task_summary` (loudest noise source — 153 rows),
   `learning` (91 rows, operating-rule style content), `role` (9 rows,
   identity), and any other categories.

4. **TG-id explicit signal** (line 247, 267-275): if the description
   contains `TG \d{4}`, the digits are extracted and matched directly,
   bypassing the overlap-2 rule (single explicit signal is enough).

Keywords are extracted as the first 3 alphabetic words ≥5 chars from
`tasks.description`, after stoplist filtering.

## 8. Invariants (fail-open preservation)

Per the #1074 verifier matrix (5/5 PASS), the following five fail-open
behaviours are guaranteed even on Zone 3 hardblock paths:

1. `FRESHNESS_HOOK_DISABLED=1` — exit 0, audit `verdict=DISABLED`
2. `FRESHNESS_BYPASS=1` — exit 0, audit `verdict=BYPASS`
3. Boss-self coord (`from=boss AND to=boss`) — exit 0 even on 5h stale task
4. Watchdog (`from='watchdog'`) and synthetic (`is_synthetic=1`) — exit 0
   even on 5h stale task
5. DB missing or unreadable — exit 0, audit `verdict=PASS detail=db-missing`

Additionally: any unknown `$MODE`, malformed env-var integer, invalid
task_id/agent-label, or missing DB row results in fail-open. The hook NEVER
deadlocks Claude Code.

## 9. Acceptance criteria (verifier evidence)

### 9.1 Seven zone scenarios (D1+D2 verifier, all PASS)

| # | Scenario | Expected | Got |
|---|---|---|---|
| 1 | Zone 0: 2-min task | exit 0 | ALLOW fresh-grace |
| 2 | Zone 1 keyword `DECISION REVERSED`, 10-min | exit 2 + inject | BLOCK keyword-DECISION |
| 3 | Zone 1 keyword-clean, 20-min | exit 0 | ALLOW no-keywords |
| 4 | Zone 2 + FRESHNESS in last 5min, 1h | exit 0 | ALLOW verdict-found |
| 5 | Zone 2 no FRESHNESS, 1h | exit 2 + inject | BLOCK prerevisit zone=2 |
| 6 | Zone 3 with fresh FRESHNESS, 3h | exit 2 (note must NOT bypass) | BLOCK HARDBLOCK |
| 7 | boss-self stale, 5h | exit 0 | PASS boss-self |

### 9.2 F1/F2/F3 ACs (post-fix, sprint score 95/100)

| Bead | AC | Result |
|---|---|---|
| F1 word-boundary | 16-case unit test (7 TP / 7 TN / 2 ESCALAT prefix) | 16/16 PASS |
| F2 hybrid memory match | stoplist + overlap-2 + category-allow, no false-positives on generic descriptions | 5/5 PASS |
| F3 footer dedup | "Bypass options:" appears exactly once per Zone 1/2/3 stderr | 3/3 PASS |
| 7-zone regression | scenarios 1-7 above | 7/7 PASS |
| Fail-open preservation | invariants in §8 | 5/5 PASS |

Spec-gate channels: 5/6 (shellcheck N/A — not installed; `bash -n` clean as
syntactic fallback).

## 10. Operator manual

### Disable globally (kill switch)
```bash
export FRESHNESS_HOOK_DISABLED=1
# Each invocation logs to ~/.claude/state/freshness-hook/disabled.log
```
Or unset the relevant `PreToolUse` blocks in `~/.claude/settings.json`
(lines 474-519).

### Bypass a single call
```bash
FRESHNESS_BYPASS=1 <your tool call>
# Logged to ~/.claude/state/freshness-hook/bypass.log
```

### Add an agent to the allowlist
```bash
echo steve >> ~/.claude/state/freshness-hook/agents.enabled
# Hot-reload — no restart needed
```

### Remove an agent
Delete the line from `~/.claude/state/freshness-hook/agents.enabled`.

### Tune zone thresholds per session
```bash
export FRESHNESS_REVISIT_GRACE_MIN=10        # extend grace to 10 min
export FRESHNESS_REVISIT_KEYWORD_MIN=45      # extend Zone 1 to 45 min
export FRESHNESS_REVISIT_HARDBLOCK_HR=4      # push hardblock out to 4h
export FRESHNESS_HOURS_COLD=48               # preclaim cold threshold
```

### Read invocation logs
| Log | Purpose |
|---|---|
| `~/.claude/state/freshness-hook.log` | per-invocation audit, format `ts mode=<m> agent=<a> task=<t> verdict=<v> detail=<d>` |
| `~/.claude/state/freshness-hook/debug.log` | parse errors, missing rows, bad ages |
| `~/.claude/state/freshness-hook/disabled.log` | kill-switch trips |
| `~/.claude/state/freshness-hook/bypass.log` | per-call bypass trips |

### Roll back

| Backup | What it restores |
|---|---|
| `~/.claude/hooks/freshness-check.sh.pre-abc-20260509T180627Z` | pre-F1/F2/F3 state (post D1+D2, pre-fix sprint #1074) |
| `~/.claude/hooks/freshness-check.sh.bak-20260509-200856` | pre-D1+D2 baseline (rollback fully to before zone ladder + rich inject) |
| `~/.claude/hooks/freshness-check.sh.bak-pre-filegate-1777426835` | pre-Phase-A baseline (Apr 29, before agents.enabled file gate) |

To roll back: `cp <backup> ~/.claude/hooks/freshness-check.sh && chmod +x
~/.claude/hooks/freshness-check.sh`.

## 11. History

- **2026-04-29** — initial rollout #696/#698/#700: preclaim mode, 24h cold
  threshold, FRESHNESS-note bypass, kill-switch + per-call BYPASS, Phase A
  per-agent file gate. Pre-filegate backup: `bak-pre-filegate-1777426835`.
- **2026-05-09 (D1+D2)** — rich inject payload added (`emit_stale_context`:
  notes / status / related tasks / pinned memories) and 4-zone prerevisit
  ladder introduced (grace / keyword / standard / hardblock). Pre-D1D2
  backup: `bak-20260509-200856`. Opus-verifier score: PASS with 1 medium
  (F1 substring keywords), 1 medium (F2 pinned-memory false-positives),
  1 low (F3 footer dup).
- **2026-05-09 (#1074, sprint freshness-fixes-abc)** — F1/F2/F3 patches:
  BSD word-boundary anchors on keyword regex; stoplist + overlap-2 SQL +
  category-allow on pinned-memory match; bypass-footer consolidated inside
  `emit_stale_context`. Pre-abc snapshot:
  `freshness-check.sh.pre-abc-20260509T180627Z`. Verifier score: 95/100.

Related task IDs: #696, #698, #700 (rollout), #988 (D1+D2 parent),
#1064/#1065/#1066 (D1+D2 sprint), #1073 (brainstorm), #1074 (F1/F2/F3 sprint).

## 12. Known limitations

- **F1 residual**: word-boundary anchors cannot disambiguate negation.
  "no decision needed" still triggers Zone 1 because `decision` is a real
  word at a real word boundary. Acknowledged in brainstorm; out of scope
  without semantic parsing. (verifier-report.md line 15)
- **F2 stoplist drift**: ~25 hardcoded low-signal words. Corpus drift will
  require periodic refresh. Not a correctness issue.
- **No semantic / RAG match**: pinned-memory surfacing is keyword-substring
  only. A relevant memory whose keywords don't appear in the task
  description (e.g. via synonym) will be missed.
- **10s cache TTL on FRESHNESS-note count**: a freshly-posted note may not
  unblock for up to 10 seconds (`CACHE_TTL=10`, line 59). Acceptable in
  practice; bypass is `FRESHNESS_BYPASS=1`.
- **Description-keyword extraction is alpha-only**: numeric IDs, hyphenated
  terms, and symbol-bearing tokens are stripped before keyword match. TG-id
  pattern is the sole exception.
- **Stderr cap is per-field, not byte-counted**: worst-case payload is
  bounded by structure (~1.5KB) but not hard-truncated. Empirically 2328
  bytes on a 10-large-note Zone 3 inject (under 3KB target).

## 13. Out of scope

- **Phase B promotion (steve, kiera)** — deliberate rollout choice. Phase A
  canary is sadie + boss. Promotion is a separate decision, not a hook
  capability gap.
- **Semantic / vector freshness scoring** — not in this layer.
- **Negation parsing on Zone 1 keywords** — see F1 residual above.
- **Cross-task drift detection** — hook reasons about one task at a time;
  it does not detect "this task is stale because a sibling task superseded
  it." Sibling/parent IDs are surfaced in the inject for the agent to
  evaluate, but no automated cross-task verdict.
- **Time-of-day / business-hours gating** — uniform thresholds.
- **Decision parsing** — the hook surfaces structural-change keywords; it
  does not parse the actual decision content. Agent must read the inject.

## 14. Source files

| Path | Role |
|---|---|
| `~/.claude/hooks/freshness-check.sh` | the hook (703 lines, post-#1074) |
| `~/.claude/hooks/freshness-check.SPEC.md` | this document |
| `~/.claude/hooks/freshness-check.sh.bak-20260509-200856` | pre-D1+D2 baseline |
| `~/.claude/hooks/freshness-check.sh.pre-abc-20260509T180627Z` | pre-F1/F2/F3 snapshot |
| `~/.claude/hooks/freshness-check.sh.bak-pre-filegate-1777426835` | pre-Phase-A baseline |
| `~/.claude/state/freshness-hook/agents.enabled` | Phase A allowlist (`sadie`, `boss`) |
| `~/.claude/state/freshness-hook/debug.log` | parse/error diagnostics |
| `~/.claude/state/freshness-hook/bypass.log` | per-call BYPASS audit |
| `~/.claude/state/freshness-hook/disabled.log` | kill-switch audit |
| `~/.claude/state/freshness-hook/task-<N>-<agent>.cache` | 10s FRESHNESS-note count cache |
| `~/.claude/state/freshness-hook.log` | per-invocation audit trail |
| `~/.claude/settings.json` (lines 474-519) | PreToolUse hook registration |
| `~/.claude/mcp-servers/task-board/tasks.db` | source DB (read-only via `sqlite3 -readonly`) |
| `~/.claude/.harness/sprints/sprint-freshness-fixes-abc-2026-05-09/contract.md` | F1/F2/F3 sprint contract |
| `~/.claude/.harness/sprints/sprint-freshness-fixes-abc-2026-05-09/evidence/verifier-report.md` | sprint pass/fail evidence |
| `/tmp/brainstorm-freshness-fixes-abc.md` | Phase 1 brainstorm (design-time) |
| `/tmp/freshness-D1D2-verifier-report.md` | pre-fix verifier severity table + 7 zone scenarios |
