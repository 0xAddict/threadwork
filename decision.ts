import type { TaskDB } from './db'
import type { MemoryDB, Memory } from './memory'
import { sanitizeMemoryContent } from './memory-integrity'

export type DecisionStatus = 'open' | 'positions' | 'critique' | 'finalized' | 'expired' | 'cancelled'
export type CritiqueSeverity = 'observation' | 'concern' | 'blocker'

export interface Decision {
  id: number
  title: string
  context: string | null
  opened_by: string
  status: DecisionStatus
  finalized_by: string | null
  outcome: string | null
  outcome_rationale: string | null
  expires_at: string | null
  memory_id: number | null
  task_id: number | null
  created_at: string
  updated_at: string
  finalized_at: string | null
}

export interface DecisionPosition {
  id: number
  decision_id: number
  agent: string
  position: string
  rationale: string | null
  evidence: string | null
  created_at: string
}

export interface DecisionCritique {
  id: number
  decision_id: number
  position_id: number | null
  agent: string
  critique: string
  severity: CritiqueSeverity
  created_at: string
}

export interface DecisionWithDetail extends Decision {
  positions: DecisionPosition[]
  critiques: DecisionCritique[]
}

const OPEN_STATUSES: DecisionStatus[] = ['open', 'positions', 'critique']
const TERMINAL_STATUSES: DecisionStatus[] = ['finalized', 'expired', 'cancelled']

export class DecisionDB {
  constructor(
    private taskDb: TaskDB,
    private mem: MemoryDB,
  ) {}

  openDecision(
    title: string,
    context: string | null,
    openedBy: string,
    opts?: { expiresAt?: string; taskId?: number },
  ): Decision {
    return this.taskDb.run(db => {
      const stmt = db.prepare(`
        INSERT INTO decisions (title, context, opened_by, expires_at, task_id)
        VALUES (?, ?, ?, ?, ?)
        RETURNING *
      `)
      return stmt.get(
        title,
        context ?? null,
        openedBy,
        opts?.expiresAt ?? null,
        opts?.taskId ?? null,
      ) as Decision
    })
  }

  addPosition(
    decisionId: number,
    agent: string,
    position: string,
    rationale?: string,
    evidence?: string,
  ): DecisionPosition {
    return this.taskDb.run(db => {
      const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as Decision | null
      if (!decision) throw new Error(`Decision #${decisionId} not found`)
      if (!['open', 'positions'].includes(decision.status)) {
        throw new Error(`Cannot add position to decision #${decisionId} in status '${decision.status}'`)
      }

      // Auto-transition to 'positions' if currently 'open'
      if (decision.status === 'open') {
        db.prepare("UPDATE decisions SET status = 'positions', updated_at = datetime('now') WHERE id = ?").run(decisionId)
      } else {
        db.prepare("UPDATE decisions SET updated_at = datetime('now') WHERE id = ?").run(decisionId)
      }

      const stmt = db.prepare(`
        INSERT INTO decision_positions (decision_id, agent, position, rationale, evidence)
        VALUES (?, ?, ?, ?, ?)
        RETURNING *
      `)
      return stmt.get(decisionId, agent, position, rationale ?? null, evidence ?? null) as DecisionPosition
    })
  }

  addCritique(
    decisionId: number,
    agent: string,
    critique: string,
    opts?: { positionId?: number; severity?: CritiqueSeverity },
  ): DecisionCritique {
    return this.taskDb.run(db => {
      const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as Decision | null
      if (!decision) throw new Error(`Decision #${decisionId} not found`)
      if (!['open', 'positions', 'critique'].includes(decision.status)) {
        throw new Error(`Cannot add critique to decision #${decisionId} in status '${decision.status}'`)
      }

      // Auto-transition to 'critique' if currently 'open' or 'positions'
      if (decision.status === 'open' || decision.status === 'positions') {
        db.prepare("UPDATE decisions SET status = 'critique', updated_at = datetime('now') WHERE id = ?").run(decisionId)
      } else {
        db.prepare("UPDATE decisions SET updated_at = datetime('now') WHERE id = ?").run(decisionId)
      }

      const severity = opts?.severity ?? 'observation'
      const positionId = opts?.positionId ?? null

      const stmt = db.prepare(`
        INSERT INTO decision_critiques (decision_id, position_id, agent, critique, severity)
        VALUES (?, ?, ?, ?, ?)
        RETURNING *
      `)
      return stmt.get(decisionId, positionId, agent, critique, severity) as DecisionCritique
    })
  }

