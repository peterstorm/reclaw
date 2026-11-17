#!/usr/bin/env python3
"""Transcribe one audio/video file with faster-whisper; print JSON on stdout.

Usage: ig-transcribe.py <media-path> <model>
Output: {"language": "en", "segments": [{"start": 0.0, "text": "..."}]}

faster-whisper decodes any container (mp4/m4a/...) itself via PyAV, so no ffmpeg step is
needed. Language is auto-detected. Progress and model-download noise go to stderr only.

A file without an audio track (silent reels that only show text) has nothing to transcribe:
it prints {"language": "und", "segments": []} ("und" = ISO 639-2 undetermined) rather than
letting PyAV fail on the missing stream.
"""
import json
import os
import sys

import av
from faster_whisper import WhisperModel


def has_audio(media: str) -> bool:
    with av.open(media) as container:
        return len(container.streams.audio) > 0


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: ig-transcribe.py <media-path> <model>", file=sys.stderr)
        return 2
    media, model_name = sys.argv[1], sys.argv[2]

    if not has_audio(media):
        json.dump({"language": "und", "segments": []}, sys.stdout)
        return 0

    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        cpu_threads=os.cpu_count() or 4,
    )
    segments, info = model.transcribe(media, vad_filter=True, beam_size=5)
    payload = {
        "language": info.language,
        "segments": [{"start": round(s.start, 2), "text": s.text.strip()} for s in segments],
    }
    json.dump(payload, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
