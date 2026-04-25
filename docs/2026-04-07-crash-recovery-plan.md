# Threadwork Crash Recovery & Durability Plan

**Date:** 2026-04-07
**Pipeline:** Option C — `/council-balanced` → Codex (read-only planning)
**Scope:** Threadwork only (Bun/TS multi-Claude harness on macOS, 4 agents). No GASTOWN/ClawHarness generalization.

---

## Executive summary

**Verdict (LLM Council, balanced preset, 23K tokens, 7 API calls):**

> Keep tmux. Do **not** build a DB-owner daemon. Put durability in SQLite via task leases + intent log + watchdog reclaim. Boot briefing becomes recovery-aware but does **not** auto-reclaim — watchdog is the sole reclaim owner to avoid split-brain.

**Council models:** GPT-5.4-mini · Gemini 2.5 Flash · Claude Haiku 4.5 · DeepSeek-R1 (chair: GPT-5.4)
**Council JSON artifact:** `/tmp/threadwork-council.json`

**Minority dissent:** if hung-but-alive Claude sessions become frequent, switch to one-LaunchAgent-per-agent with healthcheck wrapper. Not for this pass.

---

## Council key insights

- Threadwork's main durability failure is **not** "tmux can't respawn processes" — it is "the app cannot prove what an agent was doing before a crash or hang." Fix leases, heartbeats, and intent logging *before* replacing tmux.
- Shared SQLite WAL is defensible for 4 agents + MCP + watchdog on one Mac, provided writes stay short and you add observability for `SQLITE_BUSY`. The missing piece is application-level recovery semantics, not immediate database centralization.
- tmux is not a true supervisor. It cannot detect a hung-but-alive Claude process. Today this is hidden by the 5-minute LaunchAgent relaunch window; the proposed lease/heartbeat model surfaces it as a missed heartbeat instead.
- Without intent-before-action, any side-effectful tool call can duplicate after a crash. Even with clean reclaim, you still lack replay/audit for "was this action already attempted?"

---

## Codex implementation plan

### Inventory confirmed
`rg --files /Users/xavierandre/threadwork` shows the root copy contains the files targeted by this plan: `config.ts`, `db.ts`, `server.ts`, `watchdog.ts`, `audit.ts`, `memory.ts`, `decision.ts`, `notify.ts`, `nudge.ts`, `package.json`, `tests/*`, `docs/*`, plus a mirrored `mcp-servers/task-board/*` subtree. Plan targets root files only.

### Edit map with current anchors
- Add lease/heartbeat constants after `config.ts:52`.
- Extend `Task` and add `TaskIntent` types at `db.ts:4` and after `db.ts:40`.
- Add `task_intents` DDL inside `migrate()` near `db.ts:51`.
- Append new `ALTER TABLE tasks ...` statements to `safeAlterStatements` at `db.ts:197`.
- Backfill lease columns for legacy `in_progress` rows in the post-migration `UPDATE` block near `db.ts:226`.
- Add `withBusyLogging()` helper after `db.ts:49`, then wrap `migrate()`, `createTask()`, `getTask()`, `listTasks()`, `claimTask()`, `completeTask()`, `logIntent()`, `completeIntent()`, `heartbeatTask()`, `requeueExpiredTask()`.
- Upgrade `claimTask()` at `db.ts:277`.
- Upgrade `completeTask()` at `db.ts:286`.
- Keep `findUnclaimedTasks()` at `watchdog.ts:25`, but retire claimed-at based stale logic at `watchdog.ts:9` and the escalation helper at `watchdog.ts:34`.
- Add lease constants import at `watchdog.ts:7`.
- Replace the main script block beginning at `watchdog.ts:55` with a lease-based watchdog pass.
- Insert module-scope heartbeat state after `server.ts:37`.
- Add helper functions immediately before the tool switch at `server.ts:443`.
- Update side-effectful handlers at `server.ts:448`, `:467`, `:481`, `:531`, `:547`, `:566`, `:739`, `:981`.
- Add recovery-aware boot text inside `get_boot_briefing` at `server.ts:866`.
- Extend audit metadata inside `get_boot_briefing` at `server.ts:883`.
- Append new smoke test after `tests/watchdog.test.ts:64`.
- Update stale-task unit tests beginning at `tests/watchdog.test.ts:21` from `claimed_at` semantics to `heartbeat_at` semantics.
- **Note:** the current docs still say watchdog runs every 5 minutes at `docs/2026-04-01-observability-watchdog-onboarding.md:91` and `:142`, so a 2-minute stale threshold will be coarse unless scheduler cadence changes in a later pass.

