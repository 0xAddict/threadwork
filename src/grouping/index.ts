/**
 * src/grouping/index.ts — Heartbeat-v2 Grouping Engine
 *
 * Sprint 3 / DEL-1 — Alertmanager-style grouping with:
 * - Group key: (state, reason_class, severity) — extended per DEL-3 §8
 * - group_wait_sec: buffer before first flush (default 30s)
 * - group_interval_sec: min gap between flushes when new members added (default 300s)
 * - repeat_interval_sec: min gap between flushes when no new members (default 1800s)
 * - resolved_grace_sec: time all members must be non-matching before RESOLVED emits (default 60s)
 * - Buffer persistence: in-memory only (NOT across process restart — by design)
 * - File dump: ~/.claude/state/heartbeat-v2/groups/<sha1(group_key)>-<ISO8601>.txt
 * - File rotation: keep 200 most recent, unlink older
 * - Payload size: if > 3500 chars → summary + file dump
 *
 * IMPORTANT: Buffer is ephemeral (in-memory). On process restart, pending
 * buffers are lost. The underlying classifier will re-fire on the next tick
 * if conditions persist and a new group will form.
 */

import { createHash } from 'crypto'
import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
// Sprint 4 §EXT-1: emit.log cross-cutting — import writeEmitLog for use at emission sites
import { writeEmitLog } from '../alert-review/emit-log.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AlertInput {
  agent: string
  state: string
  reason_class: string
  severity: string        // CRITICAL | WARNING | INFO (per DEL-3 §8)
  [key: string]: string
}

export interface GroupMessage {
  group_key: string
  state: string
  reason_class: string
  severity: string
  agents: string[]
  first_stuck_at: number   // unix seconds
  group_age_sec: number
  message: string          // formatted telegram message
  file_path?: string       // set if payload > 3500 chars or large group
  is_resolved?: boolean
}

export interface GroupingEngineOptions {
  groupWaitSec?: number
  groupIntervalSec?: number
  repeatIntervalSec?: number
  resolvedGraceSec?: number
  dumpDir?: string
  maxDumpFiles?: number
  maxMessageChars?: number
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface MemberEntry {
  agent: string
  firstSeenAt: number
  lastSeenAt: number       // last tick when this member was observed still active
  isActive: boolean        // true = currently in matching state
  allClearSince?: number   // when member first went non-active
}

interface GroupState {
  groupKey: string
  state: string
  reason_class: string
  severity: string
  members: Map<string, MemberEntry>
  createdAt: number
  lastFlushedAt: number
  hasBeenFlushed: boolean
  hasPendingNewMember: boolean  // new member added since last flush
  // resolved tracking
  allClearAt?: number           // time when all members became non-active
}

// ---------------------------------------------------------------------------
// GroupingEngine
// ---------------------------------------------------------------------------

export class GroupingEngine {
  private groupWaitSec: number
  private groupIntervalSec: number
  private repeatIntervalSec: number
  private resolvedGraceSec: number
  private dumpDir: string
  private maxDumpFiles: number
  private maxMessageChars: number

  // In-memory group state
  private groups: Map<string, GroupState> = new Map()

  constructor(opts: GroupingEngineOptions = {}) {
    this.groupWaitSec = opts.groupWaitSec
      ?? parseInt(process.env['HEARTBEAT_V2_GROUP_WAIT_SEC'] ?? '30', 10)
    this.groupIntervalSec = opts.groupIntervalSec
      ?? parseInt(process.env['HEARTBEAT_V2_GROUP_INTERVAL_SEC'] ?? '300', 10)
    this.repeatIntervalSec = opts.repeatIntervalSec
      ?? parseInt(process.env['HEARTBEAT_V2_GROUP_REPEAT_INTERVAL_SEC'] ?? '1800', 10)
    this.resolvedGraceSec = opts.resolvedGraceSec
      ?? parseInt(process.env['HEARTBEAT_V2_GROUP_RESOLVED_GRACE_SEC'] ?? '60', 10)
    this.dumpDir = opts.dumpDir
      ?? join(homedir(), '.claude', 'state', 'heartbeat-v2', 'groups')
    this.maxDumpFiles = opts.maxDumpFiles ?? 200
    this.maxMessageChars = opts.maxMessageChars ?? 3500
  }

