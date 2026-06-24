#!/usr/bin/env python3
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path


def approve(message="harness stop gate: inactive"):
    print(json.dumps({"decision": "approve", "reason": message}))
    sys.exit(0)


def block(reason):
    print(json.dumps({"decision": "block", "reason": reason, "systemMessage": reason}))
    sys.exit(0)


def read_json_stdin():
    try:
        raw = sys.stdin.read() or "{}"
        return json.loads(raw)
    except Exception:
        return {}


def sha256_matches(contract_path, checksum_path):
    try:
        expected_line = checksum_path.read_text().strip()
        expected = expected_line.split()[0]
        actual = subprocess.check_output(["shasum", "-a", "256", str(contract_path)], text=True).split()[0]
        return expected == actual
    except Exception:
        return False


def no_write_bits(path):
    mode = path.stat().st_mode
    return (mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH)) == 0


def parse_pass(status_text):
    match = re.match(r"^PASS\s+(\d+)/(\d+)\s*$", status_text)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


payload = read_json_stdin()
session_id = payload.get("session_id", "")
project_dir = Path(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd())
marker = project_dir / ".harness" / "active-session.json"

if not marker.exists():
    approve()

try:
    cfg = json.loads(marker.read_text())
except Exception as exc:
    block(f"harness stop gate: invalid active-session.json: {exc}")

if cfg.get("session_id") and cfg["session_id"] != session_id:
    approve("harness stop gate: marker belongs to a different session")

sprint_dir = Path(cfg["sprint_dir"])
contract_path = Path(cfg["contract_path"])
threshold_n = int(cfg["threshold_n"])
threshold_m = int(cfg["threshold_m"])
codex_verify = bool(cfg.get("codex_verify", False))

status_path = sprint_dir / "status.txt"
report_path = sprint_dir / "verifier-report.md"
checksum_path = sprint_dir / "evidence" / "approved-contract.sha256"
codex_report_path = sprint_dir / "codex-adversarial-report.md"

missing = [str(p) for p in [contract_path, status_path, report_path, checksum_path] if not p.exists()]
if missing:
    block("harness stop gate: missing required evidence: " + ", ".join(missing))

if not no_write_bits(contract_path):
    block(f"harness stop gate: contract is still writable: {contract_path}")

if not sha256_matches(contract_path, checksum_path):
    block("harness stop gate: approved-contract checksum mismatch; contract may have changed after approval")

status = status_path.read_text().strip()
parsed = parse_pass(status)
if not parsed:
    block(f"harness stop gate: status is not terminal PASS: {status!r}")

passed, total = parsed
if total != threshold_m or passed < threshold_n:
    block(f"harness stop gate: PASS score {passed}/{total} does not satisfy required {threshold_n}/{threshold_m}")

report = report_path.read_text(errors="replace")
if f"{passed}/{total}" not in report:
    block("harness stop gate: verifier report does not contain the terminal PASS score")

if codex_verify:
    if not codex_report_path.exists():
        block("harness stop gate: --codex red-team gate enabled but codex-adversarial-report.md is missing")
    codex_report = codex_report_path.read_text(errors="replace")
    if "ADVERSARIAL PASS" not in codex_report:
        block("harness stop gate: Codex red-team has not written ADVERSARIAL PASS (it could not yet confirm the build survives)")

approve(f"harness stop gate: PASS {passed}/{total}, immutable contract verified")
