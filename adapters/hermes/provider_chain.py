"""Provider polymorphism for the momo hermes adapter (ADR-0135 D3).

This module is the adapter-side provider layer:

  * **chain**   momo hands down an ordered chain (`base_url` + `mode` per link).
                Credentials are *never* part of that payload — they are read from
                this adapter's own environment (ADR-0004 "provider 자격증명 비유입").
  * **chat**    cascade over the chain. Only *no-response / 5xx / 429* fall
                through to the next link; any other 4xx is a user/validation
                error and is propagated unchanged (ADR-0135 D1).
  * **health**  per-link reachability probe, reused by the chain-wide health view.
  * **probe**   periodic quota probe. The adapter (the side that *has* the
                credential) reads the provider's remaining quota and posts only
                numbers to momo (`POST /v1/provider/quota-snapshots`,
                ADR-0135 D2). No token, no header text, no response body.
  * **effort**  request-level effort (ADR-0134 D2) is validated against the
                provider×model effort table that momo owns. An effort the model
                does not support is dropped with a log line, never guessed.

Everything here is import-safe and testable without momo, without a provider and
without network: the HTTP surface goes through an injected `transport` callable.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import random
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Mapping, Optional, Sequence

log = logging.getLogger("momo.adapter.provider")

# --- momo REST surfaces this module talks to (ADR-0134 D2 / ADR-0135 D2) ------
EFFORT_TABLE_PATH = "/v1/provider/effort-table"
QUOTA_SNAPSHOT_PATH = "/v1/provider/quota-snapshots"

#: ADR-0135 D2 ingest body. Exactly these keys, nothing else.
QUOTA_SNAPSHOT_KEYS = (
    "provider_ref",
    "window",
    "remaining_ratio",
    "resets_at",
    "probed_at",
)
#: ADR-0135 D2 / reference survey: a short window plus a weekly window.
QUOTA_WINDOWS = ("short", "weekly")

#: Provider modes momo can hand down (server `AgentProviderMode`).
MODE_LOCAL_MOCK = "local-mock"
MODE_INTERNAL_HOST_MOCK = "internal-host-mock"
MODE_EXTERNAL_HERMES = "external-hermes"
KNOWN_MODES = (MODE_LOCAL_MOCK, MODE_INTERNAL_HOST_MOCK, MODE_EXTERNAL_HERMES)

#: Failure dispositions (ADR-0135 D1).
FALLBACK = "fallback"
PROPAGATE = "propagate"

#: Default effort request field for OpenAI-compatible providers. Providers that
#: split Effort and Thinking into two axes declare their own field name in the
#: momo-owned effort table row (`param`), so the adapter maps rather than guesses.
DEFAULT_EFFORT_PARAM = "reasoning_effort"

#: Keys that would mean momo shipped credential material into the adapter.
#: Their presence in a chain payload is a hard ADR-0004 violation, not a warning.
CREDENTIAL_KEYS = frozenset(
    {
        "access_token",
        "accesstoken",
        "api_key",
        "apikey",
        "auth",
        "authorization",
        "bearer",
        "client_secret",
        "clientsecret",
        "cookie",
        "credential",
        "credentials",
        "headers",
        "password",
        "private_key",
        "privatekey",
        "refresh_token",
        "refreshtoken",
        "secret",
        "session_key",
        "sessionkey",
        "token",
    }
)

#: Everything a bearer token may consist of after `Bearer `. RFC 6750 b64token
#: plus `=` padding; quotes/brackets are excluded so a JSON- or repr-serialized
#: log line loses the secret without losing the structure around it.
_BEARER_TOKEN = r"[A-Za-z0-9._~+/=-]+"

#: Credential shapes. **Every pattern must consume its credential in full.**
#: A pattern that matches only part of a secret fails twice: the remainder stays
#: in the log line, and the prefix it ate is exactly what the next pattern
#: anchors on (`Bearer sk-…` lost its `s`, so `\bsk-` then matched nothing).
_CREDENTIAL_VALUE_PATTERNS = (
    re.compile(r"\b(?i:bearer)\s+" + _BEARER_TOKEN),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"),
    re.compile(r"\bghp_[A-Za-z0-9_-]{8,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9_-]{8,}"),
    re.compile(r"\bya29\.[A-Za-z0-9._-]{8,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*"),
    re.compile(r"momo_agent_v1(?:\.[A-Za-z0-9_-]+)+"),
)

#: Redaction runs as **one** pass over this alternation instead of one pass per
#: pattern. `re.sub` takes the leftmost match and resumes after it, so no
#: pattern can partially rewrite the text another pattern still has to match.
_CREDENTIAL_VALUE_SCANNER = re.compile(
    "|".join(f"(?:{pattern.pattern})" for pattern in _CREDENTIAL_VALUE_PATTERNS)
)

_ENV_KEY_SAFE = re.compile(r"[^A-Z0-9]+")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class ProviderChainError(RuntimeError):
    """Malformed or unusable provider chain configuration."""


class ProviderCredentialLeak(ProviderChainError):
    """momo handed the adapter credential material — ADR-0004 boundary breach."""


class ProviderChainEmpty(ProviderChainError):
    """No enabled provider link is available to serve the request."""


class ProviderQuotaContractError(RuntimeError):
    """A quota snapshot does not match the ADR-0135 D2 numbers-only ingest body."""


class ProviderCallError(RuntimeError):
    """One provider link failed.

    `disposition` is the ADR-0135 D1 classification: FALLBACK for
    no-response / 5xx / 429, PROPAGATE for every other 4xx.
    """

    def __init__(
        self,
        provider_ref: str,
        *,
        status: Optional[int] = None,
        detail: str = "",
        cause: Optional[BaseException] = None,
    ) -> None:
        self.provider_ref = provider_ref
        self.status = status
        self.detail = _redact(detail)[:300]
        self.disposition = classify_provider_failure(status=status, error=cause)
        self.reason = "no_response" if status is None else f"http_{status}"
        super().__init__(
            f"provider {provider_ref} failed ({self.reason}, {self.disposition})"
            + (f": {self.detail}" if self.detail else "")
        )

    @property
    def fallback_eligible(self) -> bool:
        return self.disposition == FALLBACK


# ---------------------------------------------------------------------------
# Failure classification (ADR-0135 D1 — identical rule on both sides)
# ---------------------------------------------------------------------------
def is_fallback_status(status: Optional[int]) -> bool:
    """True when this HTTP status means "the provider produced no answer".

    The cascade follows ADR-0135: only 429 (rate limited), any 5xx, or no HTTP
    response advances to the next provider. Adapter-to-momo callback retries
    are a separate transport policy; 408 and 425 remain terminal here.
    """
    if status is None:
        return True
    return status == 429 or status >= 500


def classify_provider_failure(
    *, status: Optional[int] = None, error: Optional[BaseException] = None
) -> str:
    """FALLBACK (try the next link) or PROPAGATE (surface to the user)."""
    if isinstance(error, asyncio.CancelledError):
        return PROPAGATE
    return FALLBACK if is_fallback_status(status) else PROPAGATE


# ---------------------------------------------------------------------------
# Chain configuration — momo-supplied shape, adapter-owned credentials
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class ProviderChainEntry:
    """One `provider_link_chain` row as momo hands it down (ADR-0135 D1).

    `bearer` is write-only on the momo side and therefore never appears here.
    """

    provider_ref: str
    position: int
    base_url: str
    mode: str
    enabled: bool = True

    @property
    def normalized_ref(self) -> str:
        return self.provider_ref.strip().lower()


_FLAT_CREDENTIAL_KEYS = frozenset(
    re.sub(r"[^a-z0-9]+", "", key) for key in CREDENTIAL_KEYS
)


def _credential_key_hit(mapping: Mapping[str, Any]) -> Optional[str]:
    for key in mapping:
        if re.sub(r"[^a-z0-9]+", "", str(key).lower()) in _FLAT_CREDENTIAL_KEYS:
            return str(key)
    return None


def _first(mapping: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def parse_provider_chain(raw: Any) -> tuple[ProviderChainEntry, ...]:
    """Parse the momo-supplied chain into ordered, enabled links.

    Raises `ProviderCredentialLeak` when the payload carries credential-shaped
    keys — momo must never send those (ADR-0004). Unknown non-credential keys are
    ignored so a momo-side additive change cannot break a deployed adapter.
    """
    if isinstance(raw, Mapping):
        raw = _first(raw, "chain", "links", "providers", "items") or []
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes, bytearray)):
        raise ProviderChainError("provider chain must be a list of links")

    entries: list[ProviderChainEntry] = []
    for index, item in enumerate(raw):
        if not isinstance(item, Mapping):
            raise ProviderChainError("provider chain link must be an object")
        leaked = _credential_key_hit(item)
        if leaked is not None:
            raise ProviderCredentialLeak(
                f"provider chain link carries credential field {leaked!r}; "
                "momo must send base_url+mode only (ADR-0004)"
            )
        base_url = str(_first(item, "base_url", "baseUrl") or "").strip().rstrip("/")
        if not base_url:
            raise ProviderChainError("provider chain link is missing base_url")
        mode = str(_first(item, "mode") or "").strip().lower()
        if not mode:
            raise ProviderChainError("provider chain link is missing mode")
        raw_position = _first(item, "position")
        try:
            position = int(raw_position) if raw_position is not None else index
        except (TypeError, ValueError) as exc:
            raise ProviderChainError("provider chain position must be an integer") from exc
        provider_ref = str(
            _first(item, "provider_ref", "providerRef", "id") or f"position-{position}"
        ).strip()
        enabled_raw = _first(item, "enabled")
        enabled = True if enabled_raw is None else _truthy(enabled_raw)
        entries.append(
            ProviderChainEntry(
                provider_ref=provider_ref,
                position=position,
                base_url=base_url,
                mode=mode,
                enabled=enabled,
            )
        )

    ordered = tuple(
        sorted(
            (entry for entry in entries if entry.enabled),
            key=lambda entry: (entry.position, entry.normalized_ref),
        )
    )
    return ordered


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# Credentials — adapter-owned, never momo-supplied (ADR-0004)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class ProviderCredential:
    """A provider bearer this adapter read from its own configuration."""

    bearer: str = ""

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.bearer}"} if self.bearer else {}

    @property
    def configured(self) -> bool:
        return bool(self.bearer)

    def __repr__(self) -> str:  # pragma: no cover - trivial, but must stay redacted
        return f"ProviderCredential(configured={self.configured})"

    __str__ = __repr__


class ProviderCredentialStore:
    """Reads provider bearers from this adapter's own environment only.

    Lookup order for a link whose `provider_ref` is `alt-openai`:
        1. `<PREFIX>__ALT_OPENAI`
        2. `<PREFIX>`  (single-credential deployments)
    Nothing here ever reads a momo payload.
    """

    def __init__(
        self,
        env: Optional[Mapping[str, str]] = None,
        *,
        prefix: str = "HERMES_PROVIDER_BEARER",
    ) -> None:
        self._env = env if env is not None else os.environ
        self._prefix = prefix or "HERMES_PROVIDER_BEARER"

    def env_key(self, provider_ref: str) -> str:
        slug = _ENV_KEY_SAFE.sub("_", str(provider_ref).strip().upper()).strip("_")
        return f"{self._prefix}__{slug}" if slug else self._prefix

    def for_ref(self, provider_ref: str) -> ProviderCredential:
        for key in (self.env_key(provider_ref), self._prefix):
            value = str(self._env.get(key, "") or "").strip()
            if value:
                return ProviderCredential(bearer=value)
        return ProviderCredential()


# ---------------------------------------------------------------------------
# Effort table (ADR-0134 D2 — provider×model, momo owns the truth)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class EffortBinding:
    """A validated effort plus the provider request field that carries it."""

    effort: str
    param: str = DEFAULT_EFFORT_PARAM

    def request_fields(self) -> dict[str, str]:
        return {self.param: self.effort}


@dataclass(frozen=True, slots=True)
class EffortTable:
    """provider×model → supported effort values, as published by momo."""

    rows: Mapping[tuple[str, str], tuple[tuple[str, ...], str]] = field(
        default_factory=dict
    )

    @classmethod
    def from_payload(cls, raw: Any) -> "EffortTable":
        rows: dict[tuple[str, str], tuple[tuple[str, ...], str]] = {}

        def add(provider: Any, model: Any, efforts: Any, param: Any) -> None:
            key = (str(provider or "*").strip().lower(), str(model or "*").strip().lower())
            values = tuple(
                str(item).strip().lower()
                for item in (efforts or [])
                if str(item).strip()
            )
            rows[key] = (values, str(param or DEFAULT_EFFORT_PARAM).strip() or DEFAULT_EFFORT_PARAM)

        if isinstance(raw, Mapping):
            flat = _first(raw, "entries", "rows", "table")
            nested = _first(raw, "providers")
            if isinstance(flat, Sequence) and not isinstance(flat, (str, bytes, bytearray)):
                for item in flat:
                    if not isinstance(item, Mapping):
                        continue
                    add(
                        _first(item, "provider", "mode", "provider_ref", "providerRef"),
                        _first(item, "model"),
                        _first(item, "efforts", "effort_values", "effortValues", "values"),
                        _first(item, "param", "request_param", "requestParam"),
                    )
            elif isinstance(nested, Sequence) and not isinstance(nested, (str, bytes, bytearray)):
                for group in nested:
                    if not isinstance(group, Mapping):
                        continue
                    provider = _first(group, "provider", "mode", "provider_ref", "providerRef")
                    models = _first(group, "models") or []
                    if isinstance(models, Mapping):
                        for model, efforts in models.items():
                            add(provider, model, efforts, None)
                        continue
                    for item in models:
                        if isinstance(item, Mapping):
                            add(
                                provider,
                                _first(item, "model"),
                                _first(item, "efforts", "effort_values", "effortValues", "values"),
                                _first(item, "param", "request_param", "requestParam"),
                            )
            else:
                for provider, models in raw.items():
                    if not isinstance(models, Mapping):
                        continue
                    for model, efforts in models.items():
                        add(provider, model, efforts, None)
        return cls(rows=rows)

    def supported(self, *, provider: Optional[str], model: Optional[str]) -> tuple[str, ...]:
        row = self._row(provider, model)
        return row[0] if row else ()

    def resolve(
        self, *, provider: Optional[str], model: Optional[str], effort: Optional[str]
    ) -> Optional[EffortBinding]:
        """Return the binding, or None when the model does not support `effort`."""
        wanted = str(effort or "").strip().lower()
        if not wanted:
            return None
        row = self._row(provider, model)
        if row is None:
            return None
        efforts, param = row
        if wanted not in efforts:
            return None
        return EffortBinding(effort=wanted, param=param)

    def _row(
        self, provider: Optional[str], model: Optional[str]
    ) -> Optional[tuple[tuple[str, ...], str]]:
        provider_key = str(provider or "*").strip().lower()
        model_key = str(model or "*").strip().lower()
        for key in (
            (provider_key, model_key),
            ("*", model_key),
            (provider_key, "*"),
        ):
            if key in self.rows:
                return self.rows[key]
        return None


def resolve_effort(
    table: Optional[EffortTable],
    *,
    provider: Optional[str],
    model: Optional[str],
    effort: Optional[str],
) -> Optional[EffortBinding]:
    """Gate a requested effort. Unknown table or unsupported model → None + log.

    ADR-0134 D2: the provider×model table is the server's truth. Without it the
    adapter refuses to guess and drops the effort rather than sending a value the
    model may reject.
    """
    wanted = str(effort or "").strip().lower()
    if not wanted:
        return None
    if table is None:
        log.warning(
            "effort %r ignored: provider effort table unavailable (model=%s provider=%s)",
            wanted,
            model,
            provider,
        )
        return None
    binding = table.resolve(provider=provider, model=model, effort=wanted)
    if binding is None:
        log.warning(
            "effort %r ignored: unsupported for model=%s on provider=%s (supported=%s)",
            wanted,
            model,
            provider,
            ",".join(table.supported(provider=provider, model=model)) or "none",
        )
    return binding


# ---------------------------------------------------------------------------
# Transport (injected — no network in tests)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class ProviderResponse:
    status: int
    body: str = ""
    headers: Mapping[str, str] = field(default_factory=dict)

    def json(self) -> Any:
        if not self.body:
            return {}
        try:
            return json.loads(self.body)
        except (TypeError, ValueError):
            return {}

    def header(self, *names: str) -> Optional[str]:
        lowered = {str(key).lower(): str(value) for key, value in self.headers.items()}
        for name in names:
            value = lowered.get(name.lower())
            if value:
                return value
        return None


Transport = Callable[..., Awaitable[ProviderResponse]]


# ---------------------------------------------------------------------------
# Quota snapshots (ADR-0135 D2 — numbers only)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class QuotaSnapshot:
    provider_ref: str
    window: str
    remaining_ratio: float
    resets_at: Optional[str]
    probed_at: str

    def to_payload(self) -> dict[str, Any]:
        payload = {
            "provider_ref": str(self.provider_ref),
            "window": str(self.window),
            "remaining_ratio": float(self.remaining_ratio),
            "resets_at": self.resets_at,
            "probed_at": str(self.probed_at),
        }
        return assert_snapshot_credential_free(payload)


def assert_snapshot_credential_free(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Enforce the ADR-0135 D2 ingest body: exactly 5 keys, numbers + timestamps.

    This is the ADR-0004 tripwire on the ingest path — a token, an Authorization
    header or a raw provider body can never reach momo through a snapshot.
    """
    if set(payload) != set(QUOTA_SNAPSHOT_KEYS):
        raise ProviderQuotaContractError(
            "quota snapshot must contain exactly "
            f"{sorted(QUOTA_SNAPSHOT_KEYS)}, got {sorted(payload)}"
        )
    window = str(payload["window"])
    if window not in QUOTA_WINDOWS:
        raise ProviderQuotaContractError(
            f"quota snapshot window must be one of {list(QUOTA_WINDOWS)}, got {window!r}"
        )
    ratio = payload["remaining_ratio"]
    if isinstance(ratio, bool) or not isinstance(ratio, (int, float)):
        raise ProviderQuotaContractError("remaining_ratio must be a number")
    if not 0.0 <= float(ratio) <= 1.0:
        raise ProviderQuotaContractError("remaining_ratio must be within [0,1]")
    for key in ("provider_ref", "probed_at"):
        value = payload[key]
        if not isinstance(value, str) or not value.strip():
            raise ProviderQuotaContractError(f"{key} must be a non-empty string")
    for key in ("probed_at",):
        if not _looks_like_iso_utc(str(payload[key])):
            raise ProviderQuotaContractError(f"{key} must be an ISO-8601 UTC timestamp")
    resets_at = payload["resets_at"]
    if resets_at is not None and (
        not isinstance(resets_at, str) or not _looks_like_iso_utc(resets_at)
    ):
        raise ProviderQuotaContractError("resets_at must be an ISO-8601 UTC timestamp or null")
    serialized = json.dumps(payload, sort_keys=True)
    if _CREDENTIAL_VALUE_SCANNER.search(serialized):
        raise ProviderQuotaContractError(
            "quota snapshot carries credential-shaped text (ADR-0004)"
        )
    return dict(payload)


