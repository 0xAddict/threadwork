/**
 * C3.3 — Alert with state=STUCK reason_class=RESTART_LOOP → CRITICAL
 * (mapped via severity-map.json first-match rule before generic STUCK→WARNING)
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { UrgencyRouter, DEFAULT_SEVERITY_MAP } from '../../src/urgency-routing/index'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C3.3 — first-match-wins for RESTART_LOOP', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('STUCK+RESTART_LOOP → CRITICAL (before generic STUCK→WARNING)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routing-first-match-'))
    const severityMapPath = join(tmpDir, 'severity-map.json')
    const criticalDedupPath = join(tmpDir, 'critical-dedup.json')

    writeFileSync(severityMapPath, JSON.stringify(DEFAULT_SEVERITY_MAP), 'utf-8')
    const router = new UrgencyRouter({ severityMapPath, criticalDedupPath })

    const alert = { agent: 'boss', state: 'STUCK', reason_class: 'RESTART_LOOP' }
    const severity = router.assignSeverity(alert)
    expect(severity).toBe('CRITICAL')
  })

  it('STUCK+PICKER_PARK → WARNING (generic STUCK rule)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routing-first-match2-'))
    const severityMapPath = join(tmpDir, 'severity-map.json')
    const criticalDedupPath = join(tmpDir, 'critical-dedup.json')

    writeFileSync(severityMapPath, JSON.stringify(DEFAULT_SEVERITY_MAP), 'utf-8')
    const router = new UrgencyRouter({ severityMapPath, criticalDedupPath })

    const alert = { agent: 'boss', state: 'STUCK', reason_class: 'PICKER_PARK' }
    const severity = router.assignSeverity(alert)
    expect(severity).toBe('WARNING')
  })
})
