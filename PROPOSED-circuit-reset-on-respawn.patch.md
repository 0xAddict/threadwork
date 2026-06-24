# PROPOSED PATCH — Circuit-breaker reset-on-respawn (FIX A) + fault-count cap (FIX C) + optional orphan guard (FIX B)

Status: **PROPOSED — NOT APPLIED.** Apply is GATED to Boss's coordinated window (requires a task-board MCP restart). Written by snoopy as a non-colliding artifact while sadie is concurrently editing watchdog.ts/db.ts for #13012.

Root cause (recap): runaway, non-resetting `fault_count` SQL counter in `agent_sessions`. A live, healthy respawned agent keeps getting charged a fault every watchdog tick for an OLD abandoned `in_progress` task whose `last_heartbeat_at` is stale. `isSessionDead` returns false (session is `ACTIVE_THINKING`/`TOOL_IN_FLIGHT`, not `dead`), so control reaches the HEARTBEAT-OVERDUE branch → `recordFault` → `fault_count++` with no upper bound and no respawn reset (observed sadie=499 / kiera=500, circuit OPEN, both verified healthy). The "501" was the live counter value, **not** a uid/path leak.

These hunks are all against the **production** tree:
- `/Users/coachstokes/.claude/mcp-servers/task-board/server.ts`
- `/Users/coachstokes/.claude/mcp-servers/task-board/db.ts`

`closeCircuit` signature (verified, db.ts:2115): `closeCircuit(agent: string): void` — zeroes `fault_count`, sets `circuit_state='closed'`, NULLs `circuit_opened_at`/`cooldown_until`. Receiver on the MCP handler side is the local `db` instance (same receiver already used at server.ts:834: `db.closeCircuit(task.to_agent)`).

---

## FIX (A) — closeCircuit-on-respawn  [PRIMARY · LOW RISK · APPLY]

### Why `get_boot_briefing` is the correct insertion point
Every threadwork agent calls `get_boot_briefing` as its FIRST task-board action on boot / after `/clear` / after a supervisor respawn (mandated in CLAUDE.md "On Boot" step 1; the session-boot hook re-invokes it too). That makes it the precise, **low-frequency**, semantically-correct "this is a fresh session" signal. It is strictly better than resetting inside `claim_task`/`upsertAgentSession` (those fire mid-flight on every claim and would mask a genuinely-degrading agent that is still picking up work). The reset is **guarded** to only fire when the circuit is actually open/half_open, so the common (healthy) boot path does zero extra writes.

### File: `server.ts` — handler `case 'get_boot_briefing':` (anchor at line 997)

BEFORE (server.ts:997-999):
```ts
      case 'get_boot_briefing': {
        const briefing = mem.getBootBriefing(SELF_LABEL, db)
        const sections: string[] = []
```

AFTER:
```ts
      case 'get_boot_briefing': {
        // #13012 FIX (A): reset the circuit breaker on respawn. get_boot_briefing
        // is the first task-board call a freshly (re)started session makes, so a
        // tripped/degrading circuit carried over from the PREVIOUS session pid
        // (whose abandoned in_progress tasks ran fault_count into the hundreds and
        // opened the breaker) must not penalize this fresh session. Guarded so the
        // healthy boot path does no extra writes. Mirrors the existing
        // half_open->closed reset at the complete_task handler (db.closeCircuit).
        const bootCircuit = db.getCircuitState(SELF_LABEL)
        if (bootCircuit && bootCircuit.circuit_state !== 'closed') {
          db.closeCircuit(SELF_LABEL)
          audit.log(SELF_LABEL, 'circuit_closed', {
            agent: SELF_LABEL,
            reason: 'session respawn (get_boot_briefing)',
            prior_state: bootCircuit.circuit_state,
            prior_fault_count: bootCircuit.fault_count,
          })
        }

        const briefing = mem.getBootBriefing(SELF_LABEL, db)
        const sections: string[] = []
```

Risk: **LOW.** `getCircuitState` and `closeCircuit` are existing, scoped, idempotent ops already exercised in the complete_task path. New code only runs when a circuit is non-closed AND only for the calling agent (`SELF_LABEL`). No watchdog/timing change. No new imports (`db`, `audit`, `SELF_LABEL` all already in scope in this handler).

Note on coverage: each agent's MCP server resets ITS OWN circuit on boot (handler is `SELF_LABEL`-scoped). That is exactly right for the respawn scenario (each respawned agent calls get_boot_briefing on its own boot). It does NOT auto-clear a circuit for an agent that never reboots — which is correct (we don't want to silently clear a genuinely-degraded agent that's still up).

