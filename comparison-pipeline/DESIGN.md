# Threadwork Gap Analysis Pipeline — Design v4

## Purpose

Compare Threadwork against all actively maintained open-source multi-agent orchestration frameworks.
Find GAPS — capabilities others have that Threadwork doesn't. Every claim must be code-verified
with file + line-range citations. No marketing copy in the final output.

## Prior Failure (why this pipeline exists)

In a manual comparison, Claude attributed a "learning loop" as unique to Hermes Agent — when the
user had already designed the same thing in Susanna 4.0 months earlier. Root cause: research agents
returned README marketing copy, which was compared asymmetrically against Threadwork's actual source
code. This pipeline eliminates that class of error by requiring code-level evidence for all claims.

---

## State Management

```
/tmp/threadwork-comparison/
├── state.json                    # pipeline phase, overall status, heartbeat
├── findings.db                   # SQLite WAL — all agent findings
├── repos/                        # shallow-cloned repos (--depth 1)
│   ├── openclaw/
│   ├── hermes-agent/
│   └── ...
└── output/
    └── gap-analysis.md           # final deliverable
```

### Disk budget

- Shallow clones only: `git clone --depth 1 --single-branch`
- 2GB max total for repos/ — abort if exceeded
- Cleanup occurs only AFTER verification AND Codex review both complete
- Cleanup step: `rm -rf repos/` after Phase 6 Codex review completes (repos must remain available for both verification and Codex review)

---

## SQLite Connection Requirements

Only the CONSOLIDATOR and PARENT ORCHESTRATOR write to `findings.db`. Any process that
opens `findings.db` for writing must execute these pragmas immediately on connect:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

**Subagents** do NOT write to SQLite. They may open `findings.db` for READ-ONLY queries
(Phase 4 Synthesis, Phase 5 Verification). See "Agent Output Protocol" below for the
JSONL write path that subagents use instead.

---

## Agent Output Protocol

Subagents in this pipeline run as Claude Code subagent processes that execute Bash commands.
They do NOT have transactional SQLite access, cannot run PRAGMA setup, and should not write
to `findings.db` directly. Instead, all agent output flows through JSONL files.

### Write path (agents)

Each agent writes findings to a JSONL file at:
```
/tmp/threadwork-comparison/agent-output/{phase}/{agent_id}.jsonl
```

Each line is a self-contained JSON object. Examples for each table type:

```json
{"table": "candidates", "operation": "upsert", "data": {"name": "openclaw", "repo_url": "https://github.com/openclaw/openclaw", "language": "TypeScript", "stars": 4200, "discovery_source": "https://awesome-agents.dev", "is_monorepo": 0, "project_path": null, "status": "pending"}}

{"table": "repos", "operation": "upsert", "data": {"name": "openclaw", "clone_path": "repos/openclaw", "project_path": null, "project_path_validated": 0, "repo_url": "https://github.com/openclaw/openclaw", "commit_sha": "abc123def456", "clone_depth": 1, "disk_bytes": 15728640, "status": "cloned"}}

{"table": "triage_scores", "operation": "upsert", "data": {"candidate": "openclaw", "capability_id": "memory_system", "has_code": 1, "evidence_file": "src/memory/store.ts", "evidence_start_line": 42, "evidence_end_line": 78, "evidence_summary": "Vector-backed semantic memory store with decay", "agent_id": "triage-openclaw"}}

{"table": "gaps", "operation": "insert", "data": {"candidate": "openclaw", "capability_id": "distributed_execution", "capability_summary": "Redis-backed worker queue with priority scheduling", "threadwork_equivalent": null, "verdict": "gap", "evidence_path": "src/workers/queue.ts", "evidence_start_line": 15, "evidence_end_line": 89, "threadwork_evidence_path": null, "threadwork_start_line": null, "threadwork_end_line": null, "their_verification": "code-verified", "threadwork_verification": "absent", "agent_id": "deep-dive-openclaw"}}

{"table": "absence_searches", "operation": "insert", "data": {"candidate": "openclaw", "dimension": "distributed_execution", "capability_id": "distributed_execution", "search_terms": "worker.*queue, redis.*queue, celery.*task, distributed.*exec, queue.*worker, broker.*connect", "files_searched": "gastown/runners/, gastown/beads/, vps_scripts/bead_runner.py, gastown/db.py", "agent_id": "deep-dive-openclaw"}}

{"table": "verification_checks", "operation": "insert", "data": {"gap_id": 1, "triage_candidate": null, "triage_capability_id": null, "cited_path": "src/workers/queue.ts", "cited_start_line": 15, "cited_end_line": 89, "repo_side": "candidate", "file_exists": 1, "content_matches_claim": 1, "actual_content_snippet": "export class PriorityQueue { constructor(private redis: Redis) {", "interpretation_note": "Implements a Redis-backed priority queue with FIFO fallback for task distribution across worker agents", "checker_agent_id": "verify-1"}}

{"table": "review_gate", "operation": "insert", "data": {"phase": "verification", "verdict": "pass", "failure_reasons": null}}
```

Supported tables: `candidates`, `repos`, `triage_scores`, `gaps`, `absence_searches`,
`verification_checks`, `review_gate`.

Supported operations: `upsert` (INSERT OR REPLACE), `insert` (INSERT), `sentinel`
(logged but not inserted — used for zero-gap candidates, see Phase 3).

### Consolidation path (parent orchestrator)

**Timing:** The consolidator runs ONCE after ALL parallel agents in a phase complete,
not per-agent. This avoids SQLite write contention — only one consolidator process
writes to `findings.db` at a time. For phases with parallel agents (Triage, Deep Dive),
the parent waits for every agent to finish writing its JSONL file, then runs the
consolidator across all JSONL files in sequence.

After all agents in a phase complete, the parent orchestrator runs a **CONSOLIDATOR** step:

1. Reads the agent's JSONL file line by line
2. Validates each row against the schema:
   - CHECK constraints (e.g., `has_code IN (0, 1)`, `length(search_terms) > 10`,
     `files_searched LIKE '%,%,%'`)
   - Foreign key references (e.g., `capability_id` exists in `capability_taxonomy`)
   - Required fields are present and non-NULL
3. Imports valid rows into SQLite via `INSERT OR REPLACE` (for upsert) or `INSERT` using
   the `sqlite3` CLI tool
4. Logs rejected rows to:
   ```
   /tmp/threadwork-comparison/agent-output/{phase}/{agent_id}.rejected.jsonl
   ```
   Each rejected line includes the original data plus a `"rejection_reason"` field

The consolidator is a single bash script that uses the `sqlite3` CLI. Together with the
parent orchestrator (Phase 0 init, Phase 1.5 clone), it is the ONLY process that writes
to `findings.db`. Subagents never write to SQLite.

