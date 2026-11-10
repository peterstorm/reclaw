#!/usr/bin/env python3
"""Transcribe one audio/video file with faster-whisper; print JSON on stdout.

Usage: ig-transcribe.py <media-path> <model>
Output: {"language": "en", "segments": [{"start": 0.0, "text": "..."}]}

faster-whisper decodes any container (mp4/m4a/...) itself via PyAV, so no ffmpeg step is
needed. Language is auto-detected. Progress and model-download noise go to stderr only.
"""
import json
import os
import sys

from faster_whisper import WhisperModel


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: ig-transcribe.py <media-path> <model>", file=sys.stderr)
        return 2
    media, model_name = sys.argv[1], sys.argv[2]

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
