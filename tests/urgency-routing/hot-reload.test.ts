/**
 * C3.9 — severity-map.json edited mid-run with new mapping → next tick honors new mapping
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { UrgencyRouter, DEFAULT_SEVERITY_MAP } from '../../src/urgency-routing/index'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C3.9 — severity-map.json hot-reload', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('honors new mapping after file edit without restart', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'routing-hotreload-'))
    const severityMapPath = join(tmpDir, 'severity-map.json')
    const criticalDedupPath = join(tmpDir, 'critical-dedup.json')

    writeFileSync(severityMapPath, JSON.stringify(DEFAULT_SEVERITY_MAP), 'utf-8')
    const router = new UrgencyRouter({ severityMapPath, criticalDedupPath })

    const alert = { agent: 'boss', state: 'MY_NEW_STATE', reason_class: 'UNKNOWN' }

    // Before edit: no mapping for MY_NEW_STATE → default WARNING
    const sev1 = router.assignSeverity(alert)
    expect(sev1).toBe('WARNING')  // default

    // Edit the file to add MY_NEW_STATE → CRITICAL
    // Add a small delay to ensure mtime changes
    await new Promise(r => setTimeout(r, 10))
    const newMap = {
      ...DEFAULT_SEVERITY_MAP,
      mappings: [
        { match: { state: 'MY_NEW_STATE' }, severity: 'CRITICAL' as const },
        ...DEFAULT_SEVERITY_MAP.mappings,
      ],
    }
    writeFileSync(severityMapPath, JSON.stringify(newMap), 'utf-8')

    // Touch to ensure mtime update
    const now = Date.now()

    // Next call: hot-reload should pick up new mapping
    const sev2 = router.assignSeverity(alert)
    expect(sev2).toBe('CRITICAL')
  })
})