**Rejection threshold:** If >20% of JSONL rows in a single consolidation run are rejected,
the consolidator must halt the pipeline and report the rejection count and reasons. Do not
proceed to the next phase.

### Why this matters

- Agents do not need PRAGMA setup, transactions, or direct SQLite access
- Schema validation happens in one place (the consolidator), not spread across N agents
- Crash recovery is simple: re-read the JSONL file and re-import
- Rejected rows are visible for debugging without corrupting the database
- The parent orchestrator can inspect rejection counts before proceeding to the next phase

---

## SQLite Schema

```sql
CREATE TABLE repos (
  name TEXT PRIMARY KEY,
  clone_path TEXT NOT NULL,
  project_path TEXT,                      -- subproject path for monorepos; NULL means repo root
  project_path_validated INTEGER DEFAULT 0, -- 1 only after clone-time validation confirms project_path exists
  repo_url TEXT NOT NULL,
  commit_sha TEXT,
  clone_depth INTEGER DEFAULT 1,
  disk_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | cloned | failed | cleaned
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE candidates (
  name TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  language TEXT,
  stars INTEGER,
  discovery_source TEXT,                  -- URL where this candidate was found
  is_monorepo INTEGER NOT NULL DEFAULT 0, -- 0 or 1
  project_path TEXT,                      -- expected orchestration project path inside monorepo
  status TEXT NOT NULL DEFAULT 'pending', -- pending | cloned | triaged | deep-dive | eliminated
  elimination_reason TEXT,                -- one line if eliminated
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- NOTE: No 'claimed_differentiator' column. Marketing copy is not stored.
-- Discovery agents record the discovery_source URL only. All capability
-- claims must come from triage/deep-dive agents reading actual code.

-- NOTE: No auto-update trigger for updated_at (triggers that UPDATE inside
-- AFTER UPDATE can recurse in SQLite). All UPDATE statements on candidates
-- MUST include `updated_at = datetime('now')` in the SET clause.

CREATE TABLE capability_taxonomy (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  description TEXT NOT NULL
);

INSERT INTO capability_taxonomy (id, category, description) VALUES
  ('memory_system', 'memory_system', 'Persistent, short-term, semantic, episodic, or retrieval-backed memory for agents'),
  ('task_coordination', 'task_coordination', 'Task decomposition, assignment, claiming, queues, boards, and coordination primitives'),
  ('decision_making', 'decision_making', 'Voting, consensus, critique, arbitration, or structured decision systems'),
  ('agent_lifecycle', 'agent_lifecycle', 'Spawn, monitor, heartbeat, recovery, watchdog, and lifecycle controls'),
  ('learning_skills', 'learning_skills', 'Skill acquisition, procedural memory, self-improvement, or learning loops'),
  ('enforcement_governance', 'enforcement_governance', 'Hooks, policies, governance, permissions, or guard enforcement'),
  ('communications', 'communications', 'External notifications or communication channels such as Slack/Discord/webhooks'),
  ('tool_sandboxing', 'tool_sandboxing', 'Sandboxed or isolated tool execution via containers or execution boundaries'),
  ('workflow_dag', 'workflow_dag', 'Workflow engines, DAGs, explicit state machines, or graph orchestration'),
  ('human_in_loop', 'human_in_loop', 'Human approvals, confirmations, reviews, or manual intervention checkpoints'),
  ('observability_tracing', 'observability_tracing', 'Tracing, logs, metrics, spans, or telemetry instrumentation'),
  ('persistence_checkpointing', 'persistence_checkpointing', 'Checkpointing, snapshots, persistence, resume, or saved execution state'),
  ('distributed_execution', 'distributed_execution', 'Workers, queues, distributed runtimes, broker-backed execution'),
  ('security_isolation', 'security_isolation', 'RBAC, tenancy, auth boundaries, execution isolation, or sandbox security'),
  ('eval_benchmarking', 'eval_benchmarking', 'Built-in evaluations, benchmarks, scoring, or test harnesses for agent quality'),
  ('model_routing', 'model_routing', 'Model/provider routing, fallback, selection, or provider abstraction logic'),
  ('prompt_management', 'prompt_management', 'Prompt templates, versioning, prompt registries, or system prompt management'),
  ('artifact_management', 'artifact_management', 'Workspace, file, or artifact management across agent sessions'),
  ('code_edit_engine', 'code_edit_engine', 'Code editing, patching, or file modification engine used by agents'),
  ('session_state', 'session_state', 'Session or conversation state management across agent turns'),
  ('planning_replanning', 'planning_replanning', 'Task planning, replanning, or plan revision capabilities'),
  ('error_recovery', 'error_recovery', 'Error recovery, retry semantics, or self-healing mechanisms'),
  ('agent_topology', 'agent_topology', 'Multi-agent topology, role specialization, or team structure'),
  ('context_management', 'context_management', 'Context window management, compression, or summarization'),
  ('tool_registry', 'tool_registry', 'Tool registry, capability discovery, or dynamic tool loading');

CREATE TABLE triage_scores (
  candidate TEXT NOT NULL REFERENCES candidates(name),
  capability_id TEXT NOT NULL REFERENCES capability_taxonomy(id),
  has_code INTEGER NOT NULL DEFAULT 0,    -- 0 or 1
  evidence_file TEXT,                     -- relative path within scanned project
  evidence_start_line INTEGER,
  evidence_end_line INTEGER,
  evidence_summary TEXT,                  -- one sentence max
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (candidate, capability_id),
  CHECK (has_code IN (0, 1)),
  CHECK (
    has_code = 0 OR
    (evidence_file IS NOT NULL AND evidence_start_line IS NOT NULL AND evidence_start_line > 0)
  ),
  CHECK (
    has_code = 0 OR
    (evidence_end_line IS NULL OR evidence_end_line >= evidence_start_line)
  )
);

CREATE TABLE gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate TEXT NOT NULL REFERENCES candidates(name),
  capability_id TEXT NOT NULL REFERENCES capability_taxonomy(id),
  capability_summary TEXT NOT NULL,            -- concrete implementation detail being compared
  threadwork_equivalent TEXT,                  -- what Threadwork has, or NULL if absent
  verdict TEXT NOT NULL,                       -- gap | threadwork_stronger | equivalent
  evidence_path TEXT NOT NULL,                 -- candidate repo relative path
  evidence_start_line INTEGER NOT NULL,
  evidence_end_line INTEGER,
  threadwork_evidence_path TEXT,               -- Threadwork relative path, NULL if absent
  threadwork_start_line INTEGER,
  threadwork_end_line INTEGER,
  their_verification TEXT NOT NULL DEFAULT 'code-verified',
  threadwork_verification TEXT NOT NULL,       -- code-verified | absent
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (candidate, capability_id),           -- prevent duplicate gap rows from reruns
  CHECK (verdict IN ('gap', 'threadwork_stronger', 'equivalent')),
  CHECK (evidence_start_line > 0),
  CHECK (evidence_end_line IS NULL OR evidence_end_line >= evidence_start_line),
  CHECK (their_verification IN ('code-verified')),
  CHECK (threadwork_verification IN ('code-verified', 'absent')),
  CHECK (
    threadwork_verification = 'absent' OR
    (threadwork_evidence_path IS NOT NULL AND threadwork_start_line IS NOT NULL AND threadwork_start_line > 0)
  ),
  CHECK (
    threadwork_verification = 'absent' OR
    (threadwork_end_line IS NULL OR threadwork_end_line >= threadwork_start_line)
  ),
  CHECK (
    threadwork_verification = 'absent' OR threadwork_equivalent IS NOT NULL
  )
);

CREATE TABLE absence_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate TEXT NOT NULL REFERENCES candidates(name),
  dimension TEXT NOT NULL,                     -- mirrors taxonomy category/id looked up during comparison
  capability_id TEXT NOT NULL REFERENCES capability_taxonomy(id),
  search_terms TEXT NOT NULL,                  -- JSON array or delimited string
  files_searched TEXT NOT NULL,                -- JSON array or delimited string of Threadwork files/directories searched
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(search_terms) > 10),          -- search terms must be substantive, not just one word
  CHECK (files_searched LIKE '%,%,%')          -- must list at least 3 files (2 commas minimum)
);

CREATE TABLE verification_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gap_id INTEGER REFERENCES gaps(id),
  triage_candidate TEXT,
  triage_capability_id TEXT,
  cited_path TEXT NOT NULL,
  cited_start_line INTEGER NOT NULL,
  cited_end_line INTEGER,
  repo_side TEXT NOT NULL,                     -- candidate | threadwork
  file_exists INTEGER NOT NULL,               -- 0 or 1
  content_matches_claim INTEGER NOT NULL,     -- 0 or 1
  actual_content_snippet TEXT,                -- first 200 chars of cited range start
  interpretation_note TEXT NOT NULL,          -- 1-2 sentences: WHAT the cited code actually does (not just that it exists)
  checker_agent_id TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (repo_side IN ('candidate', 'threadwork')),
  -- G2: FK-like constraint — triage fields must be non-null when gap_id is null
  CHECK (
    gap_id IS NOT NULL OR
    (triage_candidate IS NOT NULL AND triage_capability_id IS NOT NULL)
  ),
  -- G3: No orphaned rows — every row references either a gap or a triage score
  FOREIGN KEY (triage_candidate, triage_capability_id) REFERENCES triage_scores(candidate, capability_id)
);

CREATE TABLE review_gate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase TEXT NOT NULL,                         -- verification | final
  verdict TEXT NOT NULL,                       -- pass | fail
  failure_reasons TEXT,                        -- JSON array of specific issues
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_triage_candidate ON triage_scores(candidate);
CREATE INDEX idx_triage_capability ON triage_scores(capability_id);
CREATE INDEX idx_gaps_candidate ON gaps(candidate);
CREATE INDEX idx_gaps_verdict ON gaps(verdict);
CREATE INDEX idx_gaps_capability ON gaps(capability_id);
CREATE INDEX idx_verification_gap ON verification_checks(gap_id);
CREATE INDEX idx_absence_candidate ON absence_searches(candidate);
CREATE INDEX idx_absence_capability ON absence_searches(capability_id);
```