  // ── Compute group key ──────────────────────────────────────────────────────

  private computeGroupKey(state: string, reason_class: string, severity: string): string {
    return `${state}::${reason_class}::${severity}`
  }

  // ── Ingest an alert into the buffer ───────────────────────────────────────
  //
  // Called for each alert that survives INHIBIT/SILENCE/DEDUP before grouping.
  // nowSec: current unix timestamp in seconds

  ingest(alert: AlertInput, nowSec?: number): void {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const key = this.computeGroupKey(alert.state, alert.reason_class, alert.severity)

    let group = this.groups.get(key)
    if (!group) {
      group = {
        groupKey: key,
        state: alert.state,
        reason_class: alert.reason_class,
        severity: alert.severity,
        members: new Map(),
        createdAt: now,
        lastFlushedAt: 0,
        hasBeenFlushed: false,
        hasPendingNewMember: false,
        allClearAt: undefined,
      }
      this.groups.set(key, group)
    }

    const isNewMember = !group.members.has(alert.agent)
    const existing = group.members.get(alert.agent)

    if (existing) {
      // Member already exists — update last seen, reactivate
      const wasInactive = !existing.isActive
      existing.lastSeenAt = now
      existing.isActive = true
      existing.allClearSince = undefined
      // If member was previously cleared, re-activating means group is no longer clearing
      if (wasInactive) {
        group.allClearAt = undefined
        // Treat re-activation like a new member for timing purposes if group was pending resolution
        if (group.hasBeenFlushed) {
          group.hasPendingNewMember = true
        }
      }
    } else {
      group.members.set(alert.agent, {
        agent: alert.agent,
        firstSeenAt: now,
        lastSeenAt: now,
        isActive: true,
        allClearSince: undefined,
      })
      // Mark group allClearAt as cleared since there's a new active member
      group.allClearAt = undefined
      if (group.hasBeenFlushed) {
        group.hasPendingNewMember = true
      }
    }
  }

  // ── Mark agents as no longer active (recovered) ───────────────────────────
  //
  // Call this for agents that are NOT in the current tick's classifier output
  // for a given group key. This signals they may have recovered.

  markInactive(state: string, reason_class: string, severity: string, agent: string, nowSec?: number): void {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const key = this.computeGroupKey(state, reason_class, severity)
    const group = this.groups.get(key)
    if (!group) return

    const member = group.members.get(agent)
    if (member && member.isActive) {
      member.isActive = false
      member.allClearSince = now
    }
  }

  // ── Mark all agents in a group not seen this tick as inactive ─────────────
  //
  // Call after ingesting all current tick's alerts for a given group key.
  // activeAgents: the set of agents seen in the current tick for this key.

  syncActiveMembers(state: string, reason_class: string, severity: string, activeAgents: Set<string>, nowSec?: number): void {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const key = this.computeGroupKey(state, reason_class, severity)
    const group = this.groups.get(key)
    if (!group) return

    for (const [agent, member] of group.members) {
      if (!activeAgents.has(agent) && member.isActive) {
        member.isActive = false
        member.allClearSince = now
      }
    }
  }

  // ── Tick: evaluate all groups and return messages to emit ─────────────────

