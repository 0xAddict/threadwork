/**
 * C3.2 — emit.log contract: every emission writes a JSON-line with required fields.
 */
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeEmitLog } from '../../src/alert-review/emit-log'

describe('C3.2 — emit.log contract', () => {
  it('writeEmitLog writes a JSON-line with all required fields', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'emit-log-contract-'))
    const logPath = join(tmpDir, 'emit.log')

    const alertId = writeEmitLog({
      fingerprint: 'abc123',
      severity: 'WARNING',
      agent: 'sadie',
      state: 'STUCK',
      reason_class: 'IDLE_TIMEOUT',
      destination: 'telegram',
      emit_method: 'telegram_direct',
    }, { logPath })

    const raw = readFileSync(logPath, 'utf-8').trim()
    const line = JSON.parse(raw)

    // Required fields per DoD-11 §1
    expect(typeof line.timestamp_iso).toBe('string')
    expect(typeof line.fingerprint).toBe('string')
    expect(typeof line.severity).toBe('string')
    expect(typeof line.agent).toBe('string')
    expect(typeof line.state).toBe('string')
    expect(typeof line.reason_class).toBe('string')
    expect(typeof line.destination).toBe('string')
    expect(typeof line.emit_method).toBe('string')
    expect(typeof line.alert_id).toBe('string')

    expect(line.fingerprint).toBe('abc123')
    expect(line.severity).toBe('WARNING')
    expect(line.agent).toBe('sadie')
    expect(line.state).toBe('STUCK')
    expect(line.reason_class).toBe('IDLE_TIMEOUT')
    expect(line.destination).toBe('telegram')
    expect(line.emit_method).toBe('telegram_direct')
    expect(line.alert_id).toBe(alertId)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('multiple calls produce multiple JSON-lines', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'emit-log-multi-'))
    const logPath = join(tmpDir, 'emit.log')

    writeEmitLog({ fingerprint: 'fp1', severity: 'WARNING', agent: 'sadie', state: 'STUCK',
      reason_class: 'IDLE_TIMEOUT', destination: 'telegram', emit_method: 'telegram_direct' }, { logPath })
    writeEmitLog({ fingerprint: 'fp2', severity: 'CRITICAL', agent: 'boss', state: 'STUCK',
      reason_class: 'TMUX_DEAD', destination: 'push', emit_method: 'push_notification' }, { logPath })

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n')
    expect(lines.length).toBe(2)
    const l1 = JSON.parse(lines[0])
    const l2 = JSON.parse(lines[1])
    expect(l1.fingerprint).toBe('fp1')
    expect(l2.fingerprint).toBe('fp2')

    rmSync(tmpDir, { recursive: true, force: true })
  })
})