---

## FIX (C) — saturate fault_count at FAULT_THRESHOLD+1  [CHEAP SAFETY NET · APPLY]

Prevents a stuck/abandoned task from running the counter into the hundreds again (defense in depth; does NOT by itself fix the false-positive — circuit still opens at the threshold — but bounds the blast radius and makes the metric legible). Cap at `FAULT_THRESHOLD + 1` so the "is open?" check (`fault_count >= FAULT_THRESHOLD`) still triggers exactly once and the decay path (`MAX(0, fault_count-1)`) still has one tick of headroom above threshold.

### File: `db.ts` — method `recordFault` (anchor at line 2066-2092)

BEFORE (db.ts:2068-2078):
```ts
      // Increment fault count
      db.prepare(`
        UPDATE agent_sessions SET
          fault_count = COALESCE(fault_count, 0) + 1,
          last_fault_at = datetime('now'),
          last_fault_type = ?
        WHERE agent = ?
      `).run(faultType, agent)

      const row = db.prepare('SELECT fault_count, circuit_state FROM agent_sessions WHERE agent = ?').get(agent) as any
      if (!row) return { circuit_state: 'closed', fault_count: 0 }
```

AFTER:
```ts
      // Increment fault count, saturating at FAULT_THRESHOLD + 1.
      // #13012 FIX (C): without a cap, an abandoned in_progress task (stale
      // heartbeat, live session) re-charges a fault every watchdog tick and the
      // counter climbs unbounded into the hundreds (observed 499/500). The cap
      // keeps the metric legible and bounds the blast radius; the open-circuit
      // check below still fires at the threshold, and the decay path keeps one
      // tick of headroom (MAX(0, fault_count-1)).
      db.prepare(`
        UPDATE agent_sessions SET
          fault_count = MIN(COALESCE(fault_count, 0) + 1, ?),
          last_fault_at = datetime('now'),
          last_fault_type = ?
        WHERE agent = ?
      `).run(this.FAULT_THRESHOLD + 1, faultType, agent)

      const row = db.prepare('SELECT fault_count, circuit_state FROM agent_sessions WHERE agent = ?').get(agent) as any
      if (!row) return { circuit_state: 'closed', fault_count: 0 }
```

Risk: **LOW.** Pure arithmetic saturation. `this.FAULT_THRESHOLD` (=3) is already a field on the same class (db.ts:2024); `MIN(...)` is plain SQLite. Bound parameter order updated (`FAULT_THRESHOLD+1` first, then `faultType`, then `agent`) to match the new placeholder order — verify at apply time.

---

## FIX (B) — orphaned-task session-id mismatch guard  [OPTIONAL · MEDIUM RISK · INCLUDE-OR-DEFER]

Independent of (A)/(C). Stops charging recurring faults for a task that the *current* live session has effectively abandoned: if the session is alive but the task's `worker_session_id` no longer matches the agent's current registered session, treat it as orphaned (escalate/auto-close to boss once) instead of recording a per-tick fault against the fresh session.