  tick(nowSec?: number): GroupMessage[] {
    const now = nowSec ?? Math.floor(Date.now() / 1000)
    const messages: GroupMessage[] = []

    for (const [key, group] of this.groups) {
      const activeMembers = [...group.members.values()].filter(m => m.isActive)
      const allMembers = [...group.members.values()]

      if (activeMembers.length === 0 && group.members.size > 0) {
        // All members are inactive — check for RESOLVED
        // Find when all became inactive
        const allClearTime = allMembers.reduce((max, m) => {
          return Math.max(max, m.allClearSince ?? now)
        }, 0)

        if (group.allClearAt === undefined) {
          group.allClearAt = allClearTime
        }

        const clearDuration = now - group.allClearAt
        if (clearDuration >= this.resolvedGraceSec) {
          // Emit RESOLVED
          if (group.hasBeenFlushed) {
            const durationMin = Math.round((now - group.createdAt) / 60)
            const msg: GroupMessage = {
              group_key: key,
              state: group.state,
              reason_class: group.reason_class,
              severity: group.severity,
              agents: allMembers.map(m => m.agent),
              first_stuck_at: group.createdAt,
              group_age_sec: now - group.createdAt,
              is_resolved: true,
              message: `[RESOLVED] group ${group.state}/${group.reason_class}: resolved, was ${allMembers.length} agents over ${durationMin} minutes`,
            }
            messages.push(msg)
          }
          // Dispose group state
          this.groups.delete(key)
        }
        continue
      }

      if (activeMembers.length === 0) continue

      // Reset allClearAt if there are active members
      if (group.allClearAt !== undefined) {
        group.allClearAt = undefined
      }

      // Determine if we should flush
      const timeSinceCreation = now - group.createdAt
      const timeSinceLastFlush = group.hasBeenFlushed ? now - group.lastFlushedAt : Infinity

      let shouldFlush = false

      if (!group.hasBeenFlushed) {
        // First flush: wait group_wait_sec
        if (timeSinceCreation >= this.groupWaitSec) {
          shouldFlush = true
        }
      } else {
        // Subsequent flushes
        if (group.hasPendingNewMember) {
          // New member: use group_interval_sec (but only if elapsed)
          if (timeSinceLastFlush >= this.groupIntervalSec) {
            shouldFlush = true
          }
        } else {
          // No new members: use repeat_interval_sec
          if (timeSinceLastFlush >= this.repeatIntervalSec) {
            shouldFlush = true
          }
        }

        // Conflict resolution: earlier applicable interval wins
        // If both group_interval and repeat_interval could apply, earlier wins
        const nextGroupInterval = group.lastFlushedAt + this.groupIntervalSec
        const nextRepeatInterval = group.lastFlushedAt + this.repeatIntervalSec
        if (group.hasPendingNewMember && timeSinceLastFlush >= this.groupIntervalSec) {
          shouldFlush = true
        } else if (!group.hasPendingNewMember && timeSinceLastFlush >= this.repeatIntervalSec) {
          shouldFlush = true
        }
        // Ensure group_interval wins over repeat_interval when both would fire
        if (timeSinceLastFlush >= this.groupIntervalSec && timeSinceLastFlush >= this.repeatIntervalSec) {
          shouldFlush = true
        }
      }

      if (!shouldFlush) continue

      // Build and emit the grouped message
      const msg = this.buildGroupMessage(group, activeMembers, now)
      messages.push(msg)

      // Update group state
      group.lastFlushedAt = now
      group.hasBeenFlushed = true
      group.hasPendingNewMember = false
    }

    return messages
  }

  // ── Build a grouped message ────────────────────────────────────────────────

