import { describe, test, expect } from 'bun:test'
import { AGENT_SESSIONS, assertAgentIdentityOrThrow } from '../config'

describe('assertAgentIdentityOrThrow', () => {
  test('throws when label is "unknown"', () => {
    // Pure helper — does not rely on process.env.AGENT_LABEL state, which is
    // captured by SELF_LABEL at module load and cannot be mutated by tests.
    // This makes the test robust in agent-runtime environments where
    // AGENT_LABEL is exported by the tmux session.
    expect(() => assertAgentIdentityOrThrow('unknown')).toThrow(
      'FATAL: AGENT_LABEL env var not set',
    )
  })

  test('does not throw for valid agent labels', () => {
    for (const agent of Object.keys(AGENT_SESSIONS)) {
      expect(() => assertAgentIdentityOrThrow(agent)).not.toThrow()
    }
  })

  test('does not throw for any non-"unknown" string', () => {
    // The contract is: reject the sentinel 'unknown' fallback. Any other
    // label is trusted — the caller is responsible for validating labels
    // against AGENT_SESSIONS if stricter behavior is needed.
    expect(() => assertAgentIdentityOrThrow('boss')).not.toThrow()
    expect(() => assertAgentIdentityOrThrow('steve')).not.toThrow()
  })

  test('AGENT_SESSIONS is non-empty and contains boss', () => {
    const validAgents = Object.keys(AGENT_SESSIONS)
    expect(validAgents.length).toBeGreaterThan(0)
    expect(validAgents).toContain('boss')
  })
})
