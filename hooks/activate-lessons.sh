#!/usr/bin/env bash
# activate-lessons.sh — Wrapper for the Activate project's lessons-hook.sh
# Lives at a space-free path to avoid Claude Code hook execution issues
# with $CLAUDE_PROJECT_DIR and paths containing spaces.
#
# Resolution strategy:
#   1. Use $CLAUDE_PROJECT_DIR if set and valid
#   2. Fall back to git rev-parse --show-toplevel (works if cwd is in the repo)
#   3. Fall back to hardcoded project path

set -euo pipefail

HARDCODED="/Users/coachstokes/Documents/New project 4"

# Try CLAUDE_PROJECT_DIR first
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -x "$CLAUDE_PROJECT_DIR/tools/lessons-hook.sh" ]; then
  exec "$CLAUDE_PROJECT_DIR/tools/lessons-hook.sh"
fi

# Try git-based discovery (cwd is usually the project root during hook execution)
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$GIT_ROOT" ] && [ -x "$GIT_ROOT/tools/lessons-hook.sh" ]; then
  exec "$GIT_ROOT/tools/lessons-hook.sh"
fi

# Fall back to hardcoded path
if [ -x "$HARDCODED/tools/lessons-hook.sh" ]; then
  exec "$HARDCODED/tools/lessons-hook.sh"
fi

# If nothing works, exit silently (don't break Claude Code)
exit 0
