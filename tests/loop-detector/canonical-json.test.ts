/**
 * C2.7 — Tool-call canonicalization: args {a:1, b:2} vs {b:2, a:1} produce IDENTICAL signature/hash
 */
import { describe, it, expect } from 'bun:test'
import { computeToolCallSignature, canonicalJson } from '../../src/loop-detector/index'

describe('C2.7 — Tool-call canonicalization', () => {
  it('produces identical canonical JSON for objects with same keys in different order', () => {
    const a = canonicalJson({ a: 1, b: 2 })
    const b = canonicalJson({ b: 2, a: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":1,"b":2}')
  })

  it('produces identical tool call signatures for semantically identical args', () => {
    const sig1 = computeToolCallSignature('write_status', { agent: 'boss', status: 'ok', detail: 'working' })
    const sig2 = computeToolCallSignature('write_status', { detail: 'working', status: 'ok', agent: 'boss' })
    expect(sig1).toBe(sig2)
  })

  it('produces different signatures for different tool names', () => {
    const sig1 = computeToolCallSignature('write_status', { a: 1 })
    const sig2 = computeToolCallSignature('read_status', { a: 1 })
    expect(sig1).not.toBe(sig2)
  })

  it('produces different signatures for different args', () => {
    const sig1 = computeToolCallSignature('write_status', { a: 1 })
    const sig2 = computeToolCallSignature('write_status', { a: 2 })
    expect(sig1).not.toBe(sig2)
  })

  it('handles nested object sorting', () => {
    const a = canonicalJson({ z: { y: 1, x: 2 }, a: [3, 1, 2] })
    const b = canonicalJson({ a: [3, 1, 2], z: { x: 2, y: 1 } })
    expect(a).toBe(b)
  })
})
