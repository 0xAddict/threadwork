#!/usr/bin/env python3
"""
SubagentStop hook: reads thinking blocks from JSONL transcript and sends to Telegram.
"""
from __future__ import annotations

import json
import sys
import os
import urllib.request
import urllib.parse
import urllib.error
from typing import Optional

# Use TELEGRAM_BOT_TOKEN from env (set by telegram-pool.sh per agent).
# Hard-fail if missing — no plaintext fallback in committed source.
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
if not BOT_TOKEN:
    raise RuntimeError("TELEGRAM_BOT_TOKEN env var required")
# Always send to Snoopy's DM (chat_id 1712539766), never the group chat.
CHAT_ID = 1712539766


def send_telegram(text: str) -> None:
    """Send a message to Telegram via Bot API."""
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = json.dumps({
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            pass  # success
    except urllib.error.URLError:
        pass  # non-blocking — ignore network errors


def read_last_assistant_entry(jsonl_path: str) -> Optional[dict]:
    """Read JSONL file and return the last assistant message entry."""
    if not jsonl_path or not os.path.exists(jsonl_path):
        return None
    last_entry = None
    try:
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                # Look for assistant message entries
                msg_type = obj.get("type", "")
                if msg_type == "assistant":
                    last_entry = obj
                elif msg_type == "message" and obj.get("role") == "assistant":
                    last_entry = obj
    except OSError:
        return None
    return last_entry


def extract_thinking_blocks(entry: Optional[dict]) -> list:
    """Extract non-empty thinking blocks from an assistant message entry."""
    thinking_texts = []
    if entry is None:
        return thinking_texts

    # The message content may be at entry["message"]["content"] or entry["content"]
    content = None
    if "message" in entry and isinstance(entry["message"], dict):
        content = entry["message"].get("content", [])
    elif "content" in entry:
        content = entry["content"]

    if not isinstance(content, list):
        return thinking_texts

    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "thinking":
            thinking = block.get("thinking", "")
            if thinking and thinking.strip():
                thinking_texts.append(thinking.strip())

    return thinking_texts


def truncate(text: str, max_len: int) -> str:
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."


def main():
    # Read hook payload from stdin
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, OSError):
        payload = {}

    # Determine which transcript to use
    transcript_path = payload.get("agent_transcript_path") or payload.get("transcript_path") or ""
    session_id = payload.get("session_id", "")
    agent_id = payload.get("agent_id", "")
    last_assistant_msg = payload.get("last_assistant_message", "")

    # Try to get transcript path from environment if not in payload
    if not transcript_path:
        transcript_path = os.environ.get("CLAUDE_TRANSCRIPT_PATH", "")

    if not transcript_path:
        sys.exit(0)

    # Read the last assistant entry from JSONL
    last_entry = read_last_assistant_entry(transcript_path)
    thinking_blocks = extract_thinking_blocks(last_entry)

    if not thinking_blocks:
        # No thinking blocks found — nothing to send
        sys.exit(0)

    # Build message
    thinking_text = "\n\n---\n\n".join(thinking_blocks)
    thinking_text = truncate(thinking_text, 1000)

    label = agent_id if agent_id else session_id if session_id else "agent"

    parts = [f"<b>🧠 [{label} thinking]</b>", "", thinking_text]

    if last_assistant_msg:
        msg_preview = truncate(str(last_assistant_msg), 500)
        parts += ["", f"<b>💬</b> {msg_preview}"]

    message = "\n".join(parts)

    # Telegram messages max 4096 chars
    if len(message) > 4096:
        message = message[:4093] + "..."

    send_telegram(message)
    sys.exit(0)


if __name__ == "__main__":
    main()
