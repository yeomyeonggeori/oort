"""The adapter's only write path: oort REST.

Everything this package sends to oort goes through [`OortClient`]. That is not a
layering preference, it is the hard invariant (`CLAUDE.md`): a message becomes
real by `REST -> PG commit -> outbox -> relay`, and an adapter that could reach
Centrifugo or Postgres directly would be able to make a message that no `seq`
orders and no outbox row describes. There is deliberately no code here that
knows how to do either — the class holds a base URL and a bearer, and the only
verbs are POST and PATCH against two message routes.

Three contracts live in this file because they are contracts *of the wire*, and
splitting them from the transport would let one of them drift:

* **#1173 — the opening marker.** A stream's first write is a POST, and the
  request says `stream: {rev: 0, streaming: true}`. The server writes the props
  key itself; the block is the producer stating the arithmetic it is about to
  do, so a mismatch is refused instead of silently producing a message that
  nothing will ever close.
* **#1152 — the slice.** Every later write is a PATCH carrying the **whole body
  so far**, never a delta, plus a strictly increasing `rev`. Absolute bodies are
  what make a retried slice harmless: replaying it writes the same text.
* **ADR-0155 — the outcome.** The slice that sets `final: true` may also say
  `outcome: "cancelled" | "failed"`, which is how a stopped answer stops looking
  like a finished one.

`clientMsgId` is the idempotency key and this module never invents one per
attempt (the spike's `RestSink` did, and its own §8 wrote down that a retry
would therefore duplicate). Callers pass a stable key; retries reuse it.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Mapping

# The server's floor for an opening marker (`momo_messaging::OPENING_STREAM_REV`).
# The first PATCH slice is therefore `rev: 1`, on this path exactly as on the
# in-process one.
OPENING_STREAM_REV = 0
FIRST_SLICE_REV = OPENING_STREAM_REV + 1

# The two endings ADR-0155 defines. Absent is the third, ordinary ending, and it
# is spelled by omitting the key rather than by a third member here.
OUTCOME_CANCELLED = "cancelled"
OUTCOME_FAILED = "failed"


class OortError(Exception):
    """A refused or unreachable oort write, with the request that caused it.

    Carries `status` (None when the request never got an answer) so callers can
    tell "the server said no" from "the server did not answer" without parsing a
    message. The two need different reactions: the first is a contract mistake
    to surface, the second is a retry.
    """

    def __init__(
        self,
        message: str,
        *,
        method: str,
        url: str,
        status: int | None = None,
        body: str = "",
    ):
        super().__init__(message)
        self.method = method
        self.url = url
        self.status = status
        self.body = body

    def __str__(self) -> str:  # pragma: no cover - formatting only
        head = super().__str__()
        where = f"{self.method} {self.url}"
        if self.status is None:
            return f"{head} ({where})"
        return f"{head} ({where} -> HTTP {self.status}: {self.body[:400]})"


def string_props(props: Mapping[str, Any] | None) -> dict[str, str]:
    """Coerce a props mapping to the wire's flat `string -> string` shape.

    `SendMessageRequest.props` is `Option<BTreeMap<String, String>>` on the
    server: v0 props are flat strings, and a nested object would not decode. A
    structured value (the refine event's evidence, a tool's arguments) therefore
    travels as compact JSON **inside** a string, with sorted keys so the same
    evidence produces the same bytes on a retry.
    """
    out: dict[str, str] = {}
    for key, value in (props or {}).items():
        if value is None:
            continue
        if isinstance(value, str):
            out[key] = value
        elif isinstance(value, bool):
            out[key] = "true" if value else "false"
        elif isinstance(value, (int, float)):
            out[key] = str(value)
        else:
            out[key] = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return out


class OortClient:
    """REST-only oort client for one workspace/channel pair.

    `run_id` is carried two ways on purpose:

    * as the request field `runId` — the binding ADR-0158 D5 opens, which is what
      lets `open_stream_message_for_run_in_tx` find a REST-opened stream and
      close it when the producer dies; and
    * as `props["run_id"]` — the spelling #1166's "has this run ended?" verdict
      already reads, and the only one a server that has not landed D5 yet
      accepts.

    Sending both is not belt-and-braces: they answer different readers, and the
    props copy is what keeps this adapter useful on a server where the request
    field is still refused. `send_run_id_field` is the switch, and a refusal of
    the field is raised rather than swallowed — a silent downgrade would make the
    stream unclosable while looking green.
    """

    def __init__(
        self,
        base_url: str,
        workspace_id: str,
        channel_id: str,
        token: str,
        *,
        run_id: str | None = None,
        send_run_id_field: bool = True,
        timeout: float = 15.0,
        allow_insecure_http: bool = False,
        max_attempts: int = 3,
        backoff: float = 0.4,
        opener: Any | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.workspace_id = workspace_id
        self.channel_id = channel_id
        self.token = token
        self.run_id = run_id
        self.send_run_id_field = send_run_id_field
        self.timeout = timeout
        self.max_attempts = max(1, max_attempts)
        self.backoff = backoff
        self._opener = opener or urllib.request.urlopen
        self._assert_transport(allow_insecure_http)
        # Every write this client made, in order. The adapter's transcript reads
        # it, and the tests assert on it — a sink that cannot say what it sent
        # cannot be held to the contract.
        self.writes: list[dict[str, Any]] = []

    # -- transport ---------------------------------------------------------

    def _assert_transport(self, allow_insecure_http: bool) -> None:
        """Refuse plaintext off loopback unless the operator said so.

        Same rule as the hermes adapter (`MOMO_AGENT_ALLOW_INSECURE_HTTP`): the
        bearer this client holds is a workspace credential, and putting it on a
        cleartext hop to a non-loopback host is a decision, not a default.
        """
        parsed = urllib.parse.urlparse(self.base_url)
        if parsed.scheme == "https":
            return
        host = (parsed.hostname or "").lower()
        loopback = host in ("127.0.0.1", "::1", "localhost") or host.endswith(".localhost")
        if loopback or allow_insecure_http:
            return
        raise ValueError(
            f"refusing plaintext http to a non-loopback host ({host or 'unknown'}); "
            "set OORT_PRIME_ALLOW_INSECURE_HTTP=1 only on a trusted private network"
        )

    @property
    def messages_url(self) -> str:
        return f"{self.base_url}/v1/workspaces/{self.workspace_id}/channels/{self.channel_id}/messages"

    def message_url(self, message_id: str) -> str:
        """The edit route is workspace-scoped, not channel-scoped.

        `PATCH /v1/workspaces/{ws}/messages/{id}` — getting this wrong produces a
        404 that looks like a vanished message rather than a wrong URL, which is
        why it is spelled once, here.
        """
        return f"{self.base_url}/v1/workspaces/{self.workspace_id}/messages/{message_id}"

    def _request(self, method: str, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        last: OortError | None = None
        for attempt in range(1, self.max_attempts + 1):
            request = urllib.request.Request(
                url,
                data=data,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.token}",
                },
                method=method,
            )
            try:
                with self._opener(request, timeout=self.timeout) as response:
                    raw = response.read().decode("utf-8")
                return json.loads(raw) if raw.strip() else {}
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", "replace")
                error = OortError(
                    "oort refused the write", method=method, url=url, status=exc.code, body=body
                )
                # 4xx is the caller's mistake and repeating it is noise. 429 and
                # 5xx are the server asking for time, and the payload carries a
                # stable `clientMsgId`/absolute body, so repeating is safe.
                if exc.code < 500 and exc.code != 429:
                    raise error from exc
                last = error
            except Exception as exc:  # network, DNS, timeout
                last = OortError(
                    f"oort write did not complete: {type(exc).__name__}: {exc}",
                    method=method,
                    url=url,
                )
            if attempt < self.max_attempts:
                time.sleep(self.backoff * attempt)
        assert last is not None
        raise last

    # -- writes ------------------------------------------------------------

    def _run_fields(self, payload: dict[str, Any], props: dict[str, str]) -> None:
        if not self.run_id:
            return
        props.setdefault("run_id", self.run_id)
        if self.send_run_id_field:
            payload["runId"] = self.run_id

    def post_message(
        self,
        *,
        client_msg_id: str,
        message_type: str,
        body: str,
        props: Mapping[str, Any] | None = None,
        opens_stream: bool = False,
    ) -> dict[str, Any]:
        """One finished message, or the opening write of a growing one."""
        wire_props = string_props(props)
        payload: dict[str, Any] = {
            "clientMsgId": client_msg_id,
            "type": message_type,
            "body": body,
        }
        self._run_fields(payload, wire_props)
        if wire_props:
            payload["props"] = wire_props
        if opens_stream:
            payload["stream"] = {"rev": OPENING_STREAM_REV, "streaming": True}
        result = self._request("POST", self.messages_url, payload)
        self.writes.append(
            {
                "method": "POST",
                "clientMsgId": client_msg_id,
                "type": message_type,
                "opensStream": opens_stream,
                "chars": len(body),
                "id": result.get("id"),
                "seq": result.get("seq"),
            }
        )
        return result

    def patch_stream(
        self,
        message_id: str,
        *,
        body: str,
        rev: int,
        is_final: bool,
        outcome: str | None = None,
    ) -> dict[str, Any]:
        """One slice of a growing answer.

        `body` is the whole text so far. `rev` must be strictly greater than the
        stored one or the server treats the write as a no-op — which is the
        staleness guard, not an error, and is exactly why a late-arriving retry
        cannot rewind a message.
        """
        if rev < FIRST_SLICE_REV:
            raise ValueError(f"a slice's rev starts at {FIRST_SLICE_REV}, got {rev}")
        if outcome is not None:
            if not is_final:
                raise ValueError("an outcome only rides the final slice (ADR-0155)")
            if outcome not in (OUTCOME_CANCELLED, OUTCOME_FAILED):
                raise ValueError(f"unknown stream outcome: {outcome!r}")
        stream: dict[str, Any] = {"rev": rev, "final": is_final}
        if outcome is not None:
            stream["outcome"] = outcome
        result = self._request(
            "PATCH", self.message_url(message_id), {"body": body, "stream": stream}
        )
        self.writes.append(
            {
                "method": "PATCH",
                "messageId": message_id,
                "rev": rev,
                "final": is_final,
                "outcome": outcome,
                "chars": len(body),
                "seq": result.get("seq"),
            }
        )
        return result


def stable_key(*parts: str) -> str:
    """A UUIDv5 over `parts` — the same inputs always name the same message.

    Used wherever the harness does not hand us an id of its own (a turn, an
    observed drift). It is what makes "post again after a crash" produce the
    message that already exists instead of a second one.
    """
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "oort:prime:" + "|".join(parts)))
