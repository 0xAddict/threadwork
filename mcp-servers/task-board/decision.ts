import type { Database } from 'bun:sqlite'
import type { TaskDB } from './db'

export interface Decision {
  id: number
  title: string
  description: string
  created_by: string
  priority: string
  status: 'open' | 'in_review' | 'decided' | 'cancelled'
  final_summary: string | null
  final_rationale: string | null
  final_confidence: number | null
  chosen_position_id: number | null
  created_at: string
  updated_at: string
  closed_at: string | null
}

export interface DecisionPosition {
  id: number
  decision_id: number
  agent: string
  stance: string
  summary: string
  rationale: string
  confidence: number
  evidence: string | null
  status: 'active' | 'superseded' | 'withdrawn'
  created_at: string
}

export interface DecisionCritique {
  id: number
  decision_id: number
  position_id: number
  agent: string
  dimension: string
  summary: string
  severity: string
  confidence: number
  created_at: string
}

export interface CreateDecisionInput {
  title: string
  description: string
  createdBy: string
  priority?: string
}

export interface SubmitPositionInput {
  decisionId: number
  agent: string
  stance: string
  summary: string
  rationale: string
  confidence: number
  evidence?: string
}

export interface CritiquePositionInput {
  decisionId: number
  positionId: number
  agent: string
  dimension?: string
  summary: string
  severity?: string
  confidence: number
}

export interface FinalizeDecisionInput {
  decisionId: number
  finalSummary: string
  finalRationale: string
  finalConfidence: number
  chosenPositionId?: number
}

export interface DecisionBrief {
  decision: Decision
  positions: DecisionPosition[]
  critiques: DecisionCritique[]
}

export class DecisionDB {
  private db: Database

  constructor(taskDb: TaskDB) {
    this.db = (taskDb as any).db
  }

  createDecision(input: CreateDecisionInput): Decision {
    return this.db.prepare(`
      INSERT INTO decisions (title, description, created_by, priority)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `).get(
      input.title,
      input.description,
      input.createdBy,
      input.priority ?? 'normal',
    ) as Decision
  }

  getDecision(id: number): Decision | null {
    return this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Decision | null
  }

  listDecisions(filter: { status?: string; createdBy?: string; limit?: number } = {}): Decision[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.status) {
      conditions.push('status = ?')
      params.push(filter.status)
    }
    if (filter.createdBy) {
      conditions.push('created_by = ?')
      params.push(filter.createdBy)
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
    const limit = filter.limit ?? 20

    return this.db.prepare(
      `SELECT * FROM decisions${where} ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
    ).all(...params, limit) as Decision[]
  }

  submitPosition(input: SubmitPositionInput): DecisionPosition | null {
    const decision = this.getDecision(input.decisionId)
    if (!decision || decision.status === 'decided' || decision.status === 'cancelled') {
      return null
    }

    this.db.prepare(`
      UPDATE decision_positions
      SET status = 'superseded'
      WHERE decision_id = ? AND agent = ? AND status = 'active'
    `).run(input.decisionId, input.agent)

    const position = this.db.prepare(`
      INSERT INTO decision_positions (decision_id, agent, stance, summary, rationale, confidence, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      input.decisionId,
      input.agent,
      input.stance,
      input.summary,
      input.rationale,
      input.confidence,
      input.evidence ?? null,
    ) as DecisionPosition

    this.db.prepare(`
      UPDATE decisions
      SET status = CASE WHEN status = 'open' THEN 'in_review' ELSE status END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(input.decisionId)

    return position
  }

  critiquePosition(input: CritiquePositionInput): DecisionCritique | null {
    const decision = this.getDecision(input.decisionId)
    if (!decision || decision.status === 'decided' || decision.status === 'cancelled') {
      return null
    }

    const position = this.db.prepare(
      'SELECT * FROM decision_positions WHERE id = ? AND decision_id = ?',
    ).get(input.positionId, input.decisionId) as DecisionPosition | null

    if (!position || position.agent === input.agent) {
      return null
    }

    const critique = this.db.prepare(`
      INSERT INTO decision_critiques (decision_id, position_id, agent, dimension, summary, severity, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      input.decisionId,
      input.positionId,
      input.agent,
      input.dimension ?? 'contrarian',
      input.summary,
      input.severity ?? 'medium',
      input.confidence,
    ) as DecisionCritique

    this.db.prepare('UPDATE decisions SET updated_at = datetime(\'now\') WHERE id = ?').run(input.decisionId)
    return critique
  }

  finalizeDecision(input: FinalizeDecisionInput): Decision | null {
    const decision = this.getDecision(input.decisionId)
    if (!decision || decision.status === 'cancelled' || decision.status === 'decided') {
      return null
    }

    const activePositions = this.db.prepare(`
      SELECT id FROM decision_positions WHERE decision_id = ? AND status = 'active'
    `).all(input.decisionId) as { id: number }[]

    if (activePositions.length === 0) {
      return null
    }

    if (input.chosenPositionId) {
      const chosen = this.db.prepare(`
        SELECT id FROM decision_positions WHERE id = ? AND decision_id = ? AND status = 'active'
      `).get(input.chosenPositionId, input.decisionId) as { id: number } | null

      if (!chosen) {
        return null
      }
    }

    return this.db.prepare(`
      UPDATE decisions
      SET status = 'decided',
          final_summary = ?,
          final_rationale = ?,
          final_confidence = ?,
          chosen_position_id = ?,
          updated_at = datetime('now'),
          closed_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `).get(
      input.finalSummary,
      input.finalRationale,
      input.finalConfidence,
      input.chosenPositionId ?? null,
      input.decisionId,
    ) as Decision
  }

  getDecisionBrief(decisionId: number): DecisionBrief | null {
    const decision = this.getDecision(decisionId)
    if (!decision) {
      return null
    }

    const positions = this.db.prepare(`
      SELECT * FROM decision_positions
      WHERE decision_id = ?
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, confidence DESC, created_at ASC
    `).all(decisionId) as DecisionPosition[]

    const critiques = this.db.prepare(`
      SELECT * FROM decision_critiques
      WHERE decision_id = ?
      ORDER BY severity DESC, confidence DESC, created_at ASC
    `).all(decisionId) as DecisionCritique[]

    return { decision, positions, critiques }
  }
}
