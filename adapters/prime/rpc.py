"""`prime-agent --mode rpc` over stdin/stdout JSONL.

Framing follows the harness's `docs/rpc.md`: records are separated by LF, one
trailing CR is stripped. The bytes are split by hand rather than iterating the
text stream because Python's text iteration also breaks on U+2028/U+2029, and
those characters appear *inside* JSON strings — a generic line reader would cut
a record in half on any answer containing one.

**stderr is captured, always.** RPC mode is daemon-backed, and the measured
failure mode in containers is that the daemon supervisor dies with `EXDEV` while
the RPC client sees nothing but a clean stdout EOF (spike §5-⑵). Without stderr
the adapter's only report would be "the agent produced no output", which names
the wrong thing.
"""

from __future__ import annotations

import json
import queue
import subprocess
import threading
from typing import Any

#: Synthetic records this transport injects. Neither is a harness event; both are
#: facts about the process the caller has to be able to react to.
EOF_RECORD = "__eof__"
UNPARSED_RECORD = "__unparsed__"


class JsonlRpc:
    """A running `prime-agent --mode rpc` process and its two pipes."""

    def __init__(
        self,
        argv: list[str],
        *,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        stderr_tail: int = 200,
    ):
        self.argv = list(argv)
        self.proc = subprocess.Popen(
            self.argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=cwd,
        )
        self.inbox: "queue.Queue[dict[str, Any]]" = queue.Queue()
        self.stderr_lines: list[str] = []
        self._stderr_tail = stderr_tail
        self._write_lock = threading.Lock()
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        buffer = b""
        stream = self.proc.stdout
        assert stream is not None
        while True:
            chunk = stream.read(1)
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if line.endswith(b"\r"):
                    line = line[:-1]
                if not line.strip():
                    continue
                text = line.decode("utf-8", "replace")
                try:
                    self.inbox.put(json.loads(text))
                except json.JSONDecodeError:
                    self.inbox.put({"type": UNPARSED_RECORD, "raw": text})
        self.inbox.put({"type": EOF_RECORD})

    def _read_stderr(self) -> None:
        stream = self.proc.stderr
        assert stream is not None
        for raw in stream:
            self.stderr_lines.append(raw.decode("utf-8", "replace").rstrip("\n"))
            if len(self.stderr_lines) > self._stderr_tail:
                del self.stderr_lines[0 : len(self.stderr_lines) - self._stderr_tail]

    def send(self, command: dict[str, Any]) -> None:
        payload = json.dumps(command, ensure_ascii=False) + "\n"
        stream = self.proc.stdin
        if stream is None:
            raise RuntimeError("rpc stdin is closed")
        with self._write_lock:
            stream.write(payload.encode("utf-8"))
            stream.flush()

    def close(self, timeout: float = 10.0) -> int | None:
        try:
            if self.proc.stdin is not None:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return self.proc.poll()
