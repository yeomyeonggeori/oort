"""One assistant message that grows: delta buffering plus the #1152 slice contract.

## Why buffering is not an optimisation

The spike measured a single assistant answer arriving as ~17 REST writes without
coalescing (`research/2026-08-06-prime-agent-spike.md` §7-1); the mock alone emits
a `text_delta` every seven characters. Relaying one write per delta is a write
amplification bomb against a database that assigns a gapless `seq` per message —
and before #1152 it was worse than that, because each write was a *new message*.

So this class does two things at once and they are the same thing: it coalesces
deltas into bounded flushes, and it spends those flushes on **one** message that
it edits in place.

## The shape of one turn

    POST   stream {rev: 0, streaming: true}   <- opening write, carries the first
                                                 buffered text
    PATCH  stream {rev: 1, final: false}      <- slice, body = whole text so far
    PATCH  stream {rev: 2, final: false}
    ...
    PATCH  stream {rev: n, final: true}       <- the answer finished
           stream {rev: n, final: true, outcome: "cancelled"|"failed"}
                                              <- ...or it stopped (ADR-0155)

`rev` is this writer's own counter, strictly increasing, and never restarts
inside a message. `body` is always absolute, so a replayed slice writes the text
it already wrote instead of appending it twice.

## What "closed" means here

A relay that never opened has nothing to close, and saying so is not the same as
succeeding: an answer that produced no text and then failed leaves no message,
because a message with no body is not an honest tombstone for it. The adapter
records that case in its transcript instead of inventing a channel row.
"""

from __future__ import annotations

import time
from typing import Any, Callable

from .oort_client import FIRST_SLICE_REV, OortClient


class StreamRelay:
    """The growing message for one assistant turn.

    `client_msg_id` is fixed for the life of the turn: the opening POST is the
    only write that can create a row, and a retried open therefore dedupes onto
    the row it already made.
    """

    def __init__(
        self,
        client: OortClient,
        *,
        client_msg_id: str,
        props: dict[str, Any] | None = None,
        flush_chars: int = 220,
        flush_interval: float = 0.8,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.client = client
        self.client_msg_id = client_msg_id
        self.props = dict(props or {})
        self.flush_chars = flush_chars
        self.flush_interval = flush_interval
        self._clock = clock

        self.body = ""
        self.pending = ""
        self.pending_since: float | None = None
        self.message_id: str | None = None
        self.rev = 0
        self.closed = False
        self.delta_count = 0
        self.flushes: list[dict[str, Any]] = []

    # -- input -------------------------------------------------------------

    @property
    def opened(self) -> bool:
        return self.message_id is not None

    def add(self, delta: str) -> None:
        """Take one `text_delta` and flush if policy says so."""
        if self.closed:
            raise RuntimeError("a closed stream cannot take another delta")
        if not delta:
            return
        self.delta_count += 1
        if self.pending_since is None:
            self.pending_since = self._clock()
        self.pending += delta
        if len(self.pending) >= self.flush_chars or self._interval_elapsed():
            self.flush("policy")

    def _interval_elapsed(self) -> bool:
        return (
            self.pending_since is not None
            and (self._clock() - self.pending_since) >= self.flush_interval
        )

    def tick(self) -> None:
        """Flush a stale buffer when no delta is arriving.

        Without this a slow tail sits in the buffer until the next event, and the
        answer visibly stops moving on screen for as long as the model is quiet.
        """
        if not self.closed and self.pending and self._interval_elapsed():
            self.flush("idle")

    # -- output ------------------------------------------------------------

    def flush(self, reason: str) -> bool:
        """Write the pending text. Returns whether anything went to oort."""
        if self.closed:
            raise RuntimeError("a closed stream cannot be flushed")
        if not self.pending.strip():
            # Whitespace-only pending is kept, not dropped: it is part of the
            # body and will ride the next real flush. Dropping it would silently
            # reformat the model's answer.
            return False
        self.body += self.pending
        self.pending = ""
        self.pending_since = None
        if self.message_id is None:
            result = self.client.post_message(
                client_msg_id=self.client_msg_id,
                message_type="text",
                body=self.body,
                props=self.props,
                opens_stream=True,
            )
            message_id = result.get("id")
            if not message_id:
                raise RuntimeError("oort accepted the opening write but returned no message id")
            self.message_id = str(message_id)
            self.rev = 0
            self.flushes.append({"reason": reason, "rev": 0, "opening": True, "chars": len(self.body)})
            return True
        self.rev = max(self.rev + 1, FIRST_SLICE_REV)
        self.client.patch_stream(self.message_id, body=self.body, rev=self.rev, is_final=False)
        self.flushes.append({"reason": reason, "rev": self.rev, "opening": False, "chars": len(self.body)})
        return True

    def close(self, reason: str, outcome: str | None = None) -> bool:
        """Finish the message. Returns whether anything was written.

        The pending buffer is folded in first, because the final write is also
        the last chance to say the whole text.

        **The short-answer case is the interesting one.** An answer that fits
        inside one buffer never triggered a flush, so nothing has been opened
        yet, and it is most replies. Three endings, three different writes:

        * nothing was ever said — nothing is written. A message with no body is
          not an honest record of an answer that did not happen.
        * a complete short answer — ONE plain `POST`, no stream marker. It never
          grew and nothing could have interrupted it, so marking it as a stream
          and immediately closing it would spend two writes to describe a
          history that did not occur.
        * a short answer that **stopped** — open, then close with the outcome.
          Here the two writes buy something real: `cancelled` and `failed` are
          only expressible on a closing slice, and "this is not the whole
          answer" is exactly what the reader must not have to guess.
        """
        if self.closed:
            return False
        if self.pending.strip():
            self.body += self.pending
        self.pending = ""
        self.pending_since = None
        self.closed = True
        if self.message_id is None:
            if not self.body.strip():
                self.flushes.append({"reason": reason, "rev": None, "closing": True, "unsaid": True})
                return False
            if outcome is None:
                result = self.client.post_message(
                    client_msg_id=self.client_msg_id,
                    message_type="text",
                    body=self.body,
                    props=self.props,
                )
                self.message_id = str(result.get("id") or "")
                self.flushes.append(
                    {"reason": reason, "rev": None, "closing": True, "whole": True, "chars": len(self.body)}
                )
                return True
            result = self.client.post_message(
                client_msg_id=self.client_msg_id,
                message_type="text",
                body=self.body,
                props=self.props,
                opens_stream=True,
            )
            self.message_id = str(result.get("id") or "")
            self.rev = 0
        self.rev = max(self.rev + 1, FIRST_SLICE_REV)
        self.client.patch_stream(
            self.message_id,
            body=self.body,
            rev=self.rev,
            is_final=True,
            outcome=outcome,
        )
        self.flushes.append(
            {"reason": reason, "rev": self.rev, "closing": True, "outcome": outcome, "chars": len(self.body)}
        )
        return True
