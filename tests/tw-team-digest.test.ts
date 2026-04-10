/**
 * Integration test for tw-team-digest CLI.
 *
 * Asserts that:
 *   1. All 4 agent names appear in output
 *   2. At least one section header appears in output
 *   3. Exit code is 0 for a valid DB
 *   4. Exit code is non-zero + clear error for a missing DB
 */

import { describe, it, expect } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "../bin/tw-team-digest.ts");
const REAL_DB =
  process.env.TASK_BOARD_DB ??
  "/Users/coachstokes/.claude/mcp-servers/task-board/tasks.db";

function runCli(env: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const result = spawnSync("bun", ["run", CLI_PATH], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("tw-team-digest", () => {
  it("exits 0 and contains all 4 agent names", () => {
    if (!existsSync(REAL_DB)) {
      console.warn(`Skipping live DB test — DB not found at ${REAL_DB}`);
      return;
    }

    const { stdout, exitCode } = runCli();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("boss");
    expect(stdout).toContain("steve");
    expect(stdout).toContain("sadie");
    expect(stdout).toContain("kiera");
  });

  it("contains at least one section header", () => {
    if (!existsSync(REAL_DB)) {
      console.warn(`Skipping live DB test — DB not found at ${REAL_DB}`);
      return;
    }

    const { stdout, exitCode } = runCli();

    expect(exitCode).toBe(0);
    // Any of the expected section headers
    const hasHeader =
      stdout.includes("THREADWORK TEAM DIGEST") ||
      stdout.includes("AGENT TASK COUNTS") ||
      stdout.includes("TOP 5 OLDEST IN-PROGRESS TASKS") ||
      stdout.includes("DECISION COUNTS BY STATUS");
    expect(hasHeader).toBe(true);
  });

  it("exits non-zero with a clear error message when DB is missing", () => {
    const { stderr, exitCode } = runCli({
      TASK_BOARD_DB: "/nonexistent/path/tasks.db",
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("ERROR:");
    expect(stderr.toLowerCase()).toContain("not found");
  });
});
