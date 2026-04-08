#!/bin/bash
# tts-reply.sh — Generate OGG/opus voice message using ElevenLabs TTS
# Usage: ./tts-reply.sh "Text to speak" [voice_id]
# Requires: ELEVENLABS_API_KEY env var
# Outputs: path to generated .ogg file
#
# Voice personas (pass agent name as $2 or use voice_id directly):
#   steve  = cjVigY5qzO86Huf0OWal  (Eric - Smooth, Trustworthy)
#   boss   = pqHfZKP75CvOlQylNhV4  (Bill - Wise, Mature, Balanced)
#   kiera  = XrExE9yKIg1WjnnlVkGX  (Matilda - Knowledgable, Professional)
#   sadie  = cgSgspJ2msm6clMCkdW9  (Jessica - Playful, Bright, Warm)

set -e

TEXT="$1"
AGENT_OR_VOICE="${2:-steve}"

# Map agent names to voice IDs
case "$AGENT_OR_VOICE" in
  steve)  VOICE_ID="cjVigY5qzO86Huf0OWal" ;;
  boss)   VOICE_ID="pqHfZKP75CvOlQylNhV4" ;;
  kiera)  VOICE_ID="XrExE9yKIg1WjnnlVkGX" ;;
  sadie)  VOICE_ID="cgSgspJ2msm6clMCkdW9" ;;
  snoopy) VOICE_ID="SOYHLrjzK2X1ezoPC6cr" ;;  # Harry - Fierce Warrior
  *)      VOICE_ID="$AGENT_OR_VOICE" ;;  # raw voice_id passthrough
esac

if [ -z "$TEXT" ]; then
  echo "Usage: tts-reply.sh 'text to speak' [voice_id]" >&2
  exit 1
fi

if [ -z "$ELEVENLABS_API_KEY" ]; then
  echo "Error: ELEVENLABS_API_KEY not set" >&2
  exit 1
fi

TMPDIR="${TMPDIR:-/tmp}"
BASENAME="tts-$(date +%s)-$$"
MP3="$TMPDIR/${BASENAME}.mp3"
OGG="$TMPDIR/${BASENAME}.ogg"

# Call ElevenLabs API
curl -s -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}" \
  -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"text\": $(echo "$TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'), \"model_id\": \"eleven_flash_v2_5\"}" \
  --output "$MP3"

# Check if we got a valid audio file
if [ ! -s "$MP3" ]; then
  echo "Error: ElevenLabs returned empty response" >&2
  rm -f "$MP3"
  exit 1
fi

# Convert to OGG/opus for Telegram voice messages
FFMPEG="/Users/coachstokes/.local/bin/ffmpeg"
if [ ! -x "$FFMPEG" ]; then
  FFMPEG="ffmpeg"
fi

"$FFMPEG" -y -i "$MP3" -c:a libopus -b:a 48k -ar 48000 -ac 1 "$OGG" 2>/dev/null

# Clean up MP3 temp
rm -f "$MP3"

# Output the OGG path
echo "$OGG"