**DO NOT ship without verifying the session-id semantics**, specifically:
1. `tasks.worker_session_id` is currently populated with the tmux session label (e.g. `claude-sadie`) — see live rows for #13012/#13008 (`worker_session_id = claude-sadie`/`claude-kiera`). That label is **stable across respawns**, so it will NOT distinguish an old pid from a new one as written. For (B) to work, `worker_session_id` must be the per-process session UUID (the `session_id` arg threaded through `claim_task` → `claimTaskWithSession`), and `agent_sessions.session_id` must store the same UUID. Confirm BOTH are the UUID (not the tmux label) before relying on the mismatch test, otherwise the guard never trips (false-negative) or trips always (false-positive).
2. Decide the orphan action: prefer "escalate once to boss + null `next_check_at`" (mirrors the #823 escalate-once-and-stop / #850 terminal-guard pattern at watchdog.ts:595-602) over auto-cancel, so a human/boss adjudicates.

### File: `watchdog.ts` — method `handleHeartbeatOverdue` (insert AFTER the subagent/restart-window guard block, i.e. after line 654, BEFORE the `// (#850 Layer 2)` heartbeat-dedup block)

Proposed shape (ILLUSTRATIVE — finalize after the session-id verification above):
```ts
      // #13012 FIX (B) [OPTIONAL]: if the live session no longer owns this task
      // (its worker_session_id != the agent's currently-registered session_id),
      // the task was abandoned across a respawn. Don't keep charging the fresh
      // session a fault every tick — escalate once to boss and disarm re-pickup.
      // GATED ON: worker_session_id and agent_sessions.session_id both being the
      // per-process UUID, not the stable tmux label. Verify before enabling.
      const liveSession = this.taskDb.run(db =>
        db.prepare('SELECT session_id FROM agent_sessions WHERE agent = ?').get(task.to_agent)
      ) as { session_id: string | null } | undefined
      if (
        task.worker_session_id &&
        liveSession?.session_id &&
        task.worker_session_id !== liveSession.session_id
      ) {
        log(`Task #${task.id} orphaned across respawn (task session ${task.worker_session_id} != live ${liveSession.session_id}) — escalating once, not faulting ${task.to_agent}`)
        this.audit.log('watchdog', 'orphaned_task_session_mismatch', {
          task_id: task.id,
          agent: task.to_agent,
          task_session: task.worker_session_id,
          live_session: liveSession.session_id,
        }, task.id)
        this.taskDb.run(db => db.prepare('UPDATE tasks SET next_check_at = NULL WHERE id = ?').run(task.id))
        await this.escalateToBoss(task, (task.escalation_level ?? 0) + 1, 'orphaned across respawn (session id mismatch)')
        return
      }
```

Risk: **MEDIUM.** Touches the live fault-recording control flow. The session-id-semantics assumption (item 1 above) is load-bearing: if `worker_session_id` is the tmux label, this either never fires or always fires. Must be validated against live data before enabling. `escalateToBoss` exists in this class (used at watchdog.ts:668) — confirm arity/signature when finalizing. Recommend behind review, separately from (A)/(C).

---

## Apply note (gated — Boss's window)
These changes live in `server.ts` (FIX A) and `db.ts` (FIX C); optional FIX B is in `watchdog.ts`. They take effect ONLY after the **task-board MCP server is restarted** — the running MCP process holds the compiled/loaded module in memory, so an on-disk edit is inert until restart. Restarting the MCP is disruptive to all connected agents (boss/steve/sadie/kiera), so the apply is GATED to Boss's coordinated window. Recommended sequence at apply time: (1) ensure sadie has finished/checkpointed her #13012 edits to avoid a merge collision, (2) apply A+C (and optionally B after the session-id verification), (3) syntax-validate (below), (4) restart the task-board MCP, (5) confirm each agent's circuit reads `closed` after its next `get_boot_briefing`.

## Syntax-validation note
No `tsconfig.json` exists in this dir (it's a Bun project; `package.json` present, entry compiled by Bun). At apply time, validate against a COPY without rebuilding/restarting the live MCP, e.g.:
```
cp server.ts /tmp/server.check.ts && cp db.ts /tmp/db.check.ts && cp watchdog.ts /tmp/watchdog.check.ts
npx tsc --noEmit --allowJs --skipLibCheck --moduleResolution bundler --target es2022 /tmp/server.check.ts /tmp/db.check.ts /tmp/watchdog.check.ts
# (cross-file imports will report as missing on isolated copies — that is expected;
#  the goal is to catch syntax/brace/paren errors in the edited hunks. Alternatively:
#  `bun build server.ts db.ts watchdog.ts --no-bundle --outdir /tmp/tw-check` for a
#  no-restart type/parse pass.)
```
`npx tsc` is available (TypeScript 6.0.2 in this project). Do NOT run `bun build`/restart against the live entrypoint as part of validation — use the copy.

## Verification done while authoring (read-only)
- `closeCircuit(agent: string): void` confirmed at db.ts:2115; existing call pattern `db.closeCircuit(...)` at server.ts:834.
- `getCircuitState` returns `{ circuit_state, fault_count, cooldown_until }` (db.ts:2027).
- `FAULT_THRESHOLD = 3` field on same class as `recordFault` (db.ts:2024).
- `get_boot_briefing` handler confirmed at server.ts:997; `db`, `audit`, `SELF_LABEL` in scope.
- Live abandoned tasks confirmed: #13012 (sadie), #13008/#1725/#13027 (kiera) in_progress with stale heartbeats; `worker_session_id` = tmux label `claude-sadie`/`claude-kiera` (the FIX-B caveat).
- NOTHING in this artifact has been applied to the live watchdog.ts / db.ts / server.ts. No MCP restart performed. No tmux panes touched. No watchdog_alert_state modified.