_ISO_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")


def _looks_like_iso_utc(value: str) -> bool:
    return bool(_ISO_UTC.match(value))


def iso_utc(moment: Optional[datetime] = None) -> str:
    when = moment or datetime.now(timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


_DURATION = re.compile(r"(?i)(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?")


def parse_reset_delta_seconds(raw: Any) -> Optional[float]:
    """Parse `60`, `"60"`, `"1m30s"`, `"250ms"` into seconds."""
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    text = str(raw).strip()
    if not text:
        return None
    total = 0.0
    matched = False
    for amount, unit in _DURATION.findall(text):
        matched = True
        value = float(amount)
        factor = {"ms": 0.001, "s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}.get(
            (unit or "s").lower(), 1.0
        )
        total += value * factor
    return total if matched else None


def _ratio(remaining: Any, limit: Any) -> Optional[float]:
    try:
        remaining_value = float(remaining)
        limit_value = float(limit)
    except (TypeError, ValueError):
        return None
    if limit_value <= 0:
        return None
    return max(0.0, min(1.0, remaining_value / limit_value))


def snapshot_from_window_payload(
    provider_ref: str, raw: Mapping[str, Any], *, now: Optional[datetime] = None
) -> Optional[QuotaSnapshot]:
    """Build one snapshot from a tolerant provider window object.

    Only numbers are lifted out — the provider body itself never travels to momo.
    """
    window = str(_first(raw, "window", "name", "period") or "").strip().lower()
    if window not in QUOTA_WINDOWS:
        return None
    ratio = _first(raw, "remaining_ratio", "remainingRatio", "ratio")
    if ratio is None:
        ratio = _ratio(
            _first(raw, "remaining", "remaining_requests", "remainingRequests"),
            _first(raw, "limit", "total", "limit_requests", "limitRequests"),
        )
    if ratio is None:
        return None
    try:
        ratio_value = max(0.0, min(1.0, float(ratio)))
    except (TypeError, ValueError):
        return None

    moment = now or datetime.now(timezone.utc)
    resets_at_raw = _first(raw, "resets_at", "resetsAt", "reset_at", "resetAt")
    resets_at: Optional[str] = None
    if isinstance(resets_at_raw, str) and _looks_like_iso_utc(resets_at_raw.strip()):
        resets_at = resets_at_raw.strip()
    if resets_at is None:
        delta = parse_reset_delta_seconds(
            _first(
                raw,
                "resets_in_seconds",
                "resetsInSeconds",
                "reset_after",
                "resetAfter",
                "reset",
            )
        )
        if delta is not None:
            resets_at = iso_utc(moment + timedelta(seconds=max(0.0, delta)))
    return QuotaSnapshot(
        provider_ref=provider_ref,
        window=window,
        remaining_ratio=ratio_value,
        resets_at=resets_at,
        probed_at=iso_utc(moment),
    )


# ---------------------------------------------------------------------------
# Provider adapters (the ADR-0135 D3 chat/health/probe interface)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class ProviderHealth:
    provider_ref: str
    ok: bool
    status: Optional[int] = None
    detail: str = ""


class ProviderAdapter:
    """chat / health / probe for one chain link.

    Subclasses implement the provider dialect. The link (base_url, mode) comes
    from momo; the credential comes from this adapter's own store.
    """

    def __init__(
        self,
        link: ProviderChainEntry,
        *,
        credential: ProviderCredential,
        transport: Transport,
        timeout_s: float = 120.0,
    ) -> None:
        self.link = link
        self.credential = credential
        self._transport = transport
        self.timeout_s = timeout_s

    @property
    def provider_ref(self) -> str:
        return self.link.provider_ref

    @property
    def mode(self) -> str:
        return self.link.mode

    async def chat(self, request: Mapping[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    async def health(self) -> ProviderHealth:
        raise NotImplementedError

    async def probe_quota(self) -> list[QuotaSnapshot]:
        raise NotImplementedError

    # -- shared plumbing ---------------------------------------------------
    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        headers.update(self.credential.headers())
        return headers

    async def _call(
        self, method: str, path: str, *, json_body: Optional[Mapping[str, Any]] = None
    ) -> ProviderResponse:
        url = f"{self.link.base_url}{path}"
        try:
            response = await self._transport(
                method, url, headers=self._headers(), json_body=json_body
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # transport failure == no response (ADR-0135 D1)
            raise ProviderCallError(
                self.provider_ref, status=None, detail=str(exc), cause=exc
            ) from exc
        if response.status >= 400:
            raise ProviderCallError(
                self.provider_ref, status=response.status, detail=response.body
            )
        return response


class OpenAICompatibleProvider(ProviderAdapter):
    """`/v1/chat/completions`-shaped provider (hermes and every OpenAI clone)."""

    chat_path = "/chat/completions"
    health_path = "/models"
    quota_path = "/usage"

    async def chat(self, request: Mapping[str, Any]) -> dict[str, Any]:
        response = await self._call("POST", self.chat_path, json_body=dict(request))
        body = response.json()
        return body if isinstance(body, Mapping) else {"body": response.body}

    async def health(self) -> ProviderHealth:
        try:
            response = await self._call("GET", self.health_path)
        except ProviderCallError as exc:
            return ProviderHealth(
                provider_ref=self.provider_ref,
                ok=False,
                status=exc.status,
                detail=exc.reason,
            )
        return ProviderHealth(
            provider_ref=self.provider_ref, ok=True, status=response.status, detail="ok"
        )

    async def probe_quota(self) -> list[QuotaSnapshot]:
        """Read remaining quota with the adapter's own credential.

        Body first (`{"windows": [...]}`), then rate-limit response headers. Only
        derived numbers leave this method — never the body or the headers.
        """
        now = datetime.now(timezone.utc)
        try:
            response = await self._call("GET", self.quota_path)
        except ProviderCallError as exc:
            log.info(
                "provider quota endpoint unavailable: ref=%s reason=%s",
                self.provider_ref,
                exc.reason,
            )
            return await self._probe_quota_from_headers(now)
        snapshots = self._snapshots_from_body(response.json(), now)
        if snapshots:
            return snapshots
        return self._snapshots_from_headers(response, now)

    async def _probe_quota_from_headers(self, now: datetime) -> list[QuotaSnapshot]:
        try:
            response = await self._call("GET", self.health_path)
        except ProviderCallError as exc:
            log.info(
                "provider quota probe failed: ref=%s reason=%s",
                self.provider_ref,
                exc.reason,
            )
            return []
        return self._snapshots_from_headers(response, now)

    def _snapshots_from_body(self, body: Any, now: datetime) -> list[QuotaSnapshot]:
        if not isinstance(body, Mapping):
            return []
        windows = _first(body, "windows", "quota", "quotas", "limits")
        if isinstance(windows, Mapping):
            windows = [
                {**value, "window": key}
                for key, value in windows.items()
                if isinstance(value, Mapping)
            ]
        if not isinstance(windows, Sequence) or isinstance(
            windows, (str, bytes, bytearray)
        ):
            return []
        snapshots: list[QuotaSnapshot] = []
        for item in windows:
            if not isinstance(item, Mapping):
                continue
            snapshot = snapshot_from_window_payload(self.provider_ref, item, now=now)
            if snapshot is not None:
                snapshots.append(snapshot)
        return snapshots

    def _snapshots_from_headers(
        self, response: ProviderResponse, now: datetime
    ) -> list[QuotaSnapshot]:
        pairs = (
            ("short", ("x-ratelimit-remaining-requests", "x-ratelimit-remaining"),
             ("x-ratelimit-limit-requests", "x-ratelimit-limit"),
             ("x-ratelimit-reset-requests", "x-ratelimit-reset")),
            ("weekly", ("x-quota-remaining-weekly",), ("x-quota-limit-weekly",),
             ("x-quota-reset-weekly",)),
        )
        snapshots: list[QuotaSnapshot] = []
        for window, remaining_keys, limit_keys, reset_keys in pairs:
            ratio = _ratio(
                response.header(*remaining_keys), response.header(*limit_keys)
            )
            delta = parse_reset_delta_seconds(response.header(*reset_keys))
            if ratio is None or delta is None:
                continue
            snapshots.append(
                QuotaSnapshot(
                    provider_ref=self.provider_ref,
                    window=window,
                    remaining_ratio=ratio,
                    resets_at=iso_utc(now + timedelta(seconds=max(0.0, delta))),
                    probed_at=iso_utc(now),
                )
            )
        return snapshots


class MockModeProvider(OpenAICompatibleProvider):
    """`local-mock` / `internal-host-mock` links.

    Same wire dialect, but no credential is expected and quota probing is a
    no-op — a mock has no real quota to report.
    """

    def _headers(self) -> dict[str, str]:
        return {"Content-Type": "application/json"}

    async def probe_quota(self) -> list[QuotaSnapshot]:
        return []


PROVIDER_CLASSES: dict[str, type[ProviderAdapter]] = {
    MODE_EXTERNAL_HERMES: OpenAICompatibleProvider,
    MODE_LOCAL_MOCK: MockModeProvider,
    MODE_INTERNAL_HOST_MOCK: MockModeProvider,
}


def build_provider_adapters(
    entries: Sequence[ProviderChainEntry],
    *,
    credentials: ProviderCredentialStore,
    transport: Transport,
    timeout_s: float = 120.0,
    factory: Optional[Callable[[ProviderChainEntry], ProviderAdapter]] = None,
) -> tuple[ProviderAdapter, ...]:
    """Instantiate one provider adapter per enabled link, in chain order."""
    built: list[ProviderAdapter] = []
    for entry in entries:
        if factory is not None:
            built.append(factory(entry))
            continue
        provider_class = PROVIDER_CLASSES.get(entry.mode)
        if provider_class is None:
            log.warning(
                "provider chain link skipped: unknown mode=%s ref=%s",
                entry.mode,
                entry.provider_ref,
            )
            continue
        built.append(
            provider_class(
                entry,
                credential=credentials.for_ref(entry.provider_ref),
                transport=transport,
                timeout_s=timeout_s,
            )
        )
    return tuple(built)


# ---------------------------------------------------------------------------
# Cascade (ADR-0135 D1)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class ProviderFallbackRecord:
    """The audit shape momo records: `provider.cascade.fallback {from,to,reason}`."""

    from_ref: str
    to_ref: str
    reason: str

    def to_payload(self) -> dict[str, str]:
        return {"from": self.from_ref, "to": self.to_ref, "reason": self.reason}


@dataclass(frozen=True, slots=True)
class ProviderChatOutcome:
    provider_ref: str
    result: Mapping[str, Any]
    fallbacks: tuple[ProviderFallbackRecord, ...] = ()


FallbackSink = Callable[[ProviderFallbackRecord], Any]


class ProviderCascade:
    """Try the chain in order; only a no-answer failure moves to the next link."""

    def __init__(
        self,
        providers: Sequence[ProviderAdapter],
        *,
        on_fallback: Optional[FallbackSink] = None,
    ) -> None:
        self._providers = tuple(providers)
        self._on_fallback = on_fallback

    @property
    def providers(self) -> tuple[ProviderAdapter, ...]:
        return self._providers

    async def chat(self, request: Mapping[str, Any]) -> ProviderChatOutcome:
        if not self._providers:
            raise ProviderChainEmpty("no enabled provider link is configured")
        fallbacks: list[ProviderFallbackRecord] = []
        last_error: Optional[ProviderCallError] = None
        for index, provider in enumerate(self._providers):
            try:
                result = await provider.chat(request)
            except ProviderCallError as exc:
                if not exc.fallback_eligible:
                    # 4xx validation failure is the user's error, not the
                    # provider's outage — never re-bill the next provider.
                    raise
                last_error = exc
                if index + 1 >= len(self._providers):
                    break
                record = ProviderFallbackRecord(
                    from_ref=provider.provider_ref,
                    to_ref=self._providers[index + 1].provider_ref,
                    reason=exc.reason,
                )
                fallbacks.append(record)
                await self._emit(record)
                continue
            return ProviderChatOutcome(
                provider_ref=provider.provider_ref,
                result=result,
                fallbacks=tuple(fallbacks),
            )
        assert last_error is not None  # loop body either returns or sets it
        raise last_error

    async def health(self) -> list[ProviderHealth]:
        return [await provider.health() for provider in self._providers]

    async def probe_quota(self) -> list[QuotaSnapshot]:
        snapshots: list[QuotaSnapshot] = []
        for provider in self._providers:
            try:
                snapshots.extend(await provider.probe_quota())
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - one bad link must not stop the rest
                log.info(
                    "provider quota probe error: ref=%s %s",
                    provider.provider_ref,
                    _redact(str(exc)),
                )
        return snapshots

    async def _emit(self, record: ProviderFallbackRecord) -> None:
        log.warning(
            "provider.cascade.fallback %s", json.dumps(record.to_payload(), sort_keys=True)
        )
        if self._on_fallback is None:
            return
        try:
            outcome = self._on_fallback(record)
            if inspect.isawaitable(outcome):
                await outcome
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - visibility must not break the run
            log.warning("provider cascade fallback notice failed: %s", _redact(str(exc)))


# ---------------------------------------------------------------------------
# Periodic quota probe (ADR-0135 D2)
# ---------------------------------------------------------------------------
class QuotaProbeScheduler:
    """Runs `probe_quota()` on a jittered interval and publishes numbers to momo."""

    def __init__(
        self,
        *,
        providers: Callable[[], Sequence[ProviderAdapter]],
        publish: Callable[[Mapping[str, Any]], Awaitable[None]],
        interval_s: float = 900.0,
        min_interval_s: float = 30.0,
        jitter_ratio: float = 0.1,
    ) -> None:
        self._providers = providers
        self._publish = publish
        self.interval_s = max(min_interval_s, float(interval_s))
        self._jitter_ratio = max(0.0, min(0.5, jitter_ratio))
        self._task: Optional[asyncio.Task[None]] = None
        self._stopping = False

    def next_delay(self) -> float:
        spread = self.interval_s * self._jitter_ratio
        return max(1.0, self.interval_s + random.uniform(-spread, spread))

    async def run_once(self) -> list[dict[str, Any]]:
        published: list[dict[str, Any]] = []
        for provider in self._providers():
            try:
                snapshots = await provider.probe_quota()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - a probe must never kill the loop
                log.info(
                    "provider quota probe failed: ref=%s %s",
                    provider.provider_ref,
                    _redact(str(exc)),
                )
                continue
            for snapshot in snapshots:
                try:
                    payload = snapshot.to_payload()
                except ProviderQuotaContractError as exc:
                    log.error("quota snapshot rejected before ingest: %s", exc)
                    continue
                try:
                    await self._publish(payload)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    log.info("quota snapshot ingest failed: %s", _redact(str(exc)))
                    continue
                published.append(payload)
        return published

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stopping = False
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stopping = True
        task, self._task = self._task, None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:  # pragma: no cover - expected teardown
            pass

    async def _loop(self) -> None:
        while not self._stopping:
            await asyncio.sleep(self.next_delay())
            if self._stopping:
                return
            await self.run_once()


# ---------------------------------------------------------------------------
# Request / result shaping for the OpenAI-compatible dialect
# ---------------------------------------------------------------------------
def chat_request(
    *,
    model: Optional[str],
    messages: Sequence[Mapping[str, Any]],
    effort: Optional[EffortBinding] = None,
    extra: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    request: dict[str, Any] = {
        "model": model or "hermes-agent",
        "messages": [dict(message) for message in messages],
        "stream": False,
    }
    if extra:
        request.update({key: value for key, value in extra.items() if key not in request})
    if effort is not None:
        request.update(effort.request_fields())
    return request


def gateway_result_from_chat(
    response: Mapping[str, Any], *, model: Optional[str] = None
) -> dict[str, Any]:
    """Map an OpenAI-compatible completion into the momo gateway result shape."""
    choices = response.get("choices")
    body = ""
    if isinstance(choices, Sequence) and choices and isinstance(choices[0], Mapping):
        message = choices[0].get("message")
        if isinstance(message, Mapping):
            body = str(message.get("content") or "")
        if not body:
            body = str(choices[0].get("text") or "")
    if not body:
        body = str(response.get("body") or response.get("content") or "")
    raw_usage = response.get("usage") if isinstance(response.get("usage"), Mapping) else {}
    usage = {
        "model": str(response.get("model") or model or "hermes-agent"),
        "prompt_tokens": _int(raw_usage.get("prompt_tokens")),
        "completion_tokens": _int(raw_usage.get("completion_tokens")),
        "cached_tokens": _int(
            _first(raw_usage, "cached_tokens")
            or _nested_int(raw_usage, "prompt_tokens_details", "cached_tokens")
        ),
        "reasoning_tokens": _int(
            _first(raw_usage, "reasoning_tokens")
            or _nested_int(raw_usage, "completion_tokens_details", "reasoning_tokens")
        ),
        "cost_micro_usd": _int(raw_usage.get("cost_micro_usd")),
        "was_estimated": not bool(raw_usage),
    }
    return {"status": "succeeded", "body": body, "error": None, "usage": usage}


def _int(value: Any) -> int:
    try:
        if value is None or isinstance(value, bool):
            return 0
        return int(value)
    except (TypeError, ValueError):
        return 0


def _nested_int(raw: Mapping[str, Any], outer: str, inner: str) -> Any:
    nested = raw.get(outer)
    if isinstance(nested, Mapping):
        return nested.get(inner)
    return None


def _redact(raw: Any) -> str:
    return _CREDENTIAL_VALUE_SCANNER.sub("[redacted]", str(raw))


__all__ = [
    "DEFAULT_EFFORT_PARAM",
    "EFFORT_TABLE_PATH",
    "FALLBACK",
    "KNOWN_MODES",
    "PROPAGATE",
    "QUOTA_SNAPSHOT_KEYS",
    "QUOTA_SNAPSHOT_PATH",
    "QUOTA_WINDOWS",
    "EffortBinding",
    "EffortTable",
    "MockModeProvider",
    "OpenAICompatibleProvider",
    "ProviderAdapter",
    "ProviderCallError",
    "ProviderCascade",
    "ProviderChainEmpty",
    "ProviderChainEntry",
    "ProviderChainError",
    "ProviderChatOutcome",
    "ProviderCredential",
    "ProviderCredentialLeak",
    "ProviderCredentialStore",
    "ProviderFallbackRecord",
    "ProviderHealth",
    "ProviderQuotaContractError",
    "ProviderResponse",
    "QuotaProbeScheduler",
    "QuotaSnapshot",
    "assert_snapshot_credential_free",
    "build_provider_adapters",
    "chat_request",
    "classify_provider_failure",
    "gateway_result_from_chat",
    "is_fallback_status",
    "iso_utc",
    "parse_provider_chain",
    "parse_reset_delta_seconds",
    "resolve_effort",
    "snapshot_from_window_payload",
]
