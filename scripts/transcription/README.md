# MOMO-646 Korean ASR measurement harness

This harness measures the three ADR-0122 candidates on the same Korean corpus.
It does not select a model, fetch test audio, perform diarization, or provide
real-time captions.

## Corpus layout

Place orchestrator-provided audio and matching UTF-8 reference transcripts in
separate directories. Basenames must match.

```text
/tmp/momo-646-corpus/
├── audio/
│   ├── call-01.wav
│   └── call-02.m4a
└── reference/
    ├── call-01.txt
    └── call-02.txt
```

Supported audio suffixes are WAV, MP3, M4A, FLAC, OGG, and Opus. Non-WAV
duration measurement requires `ffprobe`.

## Reproducible real run

Use a disposable virtual environment. `model-lock.json` pins faster-whisper
1.2.1/source commit and exact Hugging Face snapshot commits for small, medium,
and large-v3-turbo. The decoder uses Korean, beam size 5, temperature 0,
VAD disabled, and the requested CPU thread count for every candidate.

```sh
python3 -m venv /tmp/momo-646-venv
/tmp/momo-646-venv/bin/pip install -r scripts/transcription/requirements.lock
/tmp/momo-646-venv/bin/python scripts/transcription/benchmark.py \
  --audio-dir /tmp/momo-646-corpus/audio \
  --reference-dir /tmp/momo-646-corpus/reference \
  --output-dir /tmp/momo-646-results/threads-1 \
  --threads 1
```

Repeat with the intended thread counts, changing both `--threads` and the
output directory. Each run writes `results.json`, `results.csv`, and a Markdown
table. RTF is `elapsed seconds / audio seconds`; lower than 1.0 is faster than
real time. CER normalization is NFKC, lowercase, then letters/numbers only, so
spacing and punctuation do not affect the score.

## Pipeline skeleton

`transcribe_job.py` consumes participant tracks materialized into a temporary
job directory. Each track must carry the existing durable
`source_attachment_id`, its member/speaker identity, and a timestamp offset.
The selected model is a manifest setting and must be one of the pinned
candidates.

```sh
/tmp/momo-646-venv/bin/python scripts/transcription/transcribe_job.py \
  --manifest /tmp/momo-transcription/job.json \
  --output-dir /tmp/momo-transcription/job-output \
  --threads 1
```

The runner transcribes each participant track independently and delegates only
timestamp ordering and speaker labeling to `merge_tracks.py`. It does not run a
speaker-diarization model. `speaker-labeled.txt` and
`merged-transcript.json` are scratch outputs: upload them through the existing
attachment flow (`POST attachments/uploads` → upload URL `PUT` → `POST
complete`) and store the resulting attachment id on
`huddle_transcription_job`. No durable local recording/transcript path is part
of the database contract.

## No-model self-test

This creates one second of temporary silence and runs all three benchmark rows,
the per-track job, timestamp merge, and speaker-label output through a
deterministic mock backend. It is a pipeline check, not a quality result.

```sh
python3 -m unittest scripts/tests/test_transcription_harness.py
```