  private buildGroupMessage(group: GroupState, activeMembers: MemberEntry[], nowSec: number): GroupMessage {
    const agentNames = activeMembers.map(m => m.agent)
    const firstStuckAt = group.createdAt
    const groupAgeSec = nowSec - group.createdAt
    const firstStuckIso = new Date(firstStuckAt * 1000).toISOString()

    const sha1Key = createHash('sha1').update(group.groupKey).digest('hex').slice(0, 8)
    const isoNow = new Date(nowSec * 1000).toISOString().replace(/[:.]/g, '-')
    const dumpFile = join(this.dumpDir, `${sha1Key}-${isoNow}.txt`)

    const bodyLines: string[] = [
      `[grouped alert] state=${group.state} reason=${group.reason_class} severity=${group.severity}`,
      `agents (N=${agentNames.length}): ${agentNames.join(', ')}`,
      `first stuck: ${firstStuckIso}`,
      `group age: ${groupAgeSec}s`,
      `details: ${dumpFile}`,
    ]
    const body = bodyLines.join('\n')

    // Write dump file (always — provides full details)
    this.writeDumpFile(dumpFile, group, activeMembers, nowSec)

    // Rotate dump files
    this.rotateDumpFiles()

    if (body.length > this.maxMessageChars) {
      const summary = [
        `[grouped alert] state=${group.state} reason=${group.reason_class} severity=${group.severity}`,
        `agents (N=${agentNames.length}): [see file]`,
        `first stuck: ${firstStuckIso}`,
        `group age: ${groupAgeSec}s`,
        `details: ${dumpFile}`,
      ].join('\n')
      return {
        group_key: group.groupKey,
        state: group.state,
        reason_class: group.reason_class,
        severity: group.severity,
        agents: agentNames,
        first_stuck_at: firstStuckAt,
        group_age_sec: groupAgeSec,
        message: summary,
        file_path: dumpFile,
      }
    }

    return {
      group_key: group.groupKey,
      state: group.state,
      reason_class: group.reason_class,
      severity: group.severity,
      agents: agentNames,
      first_stuck_at: firstStuckAt,
      group_age_sec: groupAgeSec,
      message: body,
      file_path: dumpFile,
    }
  }

  // ── Write dump file ────────────────────────────────────────────────────────

  private writeDumpFile(dumpFile: string, group: GroupState, activeMembers: MemberEntry[], nowSec: number): void {
    try {
      if (!existsSync(this.dumpDir)) {
        mkdirSync(this.dumpDir, { recursive: true })
      }
      const lines: string[] = [
        `group_key: ${group.groupKey}`,
        `state: ${group.state}`,
        `reason_class: ${group.reason_class}`,
        `severity: ${group.severity}`,
        `emitted_at: ${new Date(nowSec * 1000).toISOString()}`,
        `group_created_at: ${new Date(group.createdAt * 1000).toISOString()}`,
        `group_age_sec: ${nowSec - group.createdAt}`,
        `member_count: ${activeMembers.length}`,
        '',
        '--- members ---',
      ]
      for (const m of activeMembers) {
        lines.push(`agent=${m.agent} first_seen=${new Date(m.firstSeenAt * 1000).toISOString()} last_seen=${new Date(m.lastSeenAt * 1000).toISOString()} active=${m.isActive}`)
      }
      writeFileSync(dumpFile, lines.join('\n'), 'utf-8')
    } catch (err) {
      process.stderr.write(`[grouping] WARN: Failed to write dump file ${dumpFile}: ${err}\n`)
    }
  }

  // ── Rotate dump files (keep max 200) ──────────────────────────────────────

  private rotateDumpFiles(): void {
    try {
      if (!existsSync(this.dumpDir)) return
      const files = readdirSync(this.dumpDir)
        .filter(f => f.endsWith('.txt'))
        .map(f => join(this.dumpDir, f))
        .sort()  // lexicographic = chronological (ISO8601 in filename)

      if (files.length > this.maxDumpFiles) {
        const toDelete = files.slice(0, files.length - this.maxDumpFiles)
        for (const f of toDelete) {
          try { unlinkSync(f) } catch { /* ignore */ }
        }
      }
    } catch (err) {
      process.stderr.write(`[grouping] WARN: Failed to rotate dump files: ${err}\n`)
    }
  }

  // ── Get current group state (for testing) ─────────────────────────────────

  getGroup(state: string, reason_class: string, severity: string): GroupState | undefined {
    const key = this.computeGroupKey(state, reason_class, severity)
    return this.groups.get(key)
  }

  getGroupByKey(key: string): GroupState | undefined {
    return this.groups.get(key)
  }

  getAllGroups(): Map<string, GroupState> {
    return this.groups
  }
}
