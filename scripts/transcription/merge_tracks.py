#!/usr/bin/env python3
"""Timestamp-merge participant-track transcripts; track identity is the speaker."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def merge_tracks(track_documents: list[dict]) -> list[dict]:
    merged = []
    for track in track_documents:
        speaker = track["speaker"].strip()
        member_id = track["member_id"]
        offset = int(track.get("start_offset_ms", 0))
        if not speaker or offset < 0:
            raise ValueError("speaker is required and start_offset_ms must be non-negative")
        for segment in track["segments"]:
            start_ms = int(segment["start_ms"]) + offset
            end_ms = int(segment["end_ms"]) + offset
            if start_ms < 0 or end_ms < start_ms:
                raise ValueError("invalid segment timestamps")
            merged.append(
                {
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "member_id": member_id,
                    "speaker": speaker,
                    "text": segment["text"].strip(),
                }
            )
    return sorted(
        (segment for segment in merged if segment["text"]),
        key=lambda segment: (
            segment["start_ms"],
            segment["end_ms"],
            segment["member_id"],
        ),
    )


def speaker_labeled_text(segments: list[dict]) -> str:
    lines = []
    for segment in segments:
        total_seconds = segment["start_ms"] // 1_000
        minutes, seconds = divmod(total_seconds, 60)
        lines.append(f"[{minutes:02d}:{seconds:02d}] {segment['speaker']}: {segment['text']}")
    return "\n".join(lines) + ("\n" if lines else "")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tracks", type=Path, required=True)
    parser.add_argument("--output-json", type=Path, required=True)
    parser.add_argument("--output-text", type=Path, required=True)
    args = parser.parse_args()
    documents = json.loads(args.tracks.read_text(encoding="utf-8"))
    merged = merge_tracks(documents)
    args.output_json.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    args.output_text.write_text(speaker_labeled_text(merged), encoding="utf-8")


if __name__ == "__main__":
    main()
