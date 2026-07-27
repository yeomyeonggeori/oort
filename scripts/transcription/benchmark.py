#!/usr/bin/env python3
"""Run the three pinned Korean ASR candidates and emit CER/RTF tables."""

from __future__ import annotations

import argparse
import csv
import json
import time
from pathlib import Path

from transcription_common import (
    SUPPORTED_AUDIO_SUFFIXES,
    audio_duration_seconds,
    cer_counts,
    load_model_lock,
    make_backend,
)


def corpus(audio_dir: Path, reference_dir: Path) -> list[tuple[Path, Path]]:
    pairs = []
    for audio in sorted(
        path for path in audio_dir.iterdir() if path.suffix.lower() in SUPPORTED_AUDIO_SUFFIXES
    ):
        reference = reference_dir / f"{audio.stem}.txt"
        if not reference.is_file():
            raise ValueError(f"missing reference transcript: {reference}")
        pairs.append((audio, reference))
    if not pairs:
        raise ValueError(f"no supported audio files in {audio_dir}")
    return pairs


def run(args: argparse.Namespace) -> list[dict]:
    lock = load_model_lock()
    pairs = corpus(args.audio_dir, args.reference_dir)
    results = []
    for model in lock["models"]:
        backend = make_backend(
            args.backend,
            threads=args.threads,
            device=args.device,
            compute_type=args.compute_type,
            cache_dir=args.cache_dir,
        )
        started = time.perf_counter()
        edits = 0
        characters = 0
        audio_seconds = 0.0
        for audio, reference_path in pairs:
            reference = reference_path.read_text(encoding="utf-8")
            segments = backend.transcribe(audio, model, reference)
            hypothesis = " ".join(segment.text for segment in segments)
            item_edits, item_characters = cer_counts(reference, hypothesis)
            edits += item_edits
            characters += item_characters
            audio_seconds += audio_duration_seconds(audio)
        elapsed = time.perf_counter() - started
        results.append(
            {
                "model": model["name"],
                "model_repository": model["repository"],
                "model_revision": model["revision"],
                "backend": lock["backend"]["name"],
                "backend_version": lock["backend"]["version"],
                "backend_commit": lock["backend"]["sourceCommit"],
                "threads": args.threads,
                "files": len(pairs),
                "audio_seconds": round(audio_seconds, 3),
                "elapsed_seconds": round(elapsed, 3),
                "rtf": round(elapsed / audio_seconds, 6),
                "cer": round(edits / characters, 6),
                "cer_percent": round(edits / characters * 100, 3),
            }
        )
    return results


def write_results(output_dir: Path, results: list[dict]) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "results.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    with (output_dir / "results.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(results[0]))
        writer.writeheader()
        writer.writerows(results)
    lines = [
        "| 모델 | 커밋 | 스레드 | 오디오(초) | 처리시간(초) | RTF | CER | 판정 |",
        "|---|---|---:|---:|---:|---:|---:|---|",
    ]
    for result in results:
        lines.append(
            "| {model} | `{revision}` | {threads} | {audio:.3f} | {elapsed:.3f} | "
            "{rtf:.6f} | {cer:.3f}% | |".format(
                model=result["model"],
                revision=result["model_revision"],
                threads=result["threads"],
                audio=result["audio_seconds"],
                elapsed=result["elapsed_seconds"],
                rtf=result["rtf"],
                cer=result["cer_percent"],
            )
        )
    (output_dir / "results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio-dir", type=Path, required=True)
    parser.add_argument("--reference-dir", type=Path, required=True)
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
    arguments = parse_args()
    write_results(arguments.output_dir, run(arguments))