  /**
   * Finalize a decision — ATOMIC.
   * Uses a single BEGIN IMMEDIATE transaction on the same db handle for:
   *   1. Status update on the decision
   *   2. Memory creation (shared, category='decision', classification='strategic')
   *   3. Linking the memory_id back to the decision
   */
  finalizeDecision(
    decisionId: number,
    finalizedBy: string,
    outcome: string,
    rationale: string,
  ): { decision: Decision; memory: Memory } {
    return this.taskDb.run(db => {
      db.prepare('BEGIN IMMEDIATE').run()
      try {
        const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as Decision | null
        if (!decision) throw new Error(`Decision #${decisionId} not found`)
        if (TERMINAL_STATUSES.includes(decision.status as DecisionStatus)) {
          throw new Error(`Cannot finalize decision #${decisionId} — already '${decision.status}'`)
        }

        // Gather positions for the memory summary
        const positions = db.prepare(
          'SELECT agent, position FROM decision_positions WHERE decision_id = ? ORDER BY created_at ASC'
        ).all(decisionId) as { agent: string; position: string }[]

        // P4 (#10376048/ATM-027): flag-gated REQ-021 two-stage sanitize for the
        // decision-finalization write-through. Flag OFF -> byte-parity with the
        // pre-P4 memoryContent assembly below (plain positionSummary, raw
        // title/outcome/rationale, hardcoded state='active', no audit row).
        // Stays entirely inside the existing BEGIN IMMEDIATE/COMMIT — no new
        // transaction/lock/ordering primitive is introduced (P5 territory).
        const sanitizeOn = this.taskDb.isFeatureEnabled('memory_sanitization_enabled')

        let agentStageNeutralized = false
        let effectiveTitle = decision.title
        let effectiveOutcome = outcome
        let effectiveRationale = rationale
        let positionSummary: string
        // REQ-016 (call-site-agnostic): aggregate every tripped pattern id
        // across all sanitize stages so we can tell, after the fact, whether
        // 'forged-trust-marker' was among them — mirrors saveMemory's ATM-019
        // audit row for this same signal.
        const allTripped: string[] = []

        if (sanitizeOn) {
          // (a) Sanitize each agent-authored fragment INDIVIDUALLY before
          // assembling anything, so forged markers/directives never survive
          // long enough to be diluted by the surrounding template text.
          const titleSr = sanitizeMemoryContent(decision.title, { sourceType: 'agent' })
          effectiveTitle = titleSr.text
          agentStageNeutralized = agentStageNeutralized || titleSr.neutralized
          allTripped.push(...(titleSr.tripped ?? []))

          const outcomeSr = sanitizeMemoryContent(outcome, { sourceType: 'agent' })
          effectiveOutcome = outcomeSr.text
          agentStageNeutralized = agentStageNeutralized || outcomeSr.neutralized
          allTripped.push(...(outcomeSr.tripped ?? []))

          const rationaleSr = sanitizeMemoryContent(rationale, { sourceType: 'agent' })
          effectiveRationale = rationaleSr.text
          agentStageNeutralized = agentStageNeutralized || rationaleSr.neutralized
          allTripped.push(...(rationaleSr.tripped ?? []))

          // (b) Attribution-fence each sanitized position line so a later
          // consumer can tell "the agent said this" from real system prose.
          const sanitizedPositions = positions.map(p => {
            const posSr = sanitizeMemoryContent(p.position, { sourceType: 'agent' })
            agentStageNeutralized = agentStageNeutralized || posSr.neutralized
            allTripped.push(...(posSr.tripped ?? []))
            return `<agent-said agent="${p.agent}">${posSr.text}</agent-said>`
          })
          positionSummary = sanitizedPositions.length > 0
            ? '\nPositions: ' + sanitizedPositions.join('; ')
            : ''
        } else {
          positionSummary = positions.length > 0
            ? '\nPositions: ' + positions.map(p => `${p.agent}: ${p.position}`).join('; ')
            : ''
        }

        let memoryContent = `Decision #${decisionId}: ${effectiveTitle}\nOutcome: ${effectiveOutcome}\nRationale: ${effectiveRationale}${positionSummary}`

        let state: 'active' | 'proposed' = 'active'
        let neutralized = agentStageNeutralized
        let systemStageNeutralized = false
        if (sanitizeOn) {
          // (c) Defense-in-depth second pass over the fully assembled content.
          const finalSr = sanitizeMemoryContent(memoryContent, { sourceType: 'system' })
          memoryContent = finalSr.text
          systemStageNeutralized = finalSr.neutralized
          allTripped.push(...(finalSr.tripped ?? []))
          neutralized = neutralized || systemStageNeutralized
          state = neutralized ? 'proposed' : 'active'
        }

        // 1. Update decision status
        db.prepare(`
          UPDATE decisions SET
            status = 'finalized',
            finalized_by = ?,
            outcome = ?,
            outcome_rationale = ?,
            finalized_at = datetime('now'),
            updated_at = datetime('now')
          WHERE id = ?
        `).run(finalizedBy, outcome, rationale, decisionId)

        // 2. Create memory (inline, same db handle — atomic)
        const memory = db.prepare(`
          INSERT INTO memories (agent, content, category, importance, pinned, classification, quality, state, source_type)
          VALUES ('shared', ?, 'decision', 4, 0, 'strategic', 0.8, ?, 'system')
          RETURNING *
        `).get(memoryContent, state) as Memory

        if (sanitizeOn && neutralized) {
          db.prepare(`
            INSERT INTO audit_log (agent, action, detail, memory_id)
            VALUES ('system', 'decision_content_sanitized', ?, ?)
          `).run(
            `finalizeDecision #${decisionId}; agent-stage=${agentStageNeutralized ? 'neutralized' : 'clean'}; system-stage=${systemStageNeutralized ? 'neutralized' : 'clean'}`,
            memory.id,
          )

          // REQ-016 (call-site-agnostic): a forged trust marker anywhere in
          // the tripped set (title/outcome/rationale/position/final pass)
          // also gets its own memory_marker_neutralized row.
          if (allTripped.includes('forged-trust-marker')) {
            db.prepare(`
              INSERT INTO audit_log (agent, action, detail, memory_id)
              VALUES ('system', 'memory_marker_neutralized', ?, ?)
            `).run(`finalizeDecision #${decisionId}; tripped=${allTripped.join(',')}`, memory.id)
          }
        }

        // 3. Link memory_id back to decision
        db.prepare('UPDATE decisions SET memory_id = ? WHERE id = ?').run(memory.id, decisionId)

        db.prepare('COMMIT').run()

        const updated = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as Decision
        return { decision: updated, memory }
      } catch (err) {
        try { db.prepare('ROLLBACK').run() } catch {}
        throw err
      }
    })
  }

