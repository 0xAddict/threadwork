---
name: elevenlabs-tts
description: Generate natural-sounding text-to-speech audio using the ElevenLabs API. Use this skill whenever you need to produce a voice/audio reply instead of text — especially when a Telegram user sends a voice message asking for audio back ("can you reply via audio", "I'm driving and can't read"), when the user explicitly requests audio output, when you're making a spoken summary/briefing, or when you're tempted to fall back to macOS `say` (don't — it sounds robotic). Also use this when packaging a spoken message to a human who will listen rather than read. ALWAYS prefer this over `say` unless the user explicitly asks for the built-in voice.
---

# elevenlabs-tts

Generate natural-sounding speech via the ElevenLabs API and hand the resulting
MP3 back to the caller (typically a Telegram reply).

## Why this exists

macOS `say` is functional but sounds robotic — fine for a single beep of a
message, painful for anything longer than a sentence. ElevenLabs produces
natural prosody that holds up over 1–2 minute messages. When a human is going
to *listen* to your reply (driving, walking, eyes on something else), the
quality difference matters. Prefer this skill over `say` unless the user
explicitly asks for the built-in voice.

## When to fire

Trigger whenever any of these are true:

- A Telegram user sent a voice message and asked for an audio reply
  ("can you reply via audio", "I'm driving and can't read this", "send it as
  voice", etc.)
- The user explicitly asks for audio / voice / spoken output
- You're producing a spoken summary, briefing, or status update meant to be
  listened to rather than read
- You were about to reach for macOS `say` — stop and use this instead
- You're packaging a message for a human who will listen rather than read

Don't fire when the user is happy with text, or when they explicitly request
`say`/`afplay`/the system voice.

## How to invoke

The skill is a thin wrapper around one script:

```
~/.claude/skills/elevenlabs-tts/scripts/tts.py
```

Basic usage:

```bash
python3 ~/.claude/skills/elevenlabs-tts/scripts/tts.py "Hey Coach, quick update on the booking system."
```

The script prints a tab-separated line on success:

```
<output_path>\t<duration mm:ss>\t<size KB>\t<voice_display>
```

The output path on stdout is what you attach to a Telegram reply (`files=[path]`)
or hand off to whoever needs the audio. Stderr carries a progress line and any
error message. Non-zero exit means it failed — read stderr.

### Input modes

Three ways to pass text in — pick whichever fits your situation:

```bash
# Positional string arg (best for short replies you're composing inline)
python3 ~/.claude/skills/elevenlabs-tts/scripts/tts.py "Short message here."

# From a file (best for long-form scripts you've already drafted)
python3 ~/.claude/skills/elevenlabs-tts/scripts/tts.py --file /tmp/script.txt

# From stdin (best when piping output of another command)
echo "Quick update." | python3 ~/.claude/skills/elevenlabs-tts/scripts/tts.py -
```

### Voice selection

The script defaults to **brian** (deep, resonant, comforting — the
direct-but-warm observer tone Stokes prefers for honest critique and
straight-talk). Override with `--voice <name>` or `--voice <voice_id>`.

Curated voices baked into the script (see `VOICES` dict in `tts.py` for
descriptions):

| Tone needed | Voice |
|---|---|
| Default / honest critique / straight-talk | `brian` |
| Weight / authority | `adam` |
| Professional / credible | `eric` |
| Casual / friendly | `chris` |
| Warm narration | `george` |
| Formal British broadcaster | `daniel` |
| Default female / reassuring | `sarah` |
| Expert / technical | `matilda` |
| Playful / upbeat | `jessica` |
| Polished business comms | `bella` |

You can also pass a raw 20+ character ElevenLabs voice_id and it will be used
directly without lookup.

### Tuning knobs

Defaults are tuned for natural delivery; only touch these if a particular reply
sounds off:

- `--model <id>` — default `eleven_multilingual_v2`
- `--stability 0.0–1.0` — default `0.45` (lower = more expressive, higher = more consistent)
- `--similarity-boost 0.0–1.0` — default `0.75`
- `--style 0.0–1.0` — default `0.3`
- `--no-speaker-boost` — disable speaker boost (on by default)

### Output path

By default the script writes to `/tmp/elevenlabs-<unix_ts>.mp3`. Pass
`--output /path/to/file.mp3` (or `-o`) to control destination. Parent
directories are created automatically.

## Required environment

The script needs an ElevenLabs API key. Resolution order:

1. `--api-key <value>` CLI flag (rarely useful — leaks in process lists)
2. `ELEVENLABS_API_KEY` environment variable
3. `~/.claude/mcp-servers/task-board/.env` — line of the form
   `ELEVENLABS_API_KEY=...`

The third path is the production setup — the key already lives in the
task-board `.env` so the script Just Works on this machine. If you get an
exit code 2 with `no ElevenLabs API key found`, fix one of those three
sources rather than hardcoding.

The script also needs `httpx` (pip-installed) and, for accurate duration
reporting, either `ffprobe` or `ffmpeg` somewhere on PATH or in
`~/.local/bin`. Duration display falls back to `?` if neither is found —
the MP3 is still produced.

## Output format & handoff

- Format: MP3 (audio/mpeg) at ElevenLabs' default bitrate
- Default location: `/tmp/elevenlabs-<unix_ts>.mp3`
- Telegram handoff: pass the path to the Telegram reply tool via
  `files=["/tmp/elevenlabs-XXXXXXXXXX.mp3"]`. Voice notes and audio files
  both work; Telegram renders MP3 as a playable audio attachment.
- Cleanup: `/tmp` is volatile across reboots, which is fine for ephemeral
  replies. If you need to keep the audio long-term, pass `--output` to a
  durable path.

## Exit codes

- `0` — success, path printed on stdout
- `2` — bad input (no text, unknown voice, missing API key)
- `3` — missing `httpx` dependency
- `4` — network/HTTP transport failure
- `5` — ElevenLabs returned non-200 (status + first 500 chars of body on stderr)

## Implementation reference

The full implementation lives in
[`scripts/tts.py`](scripts/tts.py) — read it directly when you need to
extend voices, change defaults, or debug a failure mode. The SKILL.md is
intentionally a wrapper; the script is the source of truth for behavior.
