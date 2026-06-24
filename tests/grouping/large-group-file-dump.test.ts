/**
 * C1.9 — Large group (50 members) → output is summary + file dump path;
 * file at referenced path contains full member list
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { GroupingEngine } from '../../src/grouping/index'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('C1.9 — large group file dump', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('emits summary + file dump for 50 members; file contains full member list', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'grouping-test-'))
    const engine = new GroupingEngine({
      groupWaitSec: 30,
      groupIntervalSec: 300,
      repeatIntervalSec: 1800,
      resolvedGraceSec: 60,
      dumpDir: tmpDir,
      maxMessageChars: 3500,
    })

    const t0 = 1000
    const agents: string[] = []
    for (let i = 0; i < 50; i++) {
      const agentName = `agent-${String(i).padStart(3, '0')}`
      agents.push(agentName)
      engine.ingest({ agent: agentName, state: 'STUCK', reason_class: 'PICKER_PARK', severity: 'WARNING' }, t0 + i)
    }

    // Flush after group_wait
    const msgs = engine.tick(t0 + 31)
    expect(msgs.length).toBe(1)

    const msg = msgs[0]
    expect(msg.agents.length).toBe(50)
    // File path should be set
    expect(msg.file_path).toBeDefined()
    expect(existsSync(msg.file_path!)).toBe(true)

    // File should contain all agent names
    const fileContent = readFileSync(msg.file_path!, 'utf-8')
    for (const agent of agents) {
      expect(fileContent).toContain(`agent=${agent}`)
    }
  })
})
