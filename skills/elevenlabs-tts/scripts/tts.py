#!/usr/bin/env python3
"""
elevenlabs-tts — Generate natural-sounding speech via the ElevenLabs API.

Usage examples:
  # From a string arg
  python3 tts.py "Hey Coach, checking in on the Google Ads setup."

  # From a file
  python3 tts.py --file /tmp/script.txt

  # From stdin
  echo "Quick update on the booking system." | python3 tts.py -

  # Pick a different voice by name
  python3 tts.py --voice Adam "This is Adam speaking."

  # Pick by voice_id
  python3 tts.py --voice EXAVITQu4vr4xnSDxMaL "Hi, I'm Sarah."

  # Custom output path
  python3 tts.py --output /tmp/reply.mp3 "Custom destination."

Why this exists:
  macOS `say` is functional but sounds robotic. ElevenLabs produces natural
  prosody that holds up over 1-2 minute messages — important when you're
  replying to a human driving or otherwise can't read text.

API key resolution order:
  1. --api-key flag
  2. ELEVENLABS_API_KEY environment variable
  3. ~/.claude/mcp-servers/task-board/.env (ELEVENLABS_API_KEY=...)

Exits non-zero on any failure. Prints the output path and duration on success.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path


# Curated voice picker. Add new voices here as you find ones you like.
# These are the tested-good ones for a direct-but-warm observer tone.
VOICES = {
    # Male
    "brian":   ("nPczCjzI2devNBz1zQrb", "Deep, resonant, comforting — default for honest critique / straight-talk"),
    "adam":    ("pNInz6obpgDQGcFmaJgB", "Dominant, firm — use when you need weight / authority"),
    "eric":    ("cjVigY5qzO86Huf0OWal", "Smooth, trustworthy — use for professional / credible delivery"),
    "chris":   ("iP95p4xoKVk53GoZ742B", "Charming, down-to-earth — use for casual / friendly messages"),
    "george":  ("JBFqnCBsd6RMkjVDRZzb", "Warm, captivating British storyteller — use for narration"),
    "daniel":  ("onwK4e9ZLuTAKqWW03F9", "Steady British broadcaster — use for news / formal updates"),
    # Female
    "sarah":   ("EXAVITQu4vr4xnSDxMaL", "Mature, reassuring, confident — default female voice"),
    "matilda": ("XrExE9yKIg1WjnnlVkGX", "Knowledgeable, professional — use for expert / technical delivery"),
    "jessica": ("cgSgspJ2msm6clMCkdW9", "Playful, bright, warm — use for friendly / upbeat messages"),
    "bella":   ("hpp4J3VqNfWAUOO0d1Us", "Professional, bright, warm — use for polished business comms"),
}

DEFAULT_VOICE = "brian"
DEFAULT_MODEL = "eleven_multilingual_v2"
DEFAULT_OUTPUT_DIR = "/tmp"
DOTENV_PATH = Path.home() / ".claude" / "mcp-servers" / "task-board" / ".env"


def resolve_api_key(cli_key: str | None) -> str:
    """Resolve the ElevenLabs API key from CLI, env, or .env file."""
    if cli_key:
        return cli_key
    env_key = os.environ.get("ELEVENLABS_API_KEY")
    if env_key:
        return env_key
    if DOTENV_PATH.exists():
        for line in DOTENV_PATH.read_text().splitlines():
            m = re.match(r"\s*ELEVENLABS_API_KEY\s*=\s*(.+?)\s*$", line)
            if m:
                val = m.group(1).strip().strip('"').strip("'")
                if val:
                    return val
    sys.stderr.write(
        "ERROR: no ElevenLabs API key found. Set ELEVENLABS_API_KEY env var, "
        f"pass --api-key, or add it to {DOTENV_PATH}\n"
    )
    sys.exit(2)


def resolve_voice(voice: str) -> tuple[str, str]:
    """Resolve a voice name or voice_id to (voice_id, display_name)."""
    # If it looks like a voice_id (20-char alphanumeric), pass through
    if re.fullmatch(r"[A-Za-z0-9]{20,}", voice):
        return voice, voice
    key = voice.lower().strip()
    if key in VOICES:
        return VOICES[key][0], key.capitalize()
    sys.stderr.write(
        f"ERROR: unknown voice '{voice}'. Known names: {', '.join(VOICES.keys())}\n"
        f"Or pass a raw voice_id (20+ alphanumeric chars).\n"
    )
    sys.exit(2)


def read_text(args: argparse.Namespace) -> str:
    """Pull the text from --file, stdin ('-'), or positional arg."""
    if args.file:
        return Path(args.file).read_text()
    if args.text == "-" or (args.text is None and not sys.stdin.isatty()):
        return sys.stdin.read()
    if args.text:
        return args.text
    sys.stderr.write("ERROR: no text provided. Pass a string arg, --file, or pipe via stdin.\n")
    sys.exit(2)


def get_duration_seconds(path: Path) -> float | None:
    """Best-effort duration lookup; returns None if no probe tool is available."""
    import subprocess
    # Try ffprobe first (precise format=duration output)
    for ffprobe in ("ffprobe", str(Path.home() / ".local" / "bin" / "ffprobe")):
        try:
            r = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                capture_output=True, text=True, timeout=10,
            )
            if r.returncode == 0 and r.stdout.strip():
                return float(r.stdout.strip())
        except (FileNotFoundError, ValueError):
            continue
    # Fall back to parsing ffmpeg stderr — ffmpeg is more commonly installed
    for ffmpeg in ("ffmpeg", str(Path.home() / ".local" / "bin" / "ffmpeg")):
        try:
            r = subprocess.run(
                [ffmpeg, "-i", str(path)],
                capture_output=True, text=True, timeout=10,
            )
            # ffmpeg writes "Duration: HH:MM:SS.ss, ..." to stderr even on -i alone
            m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", r.stderr)
            if m:
                h, mins, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
                return h * 3600 + mins * 60 + s
        except FileNotFoundError:
            continue
    return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate TTS audio via ElevenLabs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Voice cheat sheet:\n"
            + "\n".join(f"  {n:10s} {vid}  {desc}" for n, (vid, desc) in VOICES.items())
        ),
    )
    parser.add_argument("text", nargs="?", help="Text to speak (use '-' for stdin)")
    parser.add_argument("--file", help="Read text from a file")
    parser.add_argument("--voice", default=DEFAULT_VOICE,
                        help=f"Voice name or voice_id (default: {DEFAULT_VOICE})")
    parser.add_argument("--output", "-o",
                        help="Output MP3 path (default: /tmp/elevenlabs-<timestamp>.mp3)")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help=f"ElevenLabs model id (default: {DEFAULT_MODEL})")
    parser.add_argument("--stability", type=float, default=0.45,
                        help="Voice stability 0.0-1.0 (default: 0.45)")
    parser.add_argument("--similarity-boost", type=float, default=0.75,
                        help="Similarity boost 0.0-1.0 (default: 0.75)")
    parser.add_argument("--style", type=float, default=0.3,
                        help="Style exaggeration 0.0-1.0 (default: 0.3)")
    parser.add_argument("--no-speaker-boost", action="store_true",
                        help="Disable use_speaker_boost (default: on)")
    parser.add_argument("--api-key", help="Override API key (default: env / .env)")
    args = parser.parse_args()

    text = read_text(args)
    if not text.strip():
        sys.stderr.write("ERROR: text is empty.\n")
        return 2

    api_key = resolve_api_key(args.api_key)
    voice_id, voice_display = resolve_voice(args.voice)

    output = Path(args.output) if args.output else Path(
        DEFAULT_OUTPUT_DIR) / f"elevenlabs-{int(time.time())}.mp3"
    output.parent.mkdir(parents=True, exist_ok=True)

    try:
        import httpx
    except ImportError:
        sys.stderr.write("ERROR: httpx not installed. Run: pip3 install httpx\n")
        return 3

    sys.stderr.write(f"Generating {len(text)} chars with voice={voice_display} ({voice_id}) → {output}\n")

    try:
        resp = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
            headers={
                "xi-api-key": api_key,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
            json={
                "text": text,
                "model_id": args.model,
                "voice_settings": {
                    "stability": args.stability,
                    "similarity_boost": args.similarity_boost,
                    "style": args.style,
                    "use_speaker_boost": not args.no_speaker_boost,
                },
            },
            timeout=180,
        )
    except httpx.HTTPError as e:
        sys.stderr.write(f"ERROR: network/HTTP failure: {e}\n")
        return 4

    if resp.status_code != 200:
        sys.stderr.write(f"ERROR: ElevenLabs returned HTTP {resp.status_code}: {resp.text[:500]}\n")
        return 5

    output.write_bytes(resp.content)

    duration = get_duration_seconds(output)
    size_kb = len(resp.content) / 1024
    if duration is not None:
        mins, secs = divmod(duration, 60)
        print(f"{output}\t{int(mins)}:{int(secs):02d}\t{size_kb:.0f} KB\t{voice_display}")
    else:
        print(f"{output}\t?\t{size_kb:.0f} KB\t{voice_display}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