  cancelDecision(decisionId: number, cancelledBy: string, reason: string): Decision {
    return this.taskDb.run(db => {
      const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as Decision | null
      if (!decision) throw new Error(`Decision #${decisionId} not found`)
      if (TERMINAL_STATUSES.includes(decision.status as DecisionStatus)) {
        throw new Error(`Cannot cancel decision #${decisionId} — already '${decision.status}'`)
      }

      db.prepare(`
        UPDATE decisions SET
          status = 'cancelled',
          outcome_rationale = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(reason, decisionId)

      return db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as Decision
    })
  }

  /**
   * Expire a decision — auto-finalize with "Expired without finalization".
   * Creates a memory (same atomic pattern as finalizeDecision).
   */
  expireDecision(decisionId: number): { decision: Decision; memory: Memory } {
    return this.taskDb.run(db => {
      db.prepare('BEGIN IMMEDIATE').run()
      try {
        const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as Decision | null
        if (!decision) throw new Error(`Decision #${decisionId} not found`)
        if (!OPEN_STATUSES.includes(decision.status as DecisionStatus)) {
          throw new Error(`Cannot expire decision #${decisionId} — status is '${decision.status}'`)
        }

        const positions = db.prepare(
          'SELECT agent, position FROM decision_positions WHERE decision_id = ? ORDER BY created_at ASC'
        ).all(decisionId) as { agent: string; position: string }[]

        // P4 (#10376048/ATM-027): same REQ-021 two-stage sanitize contract as
        // finalizeDecision — see that method for the full rationale. This path
        // has no outcome/rationale, only title + positions are agent-authored.
        const sanitizeOn = this.taskDb.isFeatureEnabled('memory_sanitization_enabled')

        let agentStageNeutralized = false
        let effectiveTitle = decision.title
        let positionSummary: string
        // REQ-016 (call-site-agnostic): see finalizeDecision for rationale.
        const allTripped: string[] = []

        if (sanitizeOn) {
          const titleSr = sanitizeMemoryContent(decision.title, { sourceType: 'agent' })
          effectiveTitle = titleSr.text
          agentStageNeutralized = agentStageNeutralized || titleSr.neutralized
          allTripped.push(...(titleSr.tripped ?? []))

          const sanitizedPositions = positions.map(p => {
            const posSr = sanitizeMemoryContent(p.position, { sourceType: 'agent' })
            agentStageNeutralized = agentStageNeutralized || posSr.neutralized
            allTripped.push(...(posSr.tripped ?? []))
            return `<agent-said agent="${p.agent}">${posSr.text}</agent-said>`
          })
          positionSummary = sanitizedPositions.length > 0
            ? '\nPositions: ' + sanitizedPositions.join('; ')
            : ''
        } else {
          positionSummary = positions.length > 0
            ? '\nPositions: ' + positions.map(p => `${p.agent}: ${p.position}`).join('; ')
            : ''
        }

        let memoryContent = `Decision #${decisionId} EXPIRED: ${effectiveTitle}\nExpired without finalization.${positionSummary}`

        let state: 'active' | 'proposed' = 'active'
        let neutralized = agentStageNeutralized
        let systemStageNeutralized = false
        if (sanitizeOn) {
          const finalSr = sanitizeMemoryContent(memoryContent, { sourceType: 'system' })
          memoryContent = finalSr.text
          systemStageNeutralized = finalSr.neutralized
          allTripped.push(...(finalSr.tripped ?? []))
          neutralized = neutralized || systemStageNeutralized
          state = neutralized ? 'proposed' : 'active'
        }

        // 1. Update decision status
        db.prepare(`
          UPDATE decisions SET
            status = 'expired',
            outcome = 'Expired without finalization',
            finalized_at = datetime('now'),
            updated_at = datetime('now')
          WHERE id = ?
        `).run(decisionId)

        // 2. Create memory
        const memory = db.prepare(`
          INSERT INTO memories (agent, content, category, importance, pinned, classification, quality, state, source_type)
          VALUES ('shared', ?, 'decision', 4, 0, 'strategic', 0.8, ?, 'system')
          RETURNING *
        `).get(memoryContent, state) as Memory

        if (sanitizeOn && neutralized) {
          db.prepare(`
            INSERT INTO audit_log (agent, action, detail, memory_id)
            VALUES ('system', 'decision_content_sanitized', ?, ?)
          `).run(
            `expireDecision #${decisionId}; agent-stage=${agentStageNeutralized ? 'neutralized' : 'clean'}; system-stage=${systemStageNeutralized ? 'neutralized' : 'clean'}`,
            memory.id,
          )

          // REQ-016 (call-site-agnostic): mirror finalizeDecision's dedicated
          // memory_marker_neutralized row when a forged trust marker tripped.
          if (allTripped.includes('forged-trust-marker')) {
            db.prepare(`
              INSERT INTO audit_log (agent, action, detail, memory_id)
              VALUES ('system', 'memory_marker_neutralized', ?, ?)
            `).run(`expireDecision #${decisionId}; tripped=${allTripped.join(',')}`, memory.id)
          }
        }

        // 3. Link memory_id
        db.prepare('UPDATE decisions SET memory_id = ? WHERE id = ?').run(memory.id, decisionId)

        db.prepare('COMMIT').run()

        const updated = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as Decision
        return { decision: updated, memory }
      } catch (err) {
        try { db.prepare('ROLLBACK').run() } catch {}
        throw err
      }
    })
  }