### Config changes
Add these constants after `config.ts:52`:

```ts
export const TASK_HEARTBEAT_INTERVAL_MS = 25_000
export const TASK_LEASE_SECONDS = 360
export const TASK_STALE_AFTER_MINUTES = 2
export const TASK_WARN_AFTER_MINUTES = 5
```

`360s` gives a clear 2m nudge → 5m warn → 6m reclaim ladder while staying close to the council brief.

### Exact migration SQL

Add the `task_intents` table and indexes to the main `this.db.exec(...)` block in `migrate()` near `db.ts:51`:

```sql
CREATE TABLE IF NOT EXISTS task_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id),
  claim_epoch INTEGER,
  agent TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_lease ON tasks(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status_heartbeat ON tasks(status, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_task_intents_key ON task_intents(idempotency_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_intents_task ON task_intents(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_intents_status ON task_intents(status, created_at DESC);
```

Append these three statements to `safeAlterStatements` at `db.ts:197`:

```ts
"ALTER TABLE tasks ADD COLUMN claim_epoch INTEGER NOT NULL DEFAULT 0",
"ALTER TABLE tasks ADD COLUMN heartbeat_at TEXT",
"ALTER TABLE tasks ADD COLUMN lease_expires_at TEXT",
```

Add this backfill SQL to the existing post-migration update block near `db.ts:226`:

```sql
UPDATE tasks
SET claim_epoch = CASE
  WHEN claimed_at IS NOT NULL AND claim_epoch = 0 THEN 1
  ELSE claim_epoch
END;

UPDATE tasks
SET heartbeat_at = COALESCE(heartbeat_at, claimed_at)
WHERE status = 'in_progress' AND claimed_at IS NOT NULL;

UPDATE tasks
SET lease_expires_at = COALESCE(
  lease_expires_at,
  datetime(COALESCE(heartbeat_at, claimed_at), '+360 seconds')
)
WHERE status = 'in_progress' AND COALESCE(heartbeat_at, claimed_at) IS NOT NULL;
```

### TaskDB API surface

Add these signatures in `TaskDB` around `db.ts:41`. `completeTask()` also needs an epoch upgrade.

```ts
claimTask(id: number, agent: string, leaseSeconds: number = TASK_LEASE_SECONDS): Task | null

completeTask(id: number, agent: string, claimEpoch: number, result: string): Task | null

logIntent(input: {
  taskId?: number | null
  claimEpoch?: number | null
  agent: string
  toolName: string
  idempotencyKey: string
  argsJson: string
}): TaskIntent

completeIntent(
  idempotencyKey: string,
  status: 'succeeded' | 'failed',
  resultJson?: string | null,
  errorText?: string | null,
): TaskIntent | null

heartbeatTask(
  id: number,
  agent: string,
  claimEpoch: number,
  leaseSeconds: number = TASK_LEASE_SECONDS,
): Task | null

requeueExpiredTask(id: number, expectedClaimEpoch: number): Task | null
```

**Behavior:**
- `claimTask()`: set `status='in_progress'`, `claimed_at`, `heartbeat_at`, `lease_expires_at`, `claim_epoch = claim_epoch + 1`, reset `nudge_count = 0`.
- `completeTask()`: require `to_agent = ?`, `status='in_progress'`, `claim_epoch = ?`, then clear `heartbeat_at` and `lease_expires_at`.
- `heartbeatTask()`: only extend lease if `status='in_progress'`, `to_agent = ?`, `claim_epoch = ?`.
- `requeueExpiredTask()`: CAS on `claim_epoch`, clear claim timestamps, set `status='pending'`, bump `claim_epoch`, reset `nudge_count`.
- `logIntent()`: reuse a recent matching intent row by `idempotency_key` instead of inserting forever-unique rows; use a 10-minute dedupe window inside the query, **not** a permanent unique constraint.
- `completeIntent()`: update the latest pending intent for the supplied key.

Extend the `Task` type at `db.ts:4` with:
- `claim_epoch: number`
- `heartbeat_at: string | null`
- `lease_expires_at: string | null`
- `nudge_count: number`

### Busy logging in db.ts

