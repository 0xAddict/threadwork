/**
 * C2.10 — `is_ready_for_dispatch("steve")` returns False if PARKED_PICKER; True if ALIVE
 */
import { describe, it, expect } from 'bun:test'
import { isReadyForDispatch } from '../../inhibit-engine'

describe('C2.10 — isReadyForDispatch', () => {
  it('returns false when agent state is PARKED_PICKER', () => {
    expect(isReadyForDispatch('PARKED_PICKER')).toBe(false)
  })

  it('returns false when agent state is PARKED_PICKER_STALE', () => {
    expect(isReadyForDispatch('PARKED_PICKER_STALE')).toBe(false)
  })

  it('returns false when agent state is SESSION_DEAD', () => {
    expect(isReadyForDispatch('SESSION_DEAD')).toBe(false)
  })

  it('returns false when agent state is CRASHED', () => {
    expect(isReadyForDispatch('CRASHED')).toBe(false)
  })

  it('returns true when agent state is ALIVE', () => {
    expect(isReadyForDispatch('ALIVE')).toBe(true)
  })

  it('returns true when agent state is IDLE', () => {
    expect(isReadyForDispatch('IDLE')).toBe(true)
  })

  it('returns true when agent state is STUCK (dispatch still attempted for stuck agents)', () => {
    // STUCK agents can receive nudges (the watchdog nudges them to help)
    expect(isReadyForDispatch('STUCK')).toBe(true)
  })
})
