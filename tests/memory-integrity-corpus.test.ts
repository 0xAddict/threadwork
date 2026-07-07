// P4 — Anti-laundering memory sanitization, Stage 1 (#10376048).
// ATM-005 / ATM-031: corpus-level precision/recall proof.
//  - 20+/20+ adversarial fixtures -> neutralized===true, tripped includes expectedPatternId.
//  - 50+/50+ legitimate fixtures -> neutralized===false, text byte-identical to input.

import { describe, test, expect } from 'bun:test'
import { sanitizeMemoryContent } from '../memory-integrity'
import type { SourceType } from '../memory'
import adversarialCorpus from './fixtures/adversarial-memory-corpus.json'
import legitimateCorpus from './fixtures/legitimate-memory-corpus.json'

interface AdversarialEntry {
  content: string
  expectedPatternId: string
  sourceType: SourceType
}

interface LegitimateEntry {
  content: string
  sourceType: SourceType
}

describe('adversarial-memory-corpus.json (ATM-031)', () => {
  const entries = adversarialCorpus as AdversarialEntry[]

  test('fixture has at least 20 entries', () => {
    expect(entries.length).toBeGreaterThanOrEqual(20)
  })

  for (const [i, entry] of entries.entries()) {
    test(`[${i}] "${entry.content.slice(0, 50)}" neutralizes and trips ${entry.expectedPatternId}`, () => {
      const result = sanitizeMemoryContent(entry.content, { sourceType: entry.sourceType })
      expect(result.neutralized).toBe(true)
      expect(result.tripped).toBeDefined()
      expect(result.tripped).toContain(entry.expectedPatternId)
    })
  }

  test('every entry in the corpus neutralizes (aggregate 20/20 or more)', () => {
    let passCount = 0
    for (const entry of entries) {
      const result = sanitizeMemoryContent(entry.content, { sourceType: entry.sourceType })
      if (result.neutralized && result.tripped?.includes(entry.expectedPatternId)) passCount++
    }
    expect(passCount).toBe(entries.length)
  })
})

describe('legitimate-memory-corpus.json (ATM-005)', () => {
  const entries = legitimateCorpus as LegitimateEntry[]

  test('fixture has at least 50 entries', () => {
    expect(entries.length).toBeGreaterThanOrEqual(50)
  })

  for (const [i, entry] of entries.entries()) {
    test(`[${i}] "${entry.content.slice(0, 50)}" is untouched (no false positive)`, () => {
      const result = sanitizeMemoryContent(entry.content, { sourceType: entry.sourceType })
      expect(result.neutralized).toBe(false)
      expect(result.text).toBe(entry.content)
      expect(result.tripped).toBeUndefined()
    })
  }

  test('every entry in the corpus is byte-identical and unflagged (aggregate 50/50 or more)', () => {
    let passCount = 0
    for (const entry of entries) {
      const result = sanitizeMemoryContent(entry.content, { sourceType: entry.sourceType })
      if (!result.neutralized && result.text === entry.content) passCount++
    }
    expect(passCount).toBe(entries.length)
  })
})
