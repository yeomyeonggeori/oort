#!/usr/bin/env python3
"""Shared deterministic ASR harness primitives for MOMO-646."""

from __future__ import annotations

import json
import subprocess
import unicodedata
import wave
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

ROOT = Path(__file__).resolve().parent
MODEL_LOCK_PATH = ROOT / "model-lock.json"
SUPPORTED_AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus"}


@dataclass(frozen=True)
class Segment:
    start_ms: int
    end_ms: int
    text: str


class TranscriptionBackend(Protocol):
    def transcribe(
        self, audio_path: Path, model: dict[str, str], reference_text: str | None = None
    ) -> list[Segment]: ...


def load_model_lock() -> dict:
    lock = json.loads(MODEL_LOCK_PATH.read_text(encoding="utf-8"))
    names = [item["name"] for item in lock["models"]]
    if names != ["small", "medium", "large-v3-turbo"]:
        raise ValueError("model-lock.json must preserve the required three-model order")
    return lock


class FasterWhisperBackend:
    def __init__(self, *, threads: int, device: str, compute_type: str, cache_dir: Path):
        self.threads = threads
        self.device = device
        self.compute_type = compute_type
        self.cache_dir = cache_dir
        self._models: dict[str, object] = {}
        self._decode = load_model_lock()["decode"]

    def _load(self, model: dict[str, str]):
        cache_key = f"{model['repository']}@{model['revision']}"
        if cache_key in self._models:
            return self._models[cache_key]
        try:
            from faster_whisper import WhisperModel
            from huggingface_hub import snapshot_download
        except ImportError as error:
            raise RuntimeError(
                "install scripts/transcription/requirements.lock before a real benchmark"
            ) from error
        snapshot = snapshot_download(
            repo_id=model["repository"],
            revision=model["revision"],
            cache_dir=str(self.cache_dir),
        )
        loaded = WhisperModel(
            snapshot,
            device=self.device,
            compute_type=self.compute_type,
            cpu_threads=self.threads,
            local_files_only=True,
        )
        self._models[cache_key] = loaded
        return loaded

    def transcribe(
        self, audio_path: Path, model: dict[str, str], reference_text: str | None = None
    ) -> list[Segment]:
        del reference_text
        whisper = self._load(model)
        segments, _ = whisper.transcribe(
            str(audio_path),
            language=self._decode["language"],
            beam_size=self._decode["beamSize"],
            temperature=self._decode["temperature"],
            vad_filter=self._decode["vadFilter"],
            condition_on_previous_text=self._decode["conditionOnPreviousText"],
        )
        return [
            Segment(
                start_ms=round(segment.start * 1_000),
                end_ms=round(segment.end * 1_000),
                text=segment.text.strip(),
            )
            for segment in segments
            if segment.text.strip()
        ]


class MockBackend:
    """No-model backend used only by the checked-in silence self-test."""

    def transcribe(
        self, audio_path: Path, model: dict[str, str], reference_text: str | None = None
    ) -> list[Segment]:
        del model
        duration_ms = round(audio_duration_seconds(audio_path) * 1_000)
        text = (reference_text or "").strip()
        return [Segment(start_ms=0, end_ms=duration_ms, text=text)] if text else []


def make_backend(
    name: str, *, threads: int, device: str, compute_type: str, cache_dir: Path
) -> TranscriptionBackend:
    if name == "mock":
        return MockBackend()
    if name != "faster-whisper":
        raise ValueError(f"unsupported backend: {name}")
    return FasterWhisperBackend(
        threads=threads, device=device, compute_type=compute_type, cache_dir=cache_dir
    )


def normalize_korean_cer(text: str) -> str:
    """NFKC + lowercase + letters/numbers only; whitespace/punctuation excluded."""
    normalized = unicodedata.normalize("NFKC", text).lower()
    return "".join(
        character
        for character in normalized
        if unicodedata.category(character)[0] in {"L", "N"}
    )


def edit_distance(left: str, right: str) -> int:
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for row, left_character in enumerate(left, start=1):
        current = [row]
        for column, right_character in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (left_character != right_character),
                )
            )
        previous = current
    return previous[-1]


def cer_counts(reference: str, hypothesis: str) -> tuple[int, int]:
    normalized_reference = normalize_korean_cer(reference)
    if not normalized_reference:
        raise ValueError("reference transcript is empty after CER normalization")
    normalized_hypothesis = normalize_korean_cer(hypothesis)
    return edit_distance(normalized_reference, normalized_hypothesis), len(normalized_reference)


def audio_duration_seconds(path: Path) -> float:
    if path.suffix.lower() == ".wav":
        with wave.open(str(path), "rb") as audio:
            return audio.getnframes() / audio.getframerate()
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def write_segments(path: Path, segments: list[Segment]) -> None:
    path.write_text(
        json.dumps([asdict(segment) for segment in segments], ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