Add `withBusyLogging<T>(context: string, fn: () => T): T` after `db.ts:49`. Catch errors whose message contains `SQLITE_BUSY`, emit `console.error('[sqlite_busy]', { context, dbPath: DB_PATH, error: String(err) })`, then rethrow.

Wrap these call sites:
- `this.db.exec(...)` in `migrate()`
- every `.get()` or `.all()` in `createTask()`, `getTask()`, `listTasks()`, `claimTask()`, `completeTask()`
- all new intent and heartbeat methods

Do **not** thread this through `memory.ts`, `decision.ts`, or `audit.ts` in this pass — they grab the raw DB handle directly and that's a larger refactor.

### Heartbeat placement and active-task discovery

Install heartbeat state in `server.ts` after `server.ts:37` as an in-memory map:

```ts
const activeLeases = new Map<number, { claimEpoch: number; timer: Timer }>()
```

Use an in-memory map, **not** a DB scan and **not** a state file.

- The heartbeat loop must never discover tasks by querying the DB; that risks re-heartbeating a reclaimed row and recreating split-brain.
- Each successful `claim_task` at `server.ts:467` should start a `setInterval()` that calls `db.heartbeatTask(task.id, SELF_LABEL, task.claim_epoch, TASK_LEASE_SECONDS)` every `TASK_HEARTBEAT_INTERVAL_MS`.
- Each successful `complete_task` at `server.ts:481` should clear that task's interval.
- If `heartbeatTask()` returns `null`, clear the timer immediately and audit `task_lease_lost`.
- Add `resolveClaimEpoch(taskId)` before `server.ts:443`: use `activeLeases` first, then a narrow `db.getTask(taskId)` fallback only for explicit task-bound operations after a process restart.

### Tool classification (server.ts handlers)

| Tool | Anchor | Class | Intent wrap |
|---|---|---|---|
| `create_task` | `server.ts:448` | side-effectful | yes |
| `claim_task` | `server.ts:467` | side-effectful | yes |
| `complete_task` | `server.ts:481` | side-effectful | yes |
| `list_tasks` | `server.ts:509` | read-only | no |
| `send_note` | `server.ts:531` | side-effectful | yes |
| `nudge_agent` | `server.ts:547` | side-effectful | yes |
| `open_decision` | `server.ts:566` | side-effectful | yes |
| `submit_position` | `server.ts:641` | stateful-but-local | no |
| `critique_position` | `server.ts:673` | stateful-but-local | no |
| `list_decisions` | `server.ts:707` | read-only | no |
| `get_decision_brief` | `server.ts:729` | read-only | no |
| `finalize_decision` | `server.ts:739` | side-effectful | yes |
| `save_memory` | `server.ts:821` | stateful-but-local | no |
| `recall_memories` | `server.ts:848` | stateful-but-local | no |
| `get_boot_briefing` | `server.ts:866` | stateful-but-local | no |
| `promote_memory` | `server.ts:897` | stateful-but-local | no |
| `pin_memory` | `server.ts:909` | stateful-but-local | no |
| `challenge_memory` | `server.ts:922` | stateful-but-local | no |
| `supersede_memory` | `server.ts:951` | stateful-but-local | no |
| `interrupt_agent` | `server.ts:981` | side-effectful | yes |
| `write_status` | `server.ts:1004` | stateful-but-local | no |
| `read_status` | `server.ts:1023` | read-only | no |
| `clear_status` | `server.ts:1054` | stateful-but-local | no |
| `query_audit_log` | `server.ts:1083` | read-only | no |

**Notes:**
- `claim_task` is not local-only: it posts to Telegram at `server.ts:476`, so it needs an intent row.
- `send_note` is not local-only: it posts to Telegram at `server.ts:541`, so it needs an intent row.
- `get_boot_briefing` writes audit at `server.ts:883` but stays out of `task_intents` because it has no external side effect.
- `write_status` and `clear_status` are stateful local filesystem operations, not external side effects.

### Exact watchdog replacement

Add `runWatchdogPass()` above `watchdog.ts:55`, then replace the main block beginning at `watchdog.ts:55`:

