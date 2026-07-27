#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
HARNESS = REPO_ROOT / "scripts" / "transcription"
sys.path.insert(0, str(HARNESS))

from merge_tracks import merge_tracks, speaker_labeled_text  # noqa: E402
from transcription_common import cer_counts, load_model_lock  # noqa: E402


class TranscriptionHarnessTests(unittest.TestCase):
    def test_model_lock_and_korean_cer(self) -> None:
        lock = load_model_lock()
        self.assertEqual(
            [model["name"] for model in lock["models"]],
            ["small", "medium", "large-v3-turbo"],
        )
        self.assertEqual(cer_counts("안녕, 하세요!", "안녕하세요"), (0, 5))
        self.assertEqual(cer_counts("가나다", "가마"), (2, 3))

    def test_track_identity_is_speaker_and_timestamps_are_merged(self) -> None:
        merged = merge_tracks(
            [
                {
                    "member_id": "a",
                    "speaker": "성재",
                    "start_offset_ms": 100,
                    "segments": [{"start_ms": 900, "end_ms": 1200, "text": "첫 발화"}],
                },
                {
                    "member_id": "b",
                    "speaker": "모모",
                    "start_offset_ms": 0,
                    "segments": [{"start_ms": 500, "end_ms": 800, "text": "먼저"}],
                },
            ]
        )
        self.assertEqual([segment["speaker"] for segment in merged], ["모모", "성재"])
        self.assertEqual(speaker_labeled_text(merged), "[00:00] 모모: 먼저\n[00:01] 성재: 첫 발화\n")

    def test_silence_mock_runs_benchmark_and_job_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            audio_dir = root / "audio"
            reference_dir = root / "reference"
            benchmark_output = root / "benchmark"
            job_output = root / "job-output"
            audio_dir.mkdir()
            reference_dir.mkdir()
            audio = audio_dir / "silence.wav"
            with wave.open(str(audio), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(16_000)
                handle.writeframes(b"\x00\x00" * 16_000)
            (reference_dir / "silence.txt").write_text("더미 무음", encoding="utf-8")

            subprocess.run(
                [
                    sys.executable,
                    str(HARNESS / "benchmark.py"),
                    "--audio-dir",
                    str(audio_dir),
                    "--reference-dir",
                    str(reference_dir),
                    "--output-dir",
                    str(benchmark_output),
                    "--backend",
                    "mock",
                    "--threads",
                    "1",
                ],
                check=True,
            )
            results = json.loads((benchmark_output / "results.json").read_text())
            self.assertEqual(len(results), 3)
            self.assertTrue(all(result["cer"] == 0 for result in results))

            manifest = {
                "job_id": "85400000-0000-7000-8000-000000000001",
                "model": "small",
                "tracks": [
                    {
                        "member_id": "85400000-0000-7000-8000-000000000002",
                        "speaker": "더미 참가자",
                        "source_attachment_id": "85400000-0000-7000-8000-000000000003",
                        "audio_path": str(audio),
                        "start_offset_ms": 0,
                        "mock_reference": "더미 무음",
                    }
                ],
            }
            manifest_path = root / "job.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            subprocess.run(
                [
                    sys.executable,
                    str(HARNESS / "transcribe_job.py"),
                    "--manifest",
                    str(manifest_path),
                    "--output-dir",
                    str(job_output),
                    "--backend",
                    "mock",
                ],
                check=True,
            )
            self.assertEqual(
                (job_output / "speaker-labeled.txt").read_text(encoding="utf-8"),
                "[00:00] 더미 참가자: 더미 무음\n",
            )
            receipt = json.loads((job_output / "job-receipt.json").read_text())
            self.assertEqual(receipt["durable_storage"]["contract"], "attachment")


if __name__ == "__main__":
    unittest.main()
