# Sprint 4 Implementation Log — Circuit Breakers + Session Recovery

## Date: 2026-04-08

## Deliverables

### 1. Circuit breaker columns on agent_sessions (db.ts)
Added 6 columns via safe ALTER TABLE migration:
- circuit_state TEXT DEFAULT 'closed' (closed/open/half_open)
- fault_count INTEGER DEFAULT 0
- last_fault_at TEXT
- last_fault_type TEXT (timeout/crash/wrong_result/protocol_violation)
- circuit_opened_at TEXT
- cooldown_until TEXT

### 2. Circuit breaker DB methods (db.ts)
- `getCircuitState(agent)` — returns current state, fault count, cooldown
- `recordFault(agent, faultType)` — increments fault_count, opens circuit at threshold (3)
- `tryHalfOpen(agent)` — transitions open->half_open if cooldown elapsed (300s default)
- `closeCircuit(agent)` — resets to closed, clears fault count
- `reopenCircuit(agent)` — transitions back to open with fresh cooldown
- `isCircuitOpen(agent)` — convenience check
- Constants: FAULT_THRESHOLD=3, COOLDOWN_SEC=300

### 3. Watchdog integration (watchdog.ts)
- `reconcileTask`: calls tryHalfOpen on each task's agent (attempts cooldown transition)
- `handleHeartbeatOverdue`: calls recordFault(agent, 'timeout'), alerts boss if circuit opens
- `handleDeadSession`: calls recordFault(agent, 'crash')
- Session checks: dead session confirmation also records crash fault and clears stale task timing

### 4. delegate_task circuit check (server.ts)
- Before delegating, checks `isCircuitOpen(to)`
- If open, returns error with fault count and cooldown info
- Prevents delegation to degraded agents

### 5. Half-open probe (server.ts complete_task)
- When a task completes for an agent in half_open state, closes the circuit
- Resets fault count to 0
- Logged to audit trail

### 6. Session recovery (watchdog.ts)
- Dead session detection clears stale next_check_at on affected tasks
- Sets next_check_at to now so watchdog picks up orphaned tasks immediately

## Test Results
- 116 pass, 16 fail (all pre-existing)
- Build: 0.63 MB, clean
- All 6 circuit breaker columns confirmed present