  getDecision(id: number): DecisionWithDetail | null {
    return this.taskDb.run(db => {
      const decision = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Decision | null
      if (!decision) return null

      const positions = db.prepare(
        'SELECT * FROM decision_positions WHERE decision_id = ? ORDER BY created_at ASC'
      ).all(id) as DecisionPosition[]

      const critiques = db.prepare(
        'SELECT * FROM decision_critiques WHERE decision_id = ? ORDER BY created_at ASC'
      ).all(id) as DecisionCritique[]

      return { ...decision, positions, critiques }
    })
  }

  getOpenDecisions(opts?: { agent?: string; taskId?: number }): Decision[] {
    return this.taskDb.run(db => {
      const conditions: string[] = ["status IN ('open', 'positions', 'critique')"]
      const params: unknown[] = []

      if (opts?.agent) {
        conditions.push('opened_by = ?')
        params.push(opts.agent)
      }
      if (opts?.taskId) {
        conditions.push('task_id = ?')
        params.push(opts.taskId)
      }

      return db.prepare(
        `SELECT * FROM decisions WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`
      ).all(...params) as Decision[]
    })
  }

  getDecisionsByStatus(status: string, limit?: number): Decision[] {
    return this.taskDb.run(db => {
      const lim = limit ?? 50
      // Special case: if status is 'open', show all open-family statuses
      if (status === 'open') {
        return db.prepare(
          "SELECT * FROM decisions WHERE status IN ('open', 'positions', 'critique') ORDER BY created_at DESC LIMIT ?"
        ).all(lim) as Decision[]
      }
      return db.prepare(
        'SELECT * FROM decisions WHERE status = ? ORDER BY created_at DESC LIMIT ?'
      ).all(status, lim) as Decision[]
    })
  }
}

/**
 * Expire stale decisions whose expires_at has passed.
 * Returns the number of decisions expired.
 */
export function expireStaleDecisions(dec: DecisionDB): number {
  let count = 0
  const open = dec.getOpenDecisions()
  const now = new Date().toISOString()
  for (const d of open) {
    if (d.expires_at && d.expires_at < now) {
      try {
        dec.expireDecision(d.id)
        count++
      } catch {
        // Already expired or in terminal state — skip
      }
    }
  }
  return count
}
