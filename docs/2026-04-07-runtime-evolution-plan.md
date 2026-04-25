# Threadwork Runtime Evolution Plan

**Date:** 2026-04-07
**Source:** GASTOWN 3-phase plan, translated explicitly to Threadwork's stack (Bun/TS, server.ts MCP, tmux+LaunchAgent on macOS, 4 agents).
**Stack mapping:**
- `bead_runner.py` → there is no Python loop in Threadwork. Agents ARE Claude sessions. The closest analogue is `server.ts` (the MCP server they call) plus the launch glue in `scripts/launch-all.sh` and `~/.claude/telegram-pool.sh`.
- `tmux_llm.py` → `scripts/launch-all.sh` + `~/.claude/telegram-pool.sh` (they own tmux + bot pairing). No persistent Python wrapper.
- `db.py` → `db.ts` (extended by `memory.ts`, `decision.ts`, `audit.ts`).
- ClawHarness `consolidate-classified.js` → `consolidate.ts` (already runs nightly at 03:00 via `com.threadwork.consolidate.plist`).
- "Concierge bead" → `snoopy` (lifecycle / customer insight) is the lowest-blast-radius worker; canary candidate.
- "COO + Product" → `sadie` (finance/inventory/fulfillment) + `kiera` (storefront/merchandising/CRO) — second wave.
- "Fleet" → all 4 sessions in `SESSION_NAMES` (`claude-boss claude-steve claude-sadie claude-kiera`). Note: `snoopy` exists in `config.ts:21` but is NOT in `launch-all.sh`'s `SESSION_NAMES` (`docs/boot-sequence.md:66`); add it before canarying or canary `kiera` instead.
- "Guardian veto" → there is no guardian agent in Threadwork. Closest analogue: a `decisions.finalize` row where this agent's position was NOT chosen (`chosen_position_id != this agent's position`).

---

## Phase 1 (week 1) — Interaction-Budget Restart

**Files:** `server.ts` + `db.ts` + new `scripts/restart-agent.sh` + `config.ts`
**Size:** ~130 lines (vs GASTOWN's 150 — Threadwork is leaner because tmux IPC is shell, not Python)

**Counters** (new table `agent_session_state`, one row per agent):
- `session_started_at` (TEXT)
- `interaction_count` (INTEGER) — incremented in `server.ts` `CallToolRequestSchema` handler at `server.ts:443` on every tool call
- `session_generation` (INTEGER) — bumped by restart, persists across crashes via DB
- `last_restart_reason` (TEXT) — `'interaction_threshold' | 'wall_clock' | 'manual' | 'crash_recovery'`

**Threshold:** 70 interactions OR 4h wall-clock since `session_started_at`. Configurable via `config.ts`:
```ts
export const SESSION_INTERACTION_BUDGET = 70
export const SESSION_WALL_CLOCK_HOURS = 4
export const SESSION_RESTART_ENABLED = false  // canary feature flag
```

**Continuation handoff:** before triggering restart, `server.ts` writes a `session_handoff` memory via `mem.saveMemory()`:
- `agent` = self
- `classification` = `'operational'`
- `category` = `'session_handoff'`
- `content` = JSON of: active task ids, last 3 audit log entries, current decision positions, last MCP tool call, session_generation
- `pinned` = 1 (so it survives decay until next boot)

The restart-aware `get_boot_briefing` (already added in the crash-recovery plan) reads this and surfaces it in a new `== HANDOFF ==` section.

**Restart mechanism (no Python required):**
- `server.ts` does not kill its own session. It writes the handoff memory, audits `restart_pending`, sends a Telegram nudge to itself ("Restart in 30s, finalize your current message"), and writes `agent_session_state.last_restart_reason`.
- A new shell script `scripts/restart-agent.sh <agent>` runs `tmux send-keys -t claude-<agent> '/exit' Enter`. The next `launch-all.sh` cycle (≤5min via LaunchAgent at `templates/com.threadwork.agents.plist`) recreates the session and `get_boot_briefing` loads the handoff.
- `watchdog.ts` (already runs the lease/heartbeat loop after the crash-recovery plan ships) gains a side-job: poll `agent_session_state` and call `restart-agent.sh` for any agent past threshold whose feature flag is enabled.

**Closed-loop check** (write to `audit_log` so it's queryable):
After restart completes, audit the next 3 tool calls for the restarted agent and write a `restart_health_check` row with:
- `referenced_handoff` (boolean) — did the agent's response text mention any task_id from the handoff memory?
- `tool_errors` (count) — any tool calls that returned `isError: true`?
- `goal_stall` (boolean) — did the same task stay in_progress for >2 watchdog cycles after restart?

**Canary plan:**
1. Day 1-2: enable for `snoopy` only (add to `SESSION_NAMES` first if not already, otherwise canary `kiera`). Watch the 3 health-check fields in audit_log.
2. Day 3-4: add `sadie` + `kiera`.
3. Day 5+: add `steve`. Boss last (highest blast radius — bypassing boss restart could orphan worker tasks).

**Hard rollback:** flip `SESSION_RESTART_ENABLED = false` in `config.ts`, restart server.ts session via tmux. The watchdog poll becomes a no-op. Counters keep incrementing harmlessly.

---

## Phase 2 (week 2) — Mid-Session Anchoring

**Files:** `server.ts` + new `anchor.ts` + `db.ts` + reuse `nudge.ts`
**Size:** ~150 lines (vs GASTOWN's 170)

**Anchor cadence:** every 12 interactions per agent. The same `interaction_count` from Phase 1 drives this — reuse the counter, don't add a second one.

**Anchor composition** (~200 tokens, built by new `anchor.ts`):
- Role line: `AGENT_OWNERSHIP[agent]` from `config.ts:20-26`
- 3-5 foundational memories: `SELECT * FROM memories WHERE agent IN (?, '__shared__') AND classification='foundational' AND state='active' ORDER BY importance DESC, last_accessed DESC LIMIT 5` (uses existing schema at `db.ts:74-94`)
- 1-3 strategic memories: same query, `classification='strategic'`, LIMIT 3
- Active mission: most recent `in_progress` task assigned to this agent
- Closing line: literal `"If any of the above conflicts with what you remember, say so before acting on it."`

**4 event triggers:**
1. **Cadence** — every 12 interactions (in `server.ts` after the tool dispatch returns)
2. **Post-restart** — first interaction after `last_restart_reason` is set; clear the trigger after firing
3. **Post-foundational-promotion** — on `promote_memory` tool handler at `server.ts:897` if classification becomes `'foundational'`, fire anchor for all agents
4. **Post-decision-against-this-agent** — on `finalize_decision` at `server.ts:739`, if `chosen_position_id` belongs to a different agent's position, fire anchor for the losing agents
5. **Tool burst** — 5+ tool calls within 60 seconds (track via rolling window in the `agent_session_state` row)

**Persistence** (new table `anchor_log`, not a column):
```sql
CREATE TABLE IF NOT EXISTS anchor_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  anchor_version_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged INTEGER NOT NULL DEFAULT 0,
  ack_audit_log_id INTEGER REFERENCES audit_log(id)
);
CREATE INDEX IF NOT EXISTS idx_anchor_log_agent ON anchor_log(agent, sent_at DESC);
```

`anchor_version_hash` = SHA-256 of the rendered content. Lets us correlate "agent saw exactly this anchor" with downstream behavior across sessions.

**Send mechanism:** anchors are NOT sent as MCP tool responses (the agent isn't waiting on a tool). They're delivered via `nudgeAgent()` (already exists in `nudge.ts`) which uses `tmux send-keys` to inject a `<system>` block into the agent's session. Anchor content is wrapped in `<anchor version="...">...</anchor>` so the regex below can detect references.

**Closed-loop check:** `model_acknowledges_conflict_after_anchor`
- Background job in `watchdog.ts`: for each unacknowledged `anchor_log` row in last 24h, scan the next 3 audit_log entries for that agent for one of: `"conflict"`, `"contradicts"`, `"different from"`, `"correction"`, or the literal `anchor_version_hash` substring.
- Mark `acknowledged=1` and link `ack_audit_log_id` if matched.
- Daily cron (extend `consolidate.ts`): compute `acknowledged / total_sent` for last 50 anchors. If <10%, write a `health_alert` audit row + Telegram alert to the group. The anchor is ineffective.

---

## Phase 3 (week 3+) — Semantic Rollup

**Files:** `consolidate.ts` extension + new `embeddings.ts` + reuse `decision.ts`
**Size:** ~380 lines (vs GASTOWN's 420 — Threadwork already has the council schema in `decision.ts`, no new tables needed for the deliberation step)

**Two-pass dedup/cluster:**

**Pass 1 — content_hash exact dedup:**
- `consolidate.ts` already has `runDecay`, `runArchive`, `runPrune`. Add `runDedup(mem)`.
- Compute `sha256(normalize(content))` for every `state='active'` memory.
- For each duplicate cluster: keep the highest-importance row; mark others `state='superseded'` and set `supersedes_memory_id` on the survivor (existing column at `db.ts:89`).

**Pass 2 — semantic cluster via text-embedding-3-small at cosine 0.84:**
- New `embeddings.ts` calls OpenAI `text-embedding-3-small` (or local fallback if `OPENAI_API_KEY` missing — log skip and exit pass 2).
- Add `embedding BLOB` column to `memories` (via `safeAlterStatements` pattern at `db.ts:197` — use sqlite-vec extension if available, else store as raw JSON float array).
- Cluster active memories whose embeddings are within 0.84 cosine similarity. Use simple greedy clustering — no k-means.

**3 cluster quality filters (must all pass before promotion):**
1. Cluster must contain memories from ≥2 distinct `source_task_id` values (filter false patterns from a single task).
2. `SUM(support_count) > SUM(challenge_count)` across the cluster.
3. No memory in the cluster's embedding neighborhood (within 0.84) is already classified `'foundational'` AND its `supersedes_memory_id` chain doesn't trace back to anything in this cluster (don't double-promote).

**Promotion flow (uses existing decisions schema, no new tables):**
- `consolidate.ts` opens a decision via `decisions.createDecision()` with `created_by='consolidator'` (a pseudo-agent — add `'consolidator'` to a known senders allowlist in `server.ts` if it doesn't exist).
- Title: `"Promote pattern: <truncated cluster content>"`. Description includes the cluster member ids and embeddings centroid.
- Each agent whose `AGENT_OWNERSHIP` overlaps the cluster's category gets a Telegram nudge to call `submit_position`. 24h timer.
- After 24h OR all 4 agents have submitted: a new `consolidator-finalize` script in `scripts/` calls `decisions.finalizeDecision()` with the highest-confidence position.
- On finalize: write a NEW memory with `classification='foundational'`, `support_count=cluster.size`, `evidence=JSON.stringify(member_ids)`, `supersedes_memory_id` pointing to the highest-importance cluster member. All other cluster members get `state='superseded'` (existing flow from Pass 1).

**Closed-loop check:** `pattern_recurrence_after_activation`
- 14 days after a foundational memory is created via this flow: count `observational` memories whose embedding cosine similarity to the foundational > 0.84.
- Compare to the 14-day window BEFORE promotion (baseline).
- If post-count drops by ≥50%: promotion is working — pattern is being absorbed instead of re-observed.
- If post-count is unchanged or higher: promotion failed — write `promotion_health_alert` audit + Telegram alert. Consider supersedence rollback (set `state='active'` on superseded members, set foundational to `state='disputed'`).

---

## Cross-cutting notes

- **All three phases share the same feature flag pattern:** const in `config.ts`, default `false`, flip to `true` per-phase canary. No env vars (`config.ts` is the single source of truth and is git-tracked).
- **All three phases write to the existing `audit_log` table** (`db.ts:126`) — no new audit infrastructure. Query via existing `query_audit_log` MCP tool at `server.ts:1083`.
- **Phase 1 must ship before Phase 2** (anchor uses interaction_count from Phase 1 counters).
- **Phase 3 is independent of Phase 1+2** but assumes the crash-recovery plan (`2026-04-07-crash-recovery-plan.md`) has shipped first, since it adds the `task_intents` table that intent-replay uses.
- **Sequence with crash-recovery plan:** ship `2026-04-07-crash-recovery-plan.md` first (week 0), then this plan's Phase 1 (week 1), then Phase 2 (week 2), then Phase 3 (week 3+).
- **Snoopy gap:** Phase 1 canary needs `snoopy` running. Currently `config.ts:21` defines it but `scripts/launch-all.sh:66` `SESSION_NAMES` does not include it. Either add `claude-snoopy` to `SESSION_NAMES` first, or canary `kiera` instead. Decide before week 1 starts.
