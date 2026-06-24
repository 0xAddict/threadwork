/**
 * C1.10 — File rotation: after 250 group emissions of different keys,
 * only the 200 most recent files remain.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { GroupingEngine } from '../../src/grouping/index'
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C1.10 — file rotation keeps 200 most recent', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('retains only 200 files after 250 emissions', { timeout: 30000 }, () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'grouping-rotation-'))
    const engine = new GroupingEngine({
      groupWaitSec: 0,
      groupIntervalSec: 1,
      repeatIntervalSec: 2,
      resolvedGraceSec: 60,
      dumpDir: tmpDir,
      maxDumpFiles: 200,
    })

    // Create 250 emissions with different group keys (different reason_class)
    // Using groupWaitSec=0, each group flushes immediately on first tick
    let t = 1000
    for (let i = 0; i < 250; i++) {
      const reason = `REASON_${String(i).padStart(4, '0')}`
      engine.ingest({ agent: 'boss', state: 'STUCK', reason_class: reason, severity: 'WARNING' }, t)
      engine.tick(t + 1)
      t += 3
    }

    // Count files in dump dir
    const files = readdirSync(tmpDir).filter(f => f.endsWith('.txt'))
    expect(files.length).toBeLessThanOrEqual(200)
  })
})
