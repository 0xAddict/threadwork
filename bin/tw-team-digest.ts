#!/usr/bin/env bun
/**
 * tw-team-digest — Read-only one-screen digest of the threadwork task board.
 *
 * Reads: /Users/coachstokes/.claude/mcp-servers/task-board/tasks.db
 * Zero writes. Zero network. Zero side effects.
 * Exits non-zero with a clear message if DB is locked or missing.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";

const DB_PATH =
  process.env.TASK_BOARD_DB ??
  "/Users/coachstokes/.claude/mcp-servers/task-board/tasks.db";

const AGENTS = ["boss", "steve", "sadie", "kiera"] as const;
type Agent = (typeof AGENTS)[number];

const DECISION_STATUSES = [
  "open",
  "positions",
  "critique",
  "finalized",
  "expired",
] as const;

// ── helpers ─────────────────────────────────────────────────────────────────

function die(msg: string, code = 1): never {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(code);
}

function openDb(path: string): Database {
  if (!existsSync(path)) {
    die(`Task board DB not found: ${path}`);
  }
  try {
    // IMMUTABLE + READONLY: safest open mode for a WAL-mode SQLite
    const db = new Database(path, { readonly: true, create: false });
    // quick sanity probe
    db.query("SELECT 1").get();
    return db;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/locked|busy/i.test(msg)) {
      die(`DB is locked (another process has an exclusive write lock): ${msg}`);
    }
    die(`Cannot open DB at ${path}: ${msg}`);
  }
}

function hr(char = "─", width = 72): string {
  return char.repeat(width);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// ── queries ──────────────────────────────────────────────────────────────────

interface AgentTaskCounts {
  pending: number;
  in_progress: number;
  completed_24h: number;
}

function getAgentCounts(
  db: Database,
  agent: string
): AgentTaskCounts {
  const pending = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM tasks WHERE to_agent = ? AND status = 'pending'"
      )
      .get(agent) as { n: number }
  ).n;

  const in_progress = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM tasks WHERE to_agent = ? AND status = 'in_progress'"
      )
      .get(agent) as { n: number }
  ).n;

  const completed_24h = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE to_agent = ?
           AND status = 'completed'
           AND completed_at >= datetime('now', '-24 hours')`
      )
      .get(agent) as { n: number }
  ).n;

  return { pending, in_progress, completed_24h };
}

interface InProgressTask {
  id: number;
  to_agent: string;
  age_min: number;
  description: string;
}

function getOldestInProgress(db: Database, limit = 5): InProgressTask[] {
  return db
    .query(
      `SELECT
         id,
         to_agent,
         ROUND((julianday('now') - julianday(COALESCE(claimed_at, created_at))) * 1440) AS age_min,
         description
       FROM tasks
       WHERE status = 'in_progress'
       ORDER BY COALESCE(claimed_at, created_at) ASC
       LIMIT ?`
    )
    .all(limit) as InProgressTask[];
}

interface DecisionCount {
  status: string;
  n: number;
}

function getDecisionCounts(db: Database): DecisionCount[] {
  return db
    .query(
      `SELECT status, COUNT(*) AS n FROM decisions GROUP BY status ORDER BY status`
    )
    .all() as DecisionCount[];
}

// ── render ───────────────────────────────────────────────────────────────────

function renderDigest(db: Database): void {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  console.log();
  console.log(hr("═"));
  console.log("  THREADWORK TEAM DIGEST");
  console.log(`  Generated: ${now}`);
  console.log(hr("═"));

  // ── Per-agent task counts ──────────────────────────────────────────────
  console.log();
  console.log("  AGENT TASK COUNTS");
  console.log(hr());
  console.log(
    `  ${pad("Agent", 8)}  ${pad("Pending", 9)}  ${pad("In Progress", 12)}  Completed (24h)`
  );
  console.log(hr());

  for (const agent of AGENTS) {
    const c = getAgentCounts(db, agent);
    console.log(
      `  ${pad(agent, 8)}  ${pad(String(c.pending), 9)}  ${pad(String(c.in_progress), 12)}  ${c.completed_24h}`
    );
  }

  // ── Top 5 oldest in-progress tasks ────────────────────────────────────
  console.log();
  console.log("  TOP 5 OLDEST IN-PROGRESS TASKS");
  console.log(hr());
  console.log(
    `  ${pad("ID", 6)}  ${pad("Assignee", 8)}  ${pad("Age(min)", 9)}  Description`
  );
  console.log(hr());

  const tasks = getOldestInProgress(db);
  if (tasks.length === 0) {
    console.log("  (none)");
  } else {
    for (const t of tasks) {
      console.log(
        `  ${pad(String(t.id), 6)}  ${pad(t.to_agent, 8)}  ${pad(String(t.age_min), 9)}  ${truncate(t.description, 80)}`
      );
    }
  }

  // ── Decision counts ───────────────────────────────────────────────────
  console.log();
  console.log("  DECISION COUNTS BY STATUS");
  console.log(hr());

  const decisionMap = new Map<string, number>();
  for (const row of getDecisionCounts(db)) {
    decisionMap.set(row.status, row.n);
  }

  for (const s of DECISION_STATUSES) {
    const count = decisionMap.get(s) ?? 0;
    console.log(`  ${pad(s, 12)}  ${count}`);
  }

  console.log();
  console.log(hr("═"));
  console.log();
}

// ── main ─────────────────────────────────────────────────────────────────────

const db = openDb(DB_PATH);
try {
  renderDigest(db);
} finally {
  db.close();
}
