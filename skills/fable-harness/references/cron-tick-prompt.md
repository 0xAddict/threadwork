# Cron Tick Prompt — harness-contract (v2, hardened)

This is the prompt body for the recurring `*/3 * * * *` cron created via CronCreate. It's not a shell script — it's a Claude prompt that the harness session re-enters every 3 min to advance the state machine. The cron self-deletes on PASS or at tick-budget exhaustion.

**v2 changes from v1** (from iter-2 retrospective 2026-05-20):
- Cron may not fire if REPL is busy with Monitor events — see Monitor-cron coupling note in SKILL.md. Tune Monitor accordingly.
- Verifier-death detection: tick now calls TaskList to check Verifier liveness; re-spawns if dead instead of SendMessage to a dead agent.
- Directive unstick: Branch (c) diffs contract criteria against artifacts-on-disk and tells Generator the highest-weight unstarted criterion.
- Amendment workflow: tick recognizes "FAIL but artifact verified out-of-band" and surfaces it for orchestrator amendment instead of looping Generator-retry.
- Telegram escalation: terminal/escalation paths use `mcp__claude_ai_Telegram__Telegram_Execute_Tool` (Xavier's Telegram MCP) NOT plain text — Xavier asleep should still get the ping.
- tick-count is initialized (touched) at first tick; missing file is an error, not silent zero.

## Substitution

Replace these placeholders before passing to CronCreate:

- `{SPRINT_DIR}` → absolute path to `.harness/sprints/sprint-N/`
- `{THRESHOLD_M}` → total must_pass count from the contract
- `{THRESHOLD_N}` → minimum PASS count (typically `ceil(0.98 * M)`)
- `{GENERATOR_AGENT_NAME}` → agent name passed to Agent() spawn
- `{VERIFIER_AGENT_NAME}` → ditto
- `{DECISION_LOG_PATH}` → absolute path to `.harness/decision-log.md`
- `{CONTRACT_PATH}` → absolute path to `approved-contract.md`
- `{TICK_BUDGET}` → max ticks before escalation (default 6; scale up for >15-min sprints)
- `{TELEGRAM_CHAT_ID}` → Xavier's Telegram chat id (or leave as `default` to use Telegram MCP default routing)
- `{CODEX_VERIFY}` → `true` or `false`
- `{CODEX_PROMPT_PATH}` → absolute path to rendered `codex-adversarial-prompt.md` when `{CODEX_VERIFY}=true`

## The tick prompt body (paste into CronCreate `prompt:`)

```
/harness-contract-tick (v2):

1. Read {SPRINT_DIR}/status.txt. Let CUR = trimmed contents (one of:
   implementing, ready_for_evaluation, PASS X/M, FAIL X/M, BLOCKED, TIMEOUT,
   AWAITING_AMENDMENT, AWAITING_CODEX_VERIFY).

2. Tick-count bookkeeping:
   - If {SPRINT_DIR}/tick-count.txt does not exist, this is tick 1: write "1"
     to the file. Otherwise read, increment by 1, write back.
   - Let T = new tick count.

3. Branch on CUR:

   a) CUR matches "PASS X/M" with X >= {THRESHOLD_N}:
      - If {CODEX_VERIFY} is true AND {SPRINT_DIR}/codex-adversarial-report.md
        does not contain "ADVERSARIAL PASS":
          i. Write "AWAITING_CODEX_VERIFY" to status.txt.
          ii. Call the Codex MCP with the rendered prompt at {CODEX_PROMPT_PATH}.
              The Codex verifier must write {SPRINT_DIR}/codex-adversarial-report.md.
          iii. Do NOT CronDelete. Allow next tick.
          iv. Stop.
      - CronDelete on this cron job's own ID.
      - Append to {DECISION_LOG_PATH}:
          ## Sprint passed at tick T — auto-CronDelete
          score: X/M, ts: <ISO8601>
      - Telegram: mcp__claude_ai_Telegram__Telegram_Execute_Tool send_message
        chat={TELEGRAM_CHAT_ID}, text:
          "✅ Harness PASS X/M at tick T. Evidence: {SPRINT_DIR}/verifier-report.md"
      - Also notify in conversation: one-line summary.
      - Stop.

   b) CUR matches "PASS X/M" with X < {THRESHOLD_N}, OR CUR starts with "FAIL":
      - Read {SPRINT_DIR}/verifier-report.md. Identify which criteria failed.
      - For each failing criterion: check whether the artifact actually
        satisfies the description (read the file, eyeball the content). If
        artifact looks correct but verifier_check command is buggy (e.g.
        markdown-escape leakage, wrong path, ERE-vs-BRE confusion), this is a
        SPEC defect not artifact defect — write CUR = "AWAITING_AMENDMENT" to
        status.txt, append to decision-log: "Tick T: detected spec defect in
        <criterion>, awaiting orchestrator amendment", Telegram alert Xavier
        with the specific bug. Do NOT bounce Generator on a spec defect.
      - Otherwise (artifact defect): TaskList to check if {GENERATOR_AGENT_NAME}
        is still alive (status != completed/failed). If alive: SendMessage with
        the FAIL score + verifier-report.md path + specific criteria to fix.
        If dead: re-spawn Generator (Agent with subagent_type general-purpose,
        model opus, thinking high, run_in_background true) with a "resume sprint
        at iter T+1" prompt that reads the contract + verifier-report + fixes only
        the FAILing criteria.
      - Do NOT CronDelete. Allow next tick.

   c) CUR == "implementing":
      - Check mtime of {SPRINT_DIR}/implementation-log.md.
      - If age > 480s (8 min):
        i.  Read {CONTRACT_PATH}. List the must_pass criteria.
        ii. Run each criterion's verifier_check. Identify the highest-weight
            criterion that still FAILs (or has no artifact on disk).
        iii. SendMessage to {GENERATOR_AGENT_NAME}: "No log progress in 8+ min.
             Run the verifier_checks yourself — they show <PASS_COUNT>/<TOTAL>
             passing. Highest-weight outstanding criterion is <ID>:
             <description>. Pivot to that now. If truly blocked, write
             BLOCKED: <reason> to status.txt."
        iv. If Generator is dead per TaskList, re-spawn it with the same
            directive.
      - Else (log fresh): nothing.

   d) CUR == "ready_for_evaluation":  ← PRIMARY VERIFIER SPAWN PATH
      - The Verifier is NOT spawned at launch; it is spawned HERE, the moment
        there is something to grade. This is the grade-now design (no polling
        verifier — see SKILL.md moving-part #2 root cause).
      - If {SPRINT_DIR}/verifier-report.md does not exist:
        i.  If no Verifier has been spawned yet for THIS ready_for_evaluation
            cycle (no live grader and no report): spawn a fresh Verifier
            (Agent, subagent_type general-purpose, model fable,
            run_in_background true) with the GRADE-NOW prompt from
            assets/templates/verifier-prompt.md (status is already
            ready_for_evaluation → it grades immediately and exits, NO poll
            loop). Name it {VERIFIER_AGENT_NAME} (suffix b/c/… on re-spawn).
        ii. If a Verifier was already spawned this cycle but the report is
            still missing AND T has advanced ≥2 ticks since: it likely died
            mid-grade — re-spawn a fresh grade-now Verifier (same prompt).
      - Else (report exists): nothing — next tick reads the PASS/FAIL it wrote.
      - NOTE: do NOT spawn a "persistent-poll" verifier. Always grade-now.
        The orchestrator may also spawn the grade-now Verifier directly when
        the Monitor emits the ready_for_evaluation transition; whichever fires
        first wins, and the guard at the top of the verifier prompt makes a
        duplicate exit harmlessly if a report already exists.

   e) CUR starts with "BLOCKED" or "TIMEOUT":
      - CronDelete self.
      - Telegram alert: "❌ Harness blocked at tick T: <CUR>. See
        {SPRINT_DIR}/verifier-report.md and implementation-log.md."
      - Also one-line in conversation.
      - Stop.

   f) CUR == "AWAITING_AMENDMENT":
      - Telegram alert: "⚠️ Sprint awaits orchestrator amendment. See
        decision-log.md last entry for the spec defect."
      - Do NOT CronDelete — orchestrator can amend, then write 'implementing'
        or 'ready_for_evaluation' back to status.txt and the cron resumes.
      - If T > {TICK_BUDGET} while in AWAITING_AMENDMENT, escalate via the tick budget guard.

   g) CUR == "AWAITING_CODEX_VERIFY":
      - If {SPRINT_DIR}/codex-adversarial-report.md contains "ADVERSARIAL PASS":
        i. Read verifier-report.md to recover the normal Verifier score X/M.
        ii. Write "PASS X/M" back to status.txt.
        iii. Append to decision-log: "Tick T: Codex adversarial verification passed; restored PASS X/M".
        iv. Do NOT CronDelete in this branch; branch (a) will delete on the next tick.
      - If codex-adversarial-report.md contains "ADVERSARIAL FAIL" (the red team
        broke the build):
        i. Write "FAIL 0/{THRESHOLD_M}" to status.txt so the FAIL branch (b)
           bounces the Generator on the next tick.
        ii. SendMessage {GENERATOR_AGENT_NAME} (re-spawn if dead, model opus,
            thinking high) with the codex-adversarial-report.md path and the
            specific defect(s) Codex found — those are now the criteria to fix.
        iii. Telegram alert with the report path: the hostile Codex gate failed
             the build and it is back in the Generator loop.
      - If the report is missing or inconclusive, call the Codex MCP again with {CODEX_PROMPT_PATH}, then wait for next tick.

4. Tick budget guard:
   - If T >= {TICK_BUDGET} and no PASS reached:
     - CronDelete self.
     - Telegram alert: "🛑 Harness exhausted tick budget ({TICK_BUDGET}×3min) without PASS. Last status: CUR. Manual review: {SPRINT_DIR}/"
     - Also one-line in conversation.
   - Stop.

5. End of tick. Do not start side projects. Do not write files outside
   {SPRINT_DIR}/ except for the Telegram MCP call.
```

## Telegram escalation pattern

The tick uses `mcp__claude_ai_Telegram__Telegram_Execute_Tool` (Xavier's Telegram MCP) for ALL terminal/escalation paths. Reaching Xavier when he's asleep matters more than conversation tidiness. Routine in-conversation notifications (status changes mid-sprint) stay in the chat; terminal events (PASS, FAIL, BLOCKED, TIMEOUT, AMENDMENT) also go to Telegram.

Inline input requests (e.g. "I need a credential to continue") also use Telegram — the bot has a reply path so Xavier can answer from mobile without returning to the laptop.

## Why the cron is the only thing that deletes itself

Monitor is a long-lived stream observer with a finite timeout — it'll die on its own. Cron is recurring and would survive across sessions otherwise. Always let the Cron be the actor that calls CronDelete on its own ID, never the Monitor.

## Why the cron may not fire (REPL-idle coupling)

CronCreate jobs only fire "while the REPL is idle (not mid-query)". If the Monitor recipe is emitting events every 30s (default stall threshold 360s in the old recipe), the REPL is constantly being asked to handle them and the cron's slot rarely opens. For sprints expected to run >15 min:

- Raise Monitor stall threshold to 600s+ (10 min) — see references/monitor-recipe.sh v2 for the updated default.
- Or skip Monitor entirely — let the cron be the sole observer.
- Orchestrator should plan to do periodic manual `cat status.txt` if neither Monitor nor cron is firing.