```ts
export async function runWatchdogPass(
  taskDb: TaskDB,
  audit: AuditLog,
  deps = { nudgeAgent, postToGroup, checkDeadSessions },
) {
  const rawDb = (taskDb as any).db

  const stale = rawDb.prepare(`
    SELECT * FROM tasks
    WHERE status = 'in_progress'
      AND heartbeat_at IS NOT NULL
      AND heartbeat_at <= datetime('now', '-2 minutes')
      AND nudge_count = 0
  `).all() as Task[]

  for (const task of stale) {
    await deps.nudgeAgent(task.to_agent, `⏰ Task #${task.id} has missed heartbeats for 2+ minutes. Send a note if blocked.`)
    incrementNudgeCount(taskDb, task.id)
    audit.log('watchdog', 'watchdog_nudge', { task_id: task.id, phase: 'stale' }, task.id)
  }

  const warned = rawDb.prepare(`
    SELECT * FROM tasks
    WHERE status = 'in_progress'
      AND heartbeat_at IS NOT NULL
      AND heartbeat_at <= datetime('now', '-5 minutes')
      AND nudge_count = 1
  `).all() as Task[]

  for (const task of warned) {
    await deps.nudgeAgent(task.to_agent, `⚠️ Task #${task.id} has missed heartbeats for 5+ minutes. If you still own it, report now before watchdog requeues it.`)
    incrementNudgeCount(taskDb, task.id)
    audit.log('watchdog', 'watchdog_nudge', { task_id: task.id, phase: 'warn' }, task.id)
  }

  let reclaimed = 0
  const expired = rawDb.prepare(`
    SELECT * FROM tasks
    WHERE status = 'in_progress'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= datetime('now')
  `).all() as Task[]

  for (const task of expired) {
    const reopened = taskDb.requeueExpiredTask(task.id, task.claim_epoch)
    if (!reopened) continue
    reclaimed += 1
    audit.log('watchdog', 'task_requeued', {
      task_id: task.id,
      previous_epoch: task.claim_epoch,
      new_epoch: reopened.claim_epoch,
    }, task.id)
    await deps.nudgeAgent(task.to_agent, `♻️ Task #${task.id} lease expired and it has been re-queued. Re-claim it before resuming.`)
    await deps.postToGroup(`♻️ Task #${task.id} for ${task.to_agent} was re-queued after lease expiry.`)
  }

  const unclaimed = findUnclaimedTasks(taskDb, 15)
  for (const task of unclaimed) {
    await deps.nudgeAgent(task.to_agent, `📬 Reminder: Task #${task.id} is still pending: ${task.description}`)
    audit.log('watchdog', 'watchdog_nudge', { task_id: task.id, phase: 'pending' }, task.id)
  }

  await deps.checkDeadSessions(audit)
  return { stale: stale.length, warned: warned.length, reclaimed, unclaimed: unclaimed.length }
}

const isMainScript = process.argv[1]?.endsWith('watchdog.ts')
if (isMainScript) {
  const taskDb = new TaskDB(DB_PATH)
  const audit = new AuditLog(taskDb)

  try {
    console.log(`[${new Date().toISOString()}] Watchdog running...`)
    const counts = await runWatchdogPass(taskDb, audit)
    console.log(`  Done. Stale: ${counts.stale}, Warned: ${counts.warned}, Reclaimed: ${counts.reclaimed}, Unclaimed: ${counts.unclaimed}`)
  } finally {
    taskDb.close()
  }
}
```

This deliberately removes the old boss auto-escalation path from `watchdog.ts:80–89`. The reclaim model replaces escalation.

### Recovery-aware get_boot_briefing

Keep `MemoryDB.getBootBriefing()` at `memory.ts:301` unchanged. Layer recovery text in the handler at `server.ts:866` so reclaim ownership stays in `watchdog.ts`, not in boot.

Insert immediately after `const sections: string[] = []`:

```ts
const recoveryTasks = db
  .listTasks({ assignee: SELF_LABEL })
  .filter((task) =>
    (task.status === 'pending' || task.status === 'in_progress') &&
    (task.claim_epoch ?? 0) > 0,
  )
  .slice(0, 5)

