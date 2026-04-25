-- Alpha-Verify SQLite Schema
-- Multi-agent project verification system
-- Convention: TEXT PKs with AV_ prefix, WAL journal, CHECK constraints on enums

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Run lifecycle tracking
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY CHECK(run_id LIKE 'AV_%'),
    status TEXT NOT NULL DEFAULT 'init'
        CHECK(status IN ('init', 'scanning', 'verifying', 'comparing', 'passed', 'failed', 'exhausted', 'aborted')),
    attempt INTEGER NOT NULL DEFAULT 1,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    config TEXT NOT NULL DEFAULT '{}',  -- JSON blob
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    finished_at TEXT,
    final_score REAL,
    final_verdict TEXT CHECK(final_verdict IN ('pass', 'fail', 'exhausted', NULL))
);

-- Agent inbox/outbox messaging
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    message_type TEXT NOT NULL
        CHECK(message_type IN ('task', 'result', 'finding', 'query', 'response', 'status', 'error')),
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    in_reply_to INTEGER REFERENCES messages(id),
    is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Structured scanner findings
CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    attempt INTEGER NOT NULL DEFAULT 1,
    wave TEXT NOT NULL CHECK(wave IN ('scan', 'verify-a', 'verify-b')),
    agent TEXT NOT NULL,
    finding_type TEXT NOT NULL
        CHECK(finding_type IN ('task_complete', 'task_incomplete', 'task_missing', 'quality_issue', 'build_error', 'test_failure', 'pattern_violation', 'info')),
    severity TEXT NOT NULL DEFAULT 'medium'
        CHECK(severity IN ('critical', 'high', 'medium', 'low', 'info')),
    spec TEXT,           -- e.g. '001-auth', '005-admin'
    task_ref TEXT,       -- e.g. 'EPIC-001 > Task 3.2'
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '{}',  -- JSON: {file, line, snippet, command, output}
    confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0.0 AND confidence <= 1.0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Per-agent per-wave summary aggregations
CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    attempt INTEGER NOT NULL DEFAULT 1,
    wave TEXT NOT NULL CHECK(wave IN ('scan', 'verify-a', 'verify-b')),
    agent TEXT NOT NULL,
    total_checked INTEGER NOT NULL DEFAULT 0,
    passed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    confidence_avg REAL NOT NULL DEFAULT 0.0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(run_id, attempt, wave, agent),
    CHECK(passed + failed + skipped = total_checked)
);

-- Verifier assessments of scanner findings
CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    attempt INTEGER NOT NULL DEFAULT 1,
    verifier TEXT NOT NULL,
    finding_id INTEGER NOT NULL REFERENCES findings(id),
    agrees INTEGER NOT NULL CHECK(agrees IN (0, 1)),
    confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0.0 AND confidence <= 1.0),
    evidence TEXT NOT NULL DEFAULT '{}',  -- JSON
    disagreement_reason TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(run_id, attempt, verifier, finding_id),
    CHECK(agrees = 1 OR length(disagreement_reason) > 0)
);

-- Final A-vs-B comparison results
CREATE TABLE IF NOT EXISTS comparisons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    attempt INTEGER NOT NULL DEFAULT 1,
    comparator TEXT NOT NULL,  -- 'comparator-a' or 'comparator-b'
    total_findings INTEGER NOT NULL DEFAULT 0,
    agreed_count INTEGER NOT NULL DEFAULT 0,
    disagreed_count INTEGER NOT NULL DEFAULT 0,
    agreement_score REAL NOT NULL DEFAULT 0.0 CHECK(agreement_score >= 0.0 AND agreement_score <= 1.0),
    disagreements TEXT NOT NULL DEFAULT '[]',  -- JSON array of disagreement details
    final_verdict TEXT CHECK(final_verdict IN ('pass', 'fail', NULL)),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Key-value config store
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ============================================================
-- Views
-- ============================================================

-- Run dashboard: overview of current run state
CREATE VIEW IF NOT EXISTS run_dashboard AS
SELECT
    r.run_id,
    r.status,
    r.attempt,
    r.max_attempts,
    r.final_score,
    r.final_verdict,
    r.started_at,
    r.finished_at,
    (SELECT COUNT(*) FROM findings f WHERE f.run_id = r.run_id AND f.attempt = r.attempt) AS finding_count,
    (SELECT COUNT(*) FROM summaries s WHERE s.run_id = r.run_id AND s.attempt = r.attempt AND s.wave = 'scan') AS scanner_count,
    (SELECT COUNT(*) FROM verifications v WHERE v.run_id = r.run_id AND v.attempt = r.attempt) AS verification_count,
    (SELECT COUNT(*) FROM comparisons c WHERE c.run_id = r.run_id AND c.attempt = r.attempt) AS comparison_count
FROM runs r;

-- Disputed findings: where verifier disagreed with scanner
CREATE VIEW IF NOT EXISTS disputed_findings AS
SELECT
    f.id AS finding_id,
    f.run_id,
    f.attempt,
    f.agent AS scanner,
    f.finding_type,
    f.severity,
    f.spec,
    f.task_ref,
    f.title,
    f.confidence AS scanner_confidence,
    v.verifier,
    v.confidence AS verifier_confidence,
    v.disagreement_reason
FROM findings f
JOIN verifications v ON v.finding_id = f.id AND v.run_id = f.run_id
WHERE v.agrees = 0;

-- Unread inbox: pending messages per agent
CREATE VIEW IF NOT EXISTS unread_inbox AS
SELECT
    recipient,
    COUNT(*) AS unread_count,
    GROUP_CONCAT(sender, ', ') AS from_agents,
    MIN(created_at) AS oldest_unread
FROM messages
WHERE is_read = 0
GROUP BY recipient;

-- ============================================================
-- Partial indexes for performance
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_findings_failures
    ON findings(run_id, attempt) WHERE finding_type IN ('task_incomplete', 'task_missing', 'build_error', 'test_failure');

CREATE INDEX IF NOT EXISTS idx_verifications_disagreements
    ON verifications(run_id, attempt) WHERE agrees = 0;

CREATE INDEX IF NOT EXISTS idx_messages_unread
    ON messages(recipient, run_id) WHERE is_read = 0;

CREATE INDEX IF NOT EXISTS idx_findings_agent
    ON findings(run_id, attempt, agent);

CREATE INDEX IF NOT EXISTS idx_summaries_wave
    ON summaries(run_id, attempt, wave);
