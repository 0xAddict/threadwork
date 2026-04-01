import { describe, test, expect, beforeEach } from 'bun:test'
import { unlinkSync } from 'fs'
import { TaskDB } from '../db'
import { DecisionDB } from '../decision'

const TEST_DB = '/tmp/decision-test.db'

describe('DecisionDB', () => {
  let taskDb: TaskDB
  let decisions: DecisionDB

  beforeEach(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(TEST_DB + suffix) } catch {}
    }
    taskDb = new TaskDB(TEST_DB)
    decisions = new DecisionDB(taskDb)
  })

  test('decision lifecycle records positions and critiques before finalization', () => {
    const decision = decisions.createDecision({
      title: 'Weekend promo depth',
      description: 'Should we run 15% or 25% for the spring clearance push?',
      createdBy: 'boss',
      priority: 'high',
    })

    const steve = decisions.submitPosition({
      decisionId: decision.id,
      agent: 'steve',
      stance: 'proposal',
      summary: 'Run 15% and support it with bundles',
      rationale: 'This protects margin while still giving the campaign a hook.',
      confidence: 0.72,
      evidence: 'Historical conversion lift on bundled offers',
    })
    const sadie = decisions.submitPosition({
      decisionId: decision.id,
      agent: 'sadie',
      stance: 'risk',
      summary: 'Avoid 25% unless aging inventory justifies it',
      rationale: 'Deep discounting could train customers to wait and compress contribution margin.',
      confidence: 0.83,
    })

    expect(steve).not.toBeNull()
    expect(sadie).not.toBeNull()

    const critique = decisions.critiquePosition({
      decisionId: decision.id,
      positionId: steve!.id,
      agent: 'kiera',
      dimension: 'evidence',
      summary: 'Bundle performance was measured during a different traffic mix.',
      severity: 'medium',
      confidence: 0.76,
    })

    expect(critique).not.toBeNull()

    const finalized = decisions.finalizeDecision({
      decisionId: decision.id,
      finalSummary: 'Use 15% with bundles and reassess after day one.',
      finalRationale: 'It balances conversion upside with margin protection under uncertain demand.',
      finalConfidence: 0.78,
      chosenPositionId: steve!.id,
    })

    expect(finalized).not.toBeNull()
    expect(finalized!.status).toBe('decided')

    const brief = decisions.getDecisionBrief(decision.id)
    expect(brief).not.toBeNull()
    expect(brief!.positions).toHaveLength(2)
    expect(brief!.critiques).toHaveLength(1)
  })

  test('an agent cannot critique its own position', () => {
    const decision = decisions.createDecision({
      title: 'Homepage badge copy',
      description: 'Should the PDP badge emphasize speed or guarantee?',
      createdBy: 'boss',
    })

    const position = decisions.submitPosition({
      decisionId: decision.id,
      agent: 'snoopy',
      stance: 'evidence',
      summary: 'Emphasize the guarantee because support tickets cite hesitation.',
      rationale: 'Customers seem more worried about trust than shipping speed.',
      confidence: 0.68,
    })

    expect(position).not.toBeNull()

    const critique = decisions.critiquePosition({
      decisionId: decision.id,
      positionId: position!.id,
      agent: 'snoopy',
      summary: 'This should fail.',
      confidence: 0.9,
    })

    expect(critique).toBeNull()
  })
})
