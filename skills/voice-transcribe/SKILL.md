---
name: voice-transcribe
description: Transcribe voice messages and audio files using ffmpeg and OpenAI Whisper. Use whenever a Telegram voice message arrives (attachment_kind="voice", audio/ogg), when the user sends an audio file, asks to transcribe audio, or when you receive any .oga/.ogg/.mp3/.m4a/.wav file containing speech. Automatically triggers on inbound Telegram voice messages.
---

# voice-transcribe

Transcribe voice messages and audio files using ffmpeg for format conversion and OpenAI Whisper for speech-to-text. Automatically triggers on inbound Telegram voice messages so the agent can understand and respond to spoken content.

## When this triggers

- A Telegram message arrives with `attachment_kind="voice"` and `attachment_mime="audio/ogg"`
- The user sends any audio file and wants it transcribed
- You need to understand the content of a voice message to respond
- Any `.oga`/`.ogg`/`.mp3`/`.m4a`/`.wav` file containing speech arrives

## Pipeline

### Step 1: Download the audio

For Telegram voice messages, use the `download_attachment` tool with the `attachment_file_id` from the inbound message metadata:

```
download_attachment(file_id=<attachment_file_id>)
```

Returns a local file path (typically `.oga` format).

### Step 2: Convert to WAV with ffmpeg

Whisper works best with 16kHz mono WAV:

```bash
ffmpeg -i <input_file> -ar 16000 -ac 1 /tmp/voice_<message_id>.wav -y
```

- `-ar 16000` — resample to 16kHz (Whisper's expected sample rate)
- `-ac 1` — convert to mono
- `-y` — overwrite without prompting

ffmpeg is installed at `~/.local/bin/ffmpeg`.

### Step 3: Transcribe with Whisper

```bash
python3 -c "
import whisper
model = whisper.load_model('base')
result = model.transcribe('/tmp/voice_<message_id>.wav')
print(result['text'])
"
```

- Uses the `base` model — good balance of speed and accuracy
- Runs on CPU (FP16 warning is expected and harmless)
- For longer messages or better accuracy, use `small` or `medium` model
- Timeout should be generous (300s) for longer voice messages

### Step 4: Respond

After transcription:

1. Read the transcribed text
2. Respond to the content naturally — treat as if the user typed it
3. If transcription seems garbled or unclear, quote it back and ask for clarification

## Supported formats

ffmpeg handles conversion, so any common audio format works:

- `.oga` / `.ogg` (Telegram voice messages)
- `.mp3`
- `.m4a` / `.aac`
- `.wav`
- `.webm` (voice recordings from browsers)

## Notes

- Whisper installed via pip: `pip3 install openai-whisper`
- FP16 warning on CPU is normal — Whisper falls back to FP32 automatically
- Clean up temp WAV files after transcription if needed
- For very short messages (<5 seconds), transcription quality may vary