---

## Pipeline Phases

### Phase 0: Init

Create `/tmp/threadwork-comparison/`, initialize `findings.db` with schema above,
pre-seed `capability_taxonomy`, initialize a git repo for Codex review, create the stop
hook, and write `state.json`.

**Step 1: Create directories and git repo**

```bash
mkdir -p /tmp/threadwork-comparison/{repos,output,agent-output}
cd /tmp/threadwork-comparison && git init
```

The git repo is needed for Phase 6 (Codex review) — `gap-analysis.md` will be committed
here so Codex can review it via `--scope working-tree`.

**Step 2: Create the stop hook**

Write the stop hook file to `~/.claude/hooks/threadwork-comparison-gate.sh` (see "Exit
Criteria" section below for full contents) and register it in `~/.claude/settings.json`
under the `hooks.Stop` array. The hook must exist before the pipeline proceeds so that
premature exit is gated from the start.

**Step 3: Resolve threadwork_root as absolute path**

```bash
# Resolve tilde at init time — state.json must store an absolute path
THREADWORK_ROOT="$(eval echo ~/threadwork)"
```

> **IMPORTANT (macOS):** `threadwork_root` in `state.json` MUST be an absolute path
> (e.g., `/Users/xavierandre/threadwork`), never a literal `~/threadwork/`. The tilde
> is not expanded by tools that read state.json as JSON. Resolve it once at init time
> using `eval echo ~/threadwork` or `${HOME}/threadwork`.

**Step 4: Write state.json**

```json
{
  "pipeline": "threadwork-comparison",
  "created": "2026-04-13",
  "status": "running",
  "phase": "init",
  "threadwork_root": "/Users/xavierandre/threadwork",
  "threadwork_commit_sha": null,
  "phases": {
    "discovery": "pending",
    "clone": "pending",
    "triage": "pending",
    "deep_dive": "pending",
    "synthesis": "pending",
    "verification": "pending",
    "review": "pending",
    "cleanup": "pending"
  }
}
```

Note: the `env_gate` field has been removed. The stop hook reads `state.json` directly
(checking file existence and `status: running`) rather than relying on an environment
variable, which would not propagate to hook child processes.

**Step 5: Record the Threadwork commit SHA**

```bash
git -C "$THREADWORK_ROOT" rev-parse HEAD
```

Store the result in `state.json` as `threadwork_commit_sha`. All analysis results are pinned to
this specific Threadwork commit. If Threadwork changes after the pipeline starts, the results
may no longer be accurate — re-run from Phase 2 (triage) or later as appropriate.

### Phase 1: Discovery

**Tool:** `/deep-research` (subagent)
**Agent reads:** web (via WebSearch, WebFetch, Firecrawl)
**Agent writes:** prose research brief (returned to parent)

Research question: "What are the actively maintained open-source multi-agent orchestration
frameworks for LLM coding agents (not chatbots, not RAG frameworks, not chat UIs) as of
April 2026? For each, provide: repo URL, primary language, GitHub star count, the URL
where you found it, and whether the project is a monorepo with the orchestration framework
living in a subdirectory."

**Translation step (parent orchestrator):**

The `/deep-research` agent returns a prose brief, not structured data. The parent
orchestrator must parse this brief and write JSONL candidate rows to:
```
/tmp/threadwork-comparison/agent-output/discovery/discovery.jsonl
```

Each line:
```json
{"table": "candidates", "operation": "upsert", "data": {"name": "openclaw", "repo_url": "https://github.com/openclaw/openclaw", "language": "TypeScript", "stars": 4200, "discovery_source": "https://some-article.com/...", "is_monorepo": 0, "project_path": null, "status": "pending"}}
```

The parent then runs the consolidator to import these rows into SQLite.

**Output contract:**
- Each candidate row has `discovery_source` set to the URL where the candidate was found
- If the candidate is a monorepo, set `is_monorepo=1` and populate `project_path`
- If not a monorepo, set `is_monorepo=0` and `project_path=NULL`
- No capability claims stored — only name, URL, language, stars, source URL, and monorepo metadata
- Minimum 8 candidates or the phase fails

**State update:** `phases.discovery = "done"`, record candidate count.

### Phase 1.5: Clone

**Tool:** Bash (git clone)
**Runs in:** parent orchestrator directly (NOT a subagent)
**Runs:** sequentially, one repo at a time

> **NOTE:** Phase 1.5 runs in the parent orchestrator, not as a subagent. The
> consolidator-only-writes-SQLite rule applies to **subagents**. The parent CAN
> (and does) write to SQLite directly here, since it already has the PRAGMA-configured
> connection.

> **macOS compatibility:** `du -sb` is not available on macOS (BSD `du` lacks `-b`).
> Use `du -sk repos/{name} | awk '{print $1 * 1024}'` for cross-platform byte counts,
> or `stat -f%z` on individual files. The 2GB disk budget check must use the
> platform-compatible variant.

> **macOS compatibility:** `timeout` is not available on macOS by default. Instead of
> `timeout 60s git clone ...`, use the Bash tool's `timeout` parameter (set to 60000ms),
> or use the Perl alarm wrapper: `perl -e 'alarm 60; exec @ARGV' git clone ...`.

For each candidate in `candidates` where `status = 'pending'`:
1. `git clone --depth 1 --single-branch {repo_url} repos/{name}/`
2. Record `commit_sha` from `git -C repos/{name} rev-parse HEAD`
3. Record `disk_bytes` from `du -sk repos/{name} | awk '{print $1 * 1024}'`
4. INSERT into `repos` table with:
   - `name`
   - `clone_path = repos/{name}`
   - `project_path = candidates.project_path`
   - `repo_url`
   - `commit_sha`
   - `clone_depth = 1`
   - `disk_bytes`
   - `status`
5. On successful clone, also UPDATE `candidates SET status = 'cloned', updated_at = datetime('now') WHERE name = {name}` — this marks the candidate as ready for triage
6. If cumulative disk > 2GB, stop cloning remaining candidates and mark them `status = 'failed'` with error "disk budget exceeded"
7. If clone fails (404, auth required, timeout >60s), mark `status = 'failed'` with error

#### Project path validation (monorepo support)

After each successful clone, if `candidates.project_path` is set:

1. Verify the path exists: `test -d repos/{name}/{project_path}`
2. If it exists, set `repos.project_path_validated = 1`
3. If it does NOT exist, attempt auto-detection:
   - Search for `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `setup.py` in
     immediate subdirectories of `repos/{name}/`
   - Pick the subdirectory that looks most like the framework's core orchestration code
     (prefer directories containing the most implementation files matching the candidate's
     primary language)
   - If a plausible root is found, update `repos.project_path` to the auto-detected path
     and set `repos.project_path_validated = 1`
   - If no plausible root can be found, set `repos.status = 'failed'` with
     `error = 'could not locate framework root in monorepo'` and update
     `candidates SET status = 'eliminated', elimination_reason = 'monorepo project_path invalid and auto-detection failed', updated_at = datetime('now')`

If `candidates.project_path` is NULL (not a monorepo), skip validation and leave
`project_path_validated = 0` (not applicable).

**State update:** `phases.clone = "done"`, record clone success/fail counts.

### Phase 2: Triage

**Tool:** parallel agents (one per successfully cloned repo)
**Agent reads:** `repos/{name}/{project_path}/` if `project_path` is set, else `repos/{name}/` only
**Agent writes to:** JSONL file at `/tmp/threadwork-comparison/agent-output/triage/{agent_id}.jsonl`
**Consolidator imports to:** `triage_scores` table

Each agent runs this standardized audit against ONE repo.

#### Triage scan exclusions

The agent must exclude these paths/patterns from grep, glob, ranking, and evidence selection:

- `**/test/**`
- `**/tests/**`
- `**/__tests__/**`
- `**/examples/**`
- `**/docs/**`
- `**/vendor/**`
- `**/node_modules/**`
- `**/generated/**`
- `**/*.test.*`
- `**/*.spec.*`
- `**/*.d.ts`

#### Triage taxonomy audit

```
For the repo at repos/{name}/{project_path}/ (or repos/{name}/ if project_path is NULL):

1. Enumerate implementation files after exclusions.
2. wc -l on all .ts/.js/.py/.go/.rs files (top 20 by size)
3. For each capability_id, grep + read using these seed patterns:

   - memory_system: "memory.*store", "memory.*decay", "consolidat", "embedding.*store", "vector.*search", "semantic.*recall", "episodic.*memory"
   - task_coordination: "task.*queue", "task.*board", "task.*assign", "task.*claim", "task.*delegat", "work.*item"
   - decision_making: "decision.*engine", "vote.*result", "consensus.*protocol", "critique.*loop", "position.*paper"
   - agent_lifecycle: "spawn.*agent", "health.*check", "heartbeat.*monitor", "recover.*agent", "watchdog.*timer", "lifecycle.*hook"
   - learning_skills: "skill.*acqui", "learn.*loop", "self.*improv", "self.*creat", "procedural.*memory"
   - enforcement_governance: "hook.*enforce", "gate.*check", "enforce.*policy", "governance.*rule", "permission.*check", "guard.*rail"
   - communications: "telegram.*send", "slack.*notify", "discord.*channel", "channel.*message", "notify.*event", "webhook.*trigger"
   - tool_sandboxing: "sandbox.*exec", "container.*run", "isolat.*exec", "docker.*exec", "exec.*sandbox"
   - workflow_dag: "workflow.*engine", "dag.*node", "pipeline.*stage", "state.*machine", "graph.*execut"
   - human_in_loop: "approv.*request", "confirm.*action", "human.*review", "review.*gate", "manual.*step"
   - observability_tracing: "trace.*span", "otel.*export", "opentelemetry", "log.*event", "metric.*collect", "span.*context"
   - persistence_checkpointing: "checkpoint.*save", "snapshot.*state", "persist.*state", "resume.*from", "save.*state"
   - distributed_execution: "queue.*worker", "worker.*pool", "distributed.*exec", "celery.*task", "redis.*queue", "rabbit.*mq"
   - security_isolation: "rbac.*role", "tenant.*isolat", "auth.*check", "permission.*grant", "sandbox.*policy"
   - eval_benchmarking: "benchmark.*run", "eval.*score", "score.*metric", "test.*suite.*eval"
   - model_routing: "model.*router", "model.*select", "fallback.*provider", "provider.*routing", "openrouter"
   - prompt_management: "prompt.*template", "prompt.*version", "prompt.*manag", "system.*prompt"
   - artifact_management: "artifact.*store", "workspace.*manag", "file.*manag", "output.*dir"
   - code_edit_engine: "edit.*engine", "patch.*apply", "diff.*apply", "code.*change", "apply.*change"
   - session_state: "session.*state", "conversation.*context", "context.*window", "turn.*history"
   - planning_replanning: "plan.*step", "replan.*task", "decompos.*task", "strategy.*revis", "roadmap.*update"
   - error_recovery: "retry.*logic", "recover.*error", "fallback.*handler", "self.*heal", "circuit.*break"
   - agent_topology: "role.*special", "team.*struct", "hierarchy.*agent", "specialist.*role", "topology.*config"
   - context_management: "compress.*context", "summariz.*context", "context.*window", "token.*limit", "truncat.*history"
   - tool_registry: "tool.*registry", "discover.*tool", "capability.*register", "dynamic.*tool", "plugin.*load"

   **NOTE:** Triage agents must find 2+ grep hits in implementation files (not just 1)
   before marking `has_code=1`. A single hit is likely a comment, import, or config
   reference — not substantive implementation. If only 1 hit is found, the agent must
   read the file to confirm it is real implementation; if it is only a passing reference,
   mark `has_code=0`.

4. For each capability where grep finds hits:
   - Read the file to confirm it's actual implementation (not just a comment, test, generated file, import, or docs mention)
   - Record has_code=1 with:
     evidence_file="{relative/path}"
     evidence_start_line={start}
     evidence_end_line={end}
     evidence_summary="{one sentence max}"
5. For capabilities with no confirmed implementation: has_code=0 and evidence fields NULL
6. Write all 25 rows to the agent's JSONL file as `{"table": "triage_scores", "operation": "upsert", "data": {...}}` — one JSON line per capability. The consolidator will import these into SQLite via INSERT OR REPLACE after the agent completes.
```

**Agent return value:** DISCARDED by parent. Parent runs the consolidator to import the
agent's JSONL into SQLite, then reads from SQLite only.

**Elimination query (run by parent after consolidation):**
```sql
SELECT c.name, COUNT(ts.capability_id) as capabilities_with_code
FROM candidates c
LEFT JOIN triage_scores ts
  ON c.name = ts.candidate AND ts.has_code = 1
WHERE c.status = 'cloned'
GROUP BY c.name
HAVING capabilities_with_code <= 1;
```

These candidates get `status = 'eliminated'` with `elimination_reason`.

Survivors get `status = 'deep-dive'`.

**State update:** `phases.triage = "done"`, record survivors list.

### Phase 3: Deep Dive

**Tool:** Opus agents (one per surviving candidate, sequential to manage context)
**Agent reads:** candidate project root (`repos/{name}/{project_path}/` if set, else `repos/{name}/`) AND `{threadwork_root}`
**Agent writes to:** JSONL file at `/tmp/threadwork-comparison/agent-output/deep-dive/{agent_id}.jsonl`
**Consolidator imports to:** `gaps` table and `absence_searches` table

Each agent:
1. Reads the surviving candidate's code, focusing on files identified in `triage_scores`
2. Reads Threadwork's equivalent files and adjacent implementation areas
3. Uses `capability_taxonomy` as the normalization layer for all comparisons
4. For each concrete capability found in the candidate repo:
   - Map it to exactly one `capability_id`
   - Check if Threadwork has an equivalent
   - Set verdict:
     - `gap` = candidate has it and Threadwork does not
     - `threadwork_stronger` = both have it, and Threadwork's implementation is stronger
     - `equivalent` = both have materially comparable implementation
   - Cite structured evidence for BOTH repos when Threadwork has an implementation:
     - `evidence_path`, `evidence_start_line`, `evidence_end_line`
     - `threadwork_evidence_path`, `threadwork_start_line`, `threadwork_end_line`
   - If the capability doesn't exist in Threadwork:
     - `threadwork_equivalent = NULL`
     - `threadwork_evidence_path = NULL`
     - `threadwork_start_line = NULL`
     - `threadwork_end_line = NULL`
     - `threadwork_verification = 'absent'`
5. Write one JSONL line per concrete comparison claim as `{"table": "gaps", "operation": "insert", "data": {...}}`

#### Zero-gap deep-dive (sentinel row)

If a deep-dive agent genuinely finds no gaps for a candidate (the candidate has no
capabilities that Threadwork lacks, or all capabilities are equivalent), it must write
a sentinel JSONL line:
```json
{"table": "gaps", "operation": "sentinel", "data": {"candidate": "some-framework", "note": "no gaps found — all capabilities equivalent or absent in candidate"}}
```

The consolidator recognizes `"operation": "sentinel"` and does NOT insert it into SQLite.
Instead, it logs the sentinel and marks the candidate as processed. The stop hook must
accept candidates that have sentinel rows (i.e., a candidate with no gap rows is valid
if the agent wrote a sentinel).

#### Mandatory absence tracking

If the agent concludes that Threadwork lacks a capability that exists in the candidate repo, it must
also write a JSONL line for `absence_searches` (`{"table": "absence_searches", "operation": "insert", "data": {...}}`) documenting:
- `candidate`
- `dimension` (same normalized capability category/id)
- `capability_id`
- `search_terms` used to look for the feature in Threadwork
- `files_searched` in Threadwork before concluding absence
- `agent_id`

A `gap` row without a corresponding `absence_searches` row is invalid process behavior.

**Exhaustive absence tracking:** For every `capability_id` where the agent sets
`threadwork_verification = 'absent'`, the agent MUST INSERT a corresponding `absence_searches`
row documenting what it searched. The verifier (Phase 5) will check that every gap with
`threadwork_verification = 'absent'` has a matching `absence_searches` row with substantive
search terms (length > 10) and at least 3 files searched. Agents that skip this will cause
verification failure.

**Hard rule:** If an agent cannot confirm a capability by reading code, it DOES NOT INSERT a row.
Candidate-side verification is always `their_verification = 'code-verified'`. There is no
candidate-side unverified state.

**Agent return value:** DISCARDED by parent.

**State update:** `phases.deep_dive = "done"`, record gap counts per candidate.

### Phase 4: Synthesis

**Tool:** single agent
**Agent reads:** SQL queries against findings.db (read-only — never raw repo code)
**Agent writes:** `output/gap-analysis.md`

> **SQLite access rule clarification:** Subagents never WRITE to SQLite; read-only access
> is permitted for synthesis and verification. The synthesis agent reads findings.db via
> `sqlite3` CLI queries. This is safe because it does not modify data. The hard rule
> "agents write JSONL, not SQLite" applies to WRITE operations only.

Queries the agent runs:
```sql
-- Candidates summary
SELECT name, repo_url, status, elimination_reason, is_monorepo, project_path
FROM candidates
ORDER BY status, name;

-- Triage matrix
SELECT candidate, capability_id, has_code, evidence_file, evidence_start_line, evidence_end_line, evidence_summary
FROM triage_scores
ORDER BY candidate, capability_id;

-- All comparisons (the deliverable data source)
SELECT g.candidate, g.capability_id, ct.description, g.capability_summary, g.verdict,
       g.evidence_path, g.evidence_start_line, g.evidence_end_line,
       g.threadwork_equivalent, g.threadwork_evidence_path,
       g.threadwork_start_line, g.threadwork_end_line,
       g.their_verification, g.threadwork_verification
FROM gaps g
JOIN capability_taxonomy ct ON ct.id = g.capability_id
ORDER BY g.candidate, g.capability_id, g.id;

-- Gap frequency (what Threadwork is missing that multiple frameworks have)
SELECT g.capability_id, COUNT(DISTINCT g.candidate) as framework_count
FROM gaps g
WHERE g.verdict = 'gap'
GROUP BY g.capability_id
ORDER BY framework_count DESC, g.capability_id;

-- Absence support for gap claims
SELECT candidate, capability_id, search_terms, files_searched
FROM absence_searches
ORDER BY candidate, capability_id, id;
```

> **NOTE:** Phase 4 does NOT query `verification_checks`. Phase 5 (Verification) has not
> run yet at this point. Synthesis uses `evidence_summary` from `triage_scores` and the
> evidence fields from `gaps` only. The `verification_checks.interpretation_note` values
> are produced by Phase 5 and used for GATING (pass/fail), not for synthesis content.

**Output structure for gap-analysis.md:**
1. Methodology (how the pipeline works, what "code-verified" means)
2. Candidates evaluated (table with name, URL, status, elimination reason, monorepo/project path)
3. Triage matrix (25 dimensions x N candidates)
4. Comparative analysis per surviving candidate:
   - `gap`
   - `threadwork_stronger`
   - `equivalent`
5. Consolidated gap ranking (capabilities missing from Threadwork, ranked by how many frameworks implement them)
6. Every claim tagged with structured evidence:
   - `[code-verified: path:start-end]`
   - `[absent: searched terms X in files Y]`

**State update:** `phases.synthesis = "done"`

### Phase 5: Verification (factual accuracy gate)

**Tool:** verification agent
**Agent reads:** `findings.db` (via `sqlite3` CLI queries) + actual files in `repos/` and `{threadwork_root}`
**Agent writes to:** JSONL file at `/tmp/threadwork-comparison/agent-output/verification/{agent_id}.jsonl`
**Consolidator imports to:** `verification_checks` table + `review_gate` table

The verification agent verifies FULL COVERAGE, not samples.

#### 5A. Verify all comparison rows

1. Query all rows from `gaps` across all verdicts:
   - `gap`
   - `threadwork_stronger`
   - `equivalent`
2. For EACH row:
   - Read the cited candidate evidence range:
     - Does the file exist?
     - Does the content in the cited range support the claim?
   - Write a JSONL line for `verification_checks` with:
     - `gap_id`
     - `repo_side = 'candidate'`
     - structured cited path/lines
     - `file_exists`
     - `content_matches_claim`
     - `interpretation_note` — 1-2 sentences describing WHAT the cited code actually does
       (e.g., "Implements a priority queue with FIFO fallback for task assignment across agents"
       not "Code exists at this location"). The synthesis agent uses these notes for accurate
       capability descriptions, so they must be specific and substantive.
   - If `threadwork_verification = 'code-verified'`, also verify the Threadwork cited range:
     - Does the file exist?
     - Does the content in the cited range support the claim?
   - Write another JSONL line for `verification_checks` with:
     - `gap_id`
     - `repo_side = 'threadwork'`
     - structured cited path/lines
     - `file_exists`
     - `content_matches_claim`
     - `interpretation_note` — same requirement: describe WHAT the Threadwork code does
   - If `threadwork_verification = 'absent'`, verify process integrity:
     - Confirm that at least one matching `absence_searches` row exists for `(candidate, capability_id)`
     - Verify the `search_terms` are substantive (length > 10, not just a single generic word)
     - Verify that `files_searched` lists at least 3 files (contains at least 2 commas)
     - If any of these checks fail, record it as a verification failure

#### 5B. Verify all positive triage rows for surviving candidates

3. Query all `triage_scores` rows where:
   - `has_code = 1`
   - candidate is a surviving candidate (`candidates.status = 'deep-dive'` or otherwise marked as survivor)
4. For EACH such row:
   - Read the cited file/range
   - Verify the file exists
   - Verify the cited content supports `evidence_summary`
   - Write a JSONL line for `verification_checks` with:
     - `triage_candidate`
     - `triage_capability_id`
     - `repo_side = 'candidate'`
     - structured cited path/lines
     - `file_exists`
     - `content_matches_claim`
     - `interpretation_note` — 1-2 sentences describing WHAT the cited code does

#### 5C. Compute pass/fail

PASS only if ALL of the following are true:
- 100% of candidate-side citations in `gaps` verify
- 100% of Threadwork-side citations in `gaps` with `threadwork_verification = 'code-verified'` verify
- Every `gap` row with `threadwork_verification = 'absent'` has supporting `absence_searches` coverage with substantive search terms (length > 10) and at least 3 files searched
- 100% of verified `triage_scores.has_code = 1` rows for surviving candidates verify

FAIL if any citation does not verify or any required absence-tracking support is missing.

Write a JSONL line for `review_gate`:
- `phase = 'verification'`
- `verdict = 'pass'` or `'fail'`
- `failure_reasons` = JSON array of specific failed checks

If FAIL: the pipeline stops. Parent reports which citations or absence checks failed. Human decides how to proceed.

**State update:** `phases.verification = "done"` (or `"failed"`).

### Phase 5 to 6 Gate

**Phase 6 MUST NOT start unless `review_gate.verdict = 'pass'` for `phase = 'verification'`.**

```sql
SELECT verdict FROM review_gate WHERE phase = 'verification' ORDER BY checked_at DESC LIMIT 1;
```

If this returns `'fail'` or no rows, Phase 6 is blocked. The pipeline stops and reports
which verifications failed. Human decides how to proceed.

### Phase 6: Codex Review (design/methodology review)

**Tool:** `/codex:review --wait --scope working-tree` (via the Codex plugin skill)
**Reviews:** `gap-analysis.md` in the git working tree at `/tmp/threadwork-comparison/`

> **NOTE:** The skill is `/codex:review`, NOT `/codex:adversarial-review` (which does not
> exist as a skill). The adversarial review command lives at `commands/adversarial-review.md`
> in the codex plugin and is invoked differently. Use `/codex:review` with scope flags.

**Preparation steps (run by parent orchestrator before invoking Codex):**
1. Copy `gap-analysis.md` into the git repo initialized in Phase 0:
   ```bash
   cp /tmp/threadwork-comparison/output/gap-analysis.md /tmp/threadwork-comparison/gap-analysis.md
   cd /tmp/threadwork-comparison && git add gap-analysis.md && git commit -m "Add gap analysis for review"
   ```
2. Invoke `/codex:review --wait --scope working-tree` from within `/tmp/threadwork-comparison/`

This is NOT for factual accuracy (Phase 5 handles that). This reviews:
- Is the methodology sound?
- Are the comparison dimensions fair and complete?
- Are there obvious frameworks missing?
- Does the gap ranking make sense?
- Are there logical errors in the analysis?

**Codex unavailable fallback:** Set a 5-minute timeout on the Codex invocation. If Codex
fails to respond after one retry, write `phases.review = "skipped_codex_unavailable"` in
`state.json` and allow the pipeline to exit with a warning. Do not deadlock the pipeline
waiting for Codex indefinitely.

**State update:** `phases.review = "done"` if approve, `"failed"` if needs-attention,
`"skipped_codex_unavailable"` if Codex times out after retry.

### Phase 7: Cleanup

**Precondition:** BOTH of the following must be true:
- Latest `review_gate` row for `phase = 'verification'` has `verdict = 'pass'`
- Phase 6 Codex review has completed (`phases.review` is `"done"` or `"skipped_codex_unavailable"`)

The `repos/` directory must remain available for BOTH Phase 5 (verification) AND Phase 6
(Codex review). Codex may need to inspect cited file paths to validate claims
in `gap-analysis.md`. Deleting repos before Codex finishes would break citation validation.

**Tool:** Bash
**Action:**
1. Confirm both preconditions are met before proceeding
2. Remove cloned repos: `rm -rf repos/`
3. Update `repos.status = 'cleaned'` where appropriate
4. Update `state.json`:
   - `phases.cleanup = "done"`
   - `status = "complete"`

If verification did not pass OR Codex review has not completed (and is not skipped),
cleanup must NOT delete `repos/`, because those files are required for inspection,
re-verification, or Codex review.

---

## Agent Boundaries (hard rules)

| Agent | Reads | Writes to | Return value |
|---|---|---|---|
| Discovery | web only | prose brief (returned to parent) | Parsed by parent into JSONL |
| Clone (parent orchestrator) | repos (git) + SQLite | `repos` table + `candidates.status` (direct SQL) | N/A |
| Triage (per repo) | `repos/{name}/{project_path}` or `repos/{name}` only | JSONL (`triage_scores` rows) | DISCARDED |
| Deep-dive (per repo) | candidate project + `{threadwork_root}` | JSONL (`gaps`, `absence_searches` rows) | DISCARDED |
| Synthesis | SQL queries on findings.db (READ-ONLY) | `output/gap-analysis.md` | DISCARDED |
| Verification | `findings.db` (READ-ONLY) + `repos/` + `{threadwork_root}` | JSONL (`verification_checks`, `review_gate` rows) | DISCARDED |
| Codex | `gap-analysis.md` (via git working tree) | N/A (external) | Read by parent |
| Cleanup | filesystem + SQL state | `repos.status`, `state.json` | DISCARDED |
| **Consolidator** (run by parent) | JSONL files from agents | `findings.db` (SQLite) | rejection counts |
| Parent orchestrator | `state.json` + SQL aggregates | `state.json`, `candidates.status`, `findings.db` | N/A |

**HARD RULE:** Subagents never WRITE to SQLite. Read-only access is permitted for synthesis
and verification. The consolidator (run by parent between phases) is the ONLY process that
writes to `findings.db` based on agent JSONL output. The parent orchestrator itself CAN
write to SQLite directly (e.g., Phase 1.5 Clone), since the consolidator-only rule applies
to subagents, not the parent.

**HARD RULE:** Parent orchestrator NEVER reads raw repo source code or raw agent findings.
All agent return values are discarded. Parent reads state from SQLite only (after consolidation).
This is not a guideline — implementations that pass agent output to parent are incorrect.

---

## Capability Taxonomy Reference

All triage and deep-dive work must use this exact normalized taxonomy:

| capability_id | Description |
|---|---|
| memory_system | Persistent, short-term, semantic, episodic, or retrieval-backed memory |
| task_coordination | Task decomposition, assignment, claiming, queues, boards |
| decision_making | Voting, consensus, critique, arbitration, structured decisions |
| agent_lifecycle | Spawn, heartbeat, health, recovery, watchdog, lifecycle controls |
| learning_skills | Skill acquisition, procedural memory, self-improvement |
| enforcement_governance | Hooks, policies, governance, permissioning, guards |
| communications | Slack/Discord/Telegram/webhooks/notifications |
| tool_sandboxing | Sandboxed or isolated tool execution |
| workflow_dag | Workflow engines, DAGs, state machines, graph orchestration |
| human_in_loop | Human approval/review/manual checkpoints |
| observability_tracing | Telemetry, tracing, logs, spans, metrics |
| persistence_checkpointing | Checkpoints, snapshots, persisted execution state, resume |
| distributed_execution | Worker queues, broker-backed, distributed execution |
| security_isolation | RBAC, auth boundaries, tenancy, isolation |
| eval_benchmarking | Evals, benchmarks, scoring, test harnesses |
| model_routing | Provider/model routing, fallback, selection |
| prompt_management | Prompt templates, versioning, registries, system prompt management |
| artifact_management | Workspace, file, or artifact management across agent sessions |
| code_edit_engine | Code editing, patching, or file modification engine used by agents |
| session_state | Session or conversation state management across agent turns |
| planning_replanning | Task planning, replanning, or plan revision capabilities |
| error_recovery | Error recovery, retry semantics, or self-healing mechanisms |
| agent_topology | Multi-agent topology, role specialization, or team structure |
| context_management | Context window management, compression, or summarization |
| tool_registry | Tool registry, capability discovery, or dynamic tool loading |

---

## Exit Criteria (stop hook)

The stop hook at `~/.claude/hooks/threadwork-comparison-gate.sh`.

> **NOTE:** This hook file and its registration in `~/.claude/settings.json` must be
> created by Phase 0 (Init). The hook must be in place before the pipeline proceeds.

1. Check if `/tmp/threadwork-comparison/state.json` exists. If it does not exist, allow
   exit (exit 0) — the pipeline is not active.
2. Read `state.json` and check the `status` field. If `status` is not `"running"`, allow
   exit (exit 0).
3. Checks (all must be true to allow exit):

> **IMPORTANT:** The hook must NOT rely on environment variables like
> `THREADWORK_COMPARISON_ACTIVE`. Environment variables set in the parent session do not
> propagate to hook child processes. Instead, the hook reads `state.json` directly from
> disk to determine whether the pipeline is active.

```sql
-- 8+ candidates triaged (not just discovered — exclude clone-failed)
SELECT COUNT(*) >= 8 FROM candidates WHERE status IN ('triaged', 'deep-dive', 'eliminated');

-- 2+ candidates deep-dived (includes zero-gap candidates with sentinel rows)
SELECT COUNT(*) >= 2
FROM candidates
WHERE status = 'deep-dive';

-- All comparison rows have been verified (candidate side exists and matches)
SELECT COUNT(*) = 0
FROM gaps g
LEFT JOIN verification_checks vc
  ON g.id = vc.gap_id AND vc.repo_side = 'candidate' AND vc.file_exists = 1 AND vc.content_matches_claim = 1
WHERE vc.id IS NULL;

-- All code-verified threadwork claims also have passing threadwork-side verification
SELECT COUNT(*) = 0
FROM gaps g
LEFT JOIN verification_checks vc
  ON g.id = vc.gap_id AND vc.repo_side = 'threadwork' AND vc.file_exists = 1 AND vc.content_matches_claim = 1
WHERE g.threadwork_verification = 'code-verified'
  AND vc.id IS NULL;

-- All positive triage rows for surviving candidates have passing verification
SELECT COUNT(*) = 0
FROM triage_scores ts
JOIN candidates c ON c.name = ts.candidate
LEFT JOIN verification_checks vc
  ON vc.triage_candidate = ts.candidate
 AND vc.triage_capability_id = ts.capability_id
 AND vc.file_exists = 1
 AND vc.content_matches_claim = 1
WHERE ts.has_code = 1
  AND c.status = 'deep-dive'
  AND vc.id IS NULL;

-- Every gap row marked absent has supporting absence_searches coverage
SELECT COUNT(*) = 0
FROM gaps g
LEFT JOIN absence_searches a
  ON a.candidate = g.candidate
 AND a.capability_id = g.capability_id
WHERE g.verdict = 'gap'
  AND g.threadwork_verification = 'absent'
  AND a.id IS NULL;

-- Verification passed
SELECT verdict = 'pass'
FROM review_gate
WHERE phase = 'verification'
ORDER BY checked_at DESC
LIMIT 1;
```

4. Also check via bash:
   - `test -s output/gap-analysis.md`
5. If any check fails: exit 2 (block exit) with diagnostic output showing which checks failed.
6. If all pass: exit 0.

---

## Error Handling

| Error | Detection | Response |
|---|---|---|
| Clone fails (404, auth, timeout) | `repos.status = 'failed'` | Skip candidate, mark eliminated with reason `clone failed: {error}` |
| Clone exceeds disk budget | Cumulative `du -sk repos/ \| awk '{print $1 * 1024}'` > 2GB | Stop cloning, mark remaining as failed |
| Triage agent crashes | No `triage_scores` rows for candidate after agent returns | Mark candidate eliminated with reason `triage agent failed` |
| Triage writes fewer than 25 rows | Count mismatch in `triage_scores` | Mark candidate eliminated with reason `incomplete triage output` |
| Deep-dive agent crashes | No `gaps` rows for candidate after agent returns | Log error, continue with other candidates |
| Deep-dive records `gap` without absence tracking | `gap` row exists with no matching `absence_searches` | Verification FAIL |
| SQLite lock contention | `database is locked` in consolidator | Consolidator sets `PRAGMA busy_timeout = 5000;` and WAL mode (agents never write to SQLite directly) |
| Consolidator rejects rows | JSONL rows fail schema validation | Rejected rows logged to `{agent_id}.rejected.jsonl`; parent checks rejection count before proceeding |
| Consolidator rejection threshold | >20% of JSONL rows in a phase are rejected | **HALT the pipeline.** Report rejection count and reasons. Do not proceed to next phase. Human reviews and decides. |
| Monorepo project path wrong | `project_path` missing or auto-detection fails at clone time | Mark `repos.status = 'failed'` with error `could not locate framework root in monorepo`; eliminate candidate |
| Verification fails | `review_gate.verdict = 'fail'` | Pipeline stops. Human reviews `failure_reasons`, decides to re-run or accept |
| Cleanup attempted before verification pass or Codex review | verification gate not satisfied or `phases.review` not in `("done", "skipped_codex_unavailable")` | Do not delete `repos/`; leave filesystem intact for inspection and review |
| Codex unavailable or timeout | No response after 5 minutes + 1 retry | Write `phases.review = "skipped_codex_unavailable"` in state.json; allow exit with warning. Do not deadlock. |
| Codex returns needs-attention | Codex output | Pipeline stops. Human reviews Codex findings |
| Partial verification failure | Some candidates' citations fail verification while others pass | Parent can re-dispatch ONLY the failing deep-dive agent(s), re-consolidate their output, and re-verify — no need to restart the entire pipeline. Delete the failed candidate's JSONL + rejected JSONL, re-run agent, re-consolidate, re-verify. |

---

## Non-Negotiable Implementation Rules

1. All capability claims must be derived from source code, not READMEs, landing pages, or blog posts.
2. Subagents never WRITE to SQLite. Read-only access is permitted for synthesis and verification. The consolidator and parent orchestrator are the only processes that write to `findings.db`. All SQLite writers must set WAL mode and busy timeout on connect.
3. All triage work must use the 25-capability taxonomy and honor exclusion patterns.
4. All monorepo candidates must be scanned via `project_path` if provided and validated at clone time.
5. All deep-dive comparisons must use structured evidence fields with line ranges.
6. All candidate-side comparison rows are implicitly code-verified; unverified candidate claims must not be inserted.
7. Threadwork absence claims require explicit `absence_searches` documentation with substantive search terms and at least 3 files.
8. Verification covers all `gaps` rows across all verdicts and all positive triage rows for surviving candidates.
9. Cleanup must occur only after BOTH verification passes AND Codex review completes (or Codex is skipped due to unavailability).
10. Parent orchestrator must never consume raw agent output or raw repo source. SQLite (after consolidation) is the only shared state surface.
11. Subagents write JSONL files, not SQLite. The consolidator is the sole importer of agent output into `findings.db`. The parent orchestrator may write directly for its own operations (Phase 0 init, Phase 1.5 clone).
12. The stop hook and its `settings.json` registration must be created during Phase 0 (Init) before the pipeline proceeds.
13. `threadwork_root` in `state.json` must be an absolute path (no tilde). Resolve at init time.
14. All shell commands must be macOS-compatible: no `du -sb`, no `timeout`. Use `du -sk` (multiply by 1024) and the Bash tool's timeout parameter or Perl alarm wrapper.
15. The consolidator runs ONCE after all parallel agents in a phase complete, not per-agent. If >20% of JSONL rows are rejected, halt the pipeline.