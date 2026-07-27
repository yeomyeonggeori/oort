#!/usr/bin/env python3
"""Run one post-call participant-track transcription job manifest."""

from __future__ import annotations

import argparse
import json
import uuid
from pathlib import Path

from merge_tracks import merge_tracks, speaker_labeled_text
from transcription_common import load_model_lock, make_backend


def validate_attachment_id(raw: str) -> str:
    return str(uuid.UUID(raw))


def run_job(args: argparse.Namespace) -> dict:
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    lock = load_model_lock()
    models = {model["name"]: model for model in lock["models"]}
    model_name = manifest["model"]
    if model_name not in models:
        raise ValueError(f"manifest model must be one of: {', '.join(models)}")
    tracks = manifest.get("tracks", [])
    if not tracks:
        raise ValueError("job manifest must contain at least one participant track")
    backend = make_backend(
        args.backend,
        threads=args.threads,
        device=args.device,
        compute_type=args.compute_type,
        cache_dir=args.cache_dir,
    )
    track_documents = []
    for track in tracks:
        source_attachment_id = validate_attachment_id(track["source_attachment_id"])
        audio_path = Path(track["audio_path"])
        if not audio_path.is_file():
            raise ValueError(f"materialized track audio is missing: {audio_path}")
        segments = backend.transcribe(
            audio_path,
            models[model_name],
            track.get("mock_reference") if args.backend == "mock" else None,
        )
        track_documents.append(
            {
                "member_id": str(uuid.UUID(track["member_id"])),
                "speaker": track["speaker"],
                "start_offset_ms": int(track.get("start_offset_ms", 0)),
                "source_attachment_id": source_attachment_id,
                "segments": [
                    {
                        "start_ms": segment.start_ms,
                        "end_ms": segment.end_ms,
                        "text": segment.text,
                    }
                    for segment in segments
                ],
            }
        )

    merged = merge_tracks(track_documents)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "track-transcripts.json").write_text(
        json.dumps(track_documents, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (args.output_dir / "merged-transcript.json").write_text(
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (args.output_dir / "speaker-labeled.txt").write_text(
        speaker_labeled_text(merged), encoding="utf-8"
    )
    receipt = {
        "job_id": str(uuid.UUID(manifest["job_id"])),
        "model": model_name,
        "model_repository": models[model_name]["repository"],
        "model_revision": models[model_name]["revision"],
        "track_count": len(track_documents),
        "segment_count": len(merged),
        "durable_storage": {
            "contract": "attachment",
            "required_next_step": (
                "upload speaker-labeled.txt and merged-transcript.json through "
                "POST /attachments/uploads -> uploadUrl PUT -> POST /complete, then "
                "set huddle_transcription_job.merged_transcript_attachment_id"
            ),
        },
    }
    (args.output_dir / "job-receipt.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return receipt


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--backend", choices=["faster-whisper", "mock"], default="faster-whisper")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--cache-dir", type=Path, default=Path(".cache/momo-transcription"))
    args = parser.parse_args()
    if args.threads < 1:
        parser.error("--threads must be at least 1")
    return args


if __name__ == "__main__":
    run_job(parse_args())