if (recoveryTasks.length > 0) {
  sections.push(
    '== RECOVERY ==\n' +
      recoveryTasks
        .map((task) =>
          task.status === 'pending'
            ? `#${task.id} was reclaimed after lease expiry and is pending again. Re-claim it before resuming: ${task.description}`
            : `#${task.id} is still marked in_progress until ${task.lease_expires_at ?? 'unknown'}. This boot does not auto-resume the lease; wait for watchdog to requeue it before claiming again if ownership is uncertain.`,
        )
        .join('\n'),
  )
}
```

Also extend the audit payload at `server.ts:883` with `recovery_count: recoveryTasks.length`.

### Smoke test

Append after `tests/watchdog.test.ts:64`. Uses the new `runWatchdogPass()` helper so it stays in-process — no tmux, no Telegram.

```ts
test('expired lease is reclaimed and appears in the boot recovery set', async () => {
  const task = taskDb.createTask({ from: 'boss', to: 'steve', description: 'recover me', priority: 'normal' })
  const claimed = taskDb.claimTask(task.id, 'steve', 60)
  expect(claimed).toBeTruthy()

  const rawDb = (taskDb as any).db
  rawDb.prepare(
    "UPDATE tasks SET heartbeat_at = datetime('now', '-6 minutes'), lease_expires_at = datetime('now', '-1 minute') WHERE id = ?",
  ).run(task.id)

  await runWatchdogPass(taskDb, audit, {
    nudgeAgent: async () => ({ ok: true }),
    postToGroup: async () => undefined,
    checkDeadSessions: async () => undefined,
  })

  const reopened = taskDb.getTask(task.id)!
  expect(reopened.status).toBe('pending')
  expect(reopened.claim_epoch).toBeGreaterThan(claimed!.claim_epoch)

  const recovery = taskDb
    .listTasks({ assignee: 'steve' })
    .filter((entry) => entry.status === 'pending' && (entry.claim_epoch ?? 0) > 0)
    .map((entry) => `#${entry.id} was reclaimed after lease expiry and is pending again.`)
    .join('\n')

  expect(recovery).toContain(`#${task.id}`)
  expect(recovery).toContain('reclaimed')
})
```

Also rewrite the existing stale-task tests at `tests/watchdog.test.ts:21` and `:32` so they mutate `heartbeat_at` instead of `claimed_at`, and drop the `determineAction()` tests if that helper is removed.

### Rollback notes

- **Safe code-only rollback:** reverting `server.ts`, `watchdog.ts`, `config.ts`, and test changes is straightforward. Leaving the new columns and `task_intents` table in place does not break the old code.
- **Safe schema-forward rollback:** you can stop using `claim_epoch`, `heartbeat_at`, `lease_expires_at`, and `task_intents` without deleting them.
- **Not safely reversible without data loss:** removing `task_intents` or deleting the new task columns after migration requires a SQLite table rebuild and would discard intent history and lease metadata.
- **Legacy in-progress rows:** the migration backfills `claim_epoch`, `heartbeat_at`, and `lease_expires_at`, so rolling back the code after migration still leaves those rows intact; no task loss.

### Explicitly NOT doing in this pass

- Not switching away from tmux to one-LaunchAgent-per-agent. Council called that a minority fallback.
- Not adding boot-time auto-reclaim. `get_boot_briefing` only reports recovery state; `watchdog.ts` remains the sole reclaim owner.
- Not wrapping local-only tools (`save_memory`, `submit_position`, `write_status`, `clear_status`) in `task_intents` — would expand the intent table beyond the council's side-effect scope.
- Not pushing busy logging into `memory.ts`, `decision.ts`, or `audit.ts` — they bypass `TaskDB` today and that is a wider DB access refactor.
- Not changing the documented 5-minute watchdog cadence in this pass. With the docs at `docs/2026-04-01-observability-watchdog-onboarding.md:91`, the 2-minute stale threshold will be approximate until the LaunchAgent interval is tightened.
- Did not assume a stable MCP SDK request id — `node_modules` was not present at plan time and runtime type was not verifiable. First pass uses a recent-window dedupe key inside `task_intents`, not a forever-unique request id scheme.
- No edits planned against the mirrored `mcp-servers/task-board/*` subtree — root `~/threadwork/` files only.

---

## Pipeline metadata

- **Phase 1 (freshen):** Read `db.ts`, `decision.ts`, `config.ts`, `watchdog.ts`, `docs/boot-sequence.md`, `server.ts:1-120`. Confirmed code state matches prior memory.
- **Phase 2 (council):** `bash ~/.claude/scripts/council-preset.sh balanced ...` — 23,027 tokens, 7 API calls, JSON at `/tmp/threadwork-council.json`.
- **Phase 3 (Codex):** `mcp__codex__codex` (read-only sandbox, never approval), thread `019d68bf-72a9-77e0-a56f-1c97dc4b343b`. Cwd `~/threadwork/`.
- **Total wall time:** ~7 minutes (council 5min, Codex 2min).
