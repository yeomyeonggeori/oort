"""Contract tests for the hermes adapter provider layer (ADR-0134 D2, ADR-0135 D2·D3).

Self-standing: no momo server, no Hermes gateway, no provider, no network.
Every provider call goes through an injected transport fixture.
"""

import asyncio
import dataclasses
import inspect
import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "adapters" / "hermes"))

# Mirror the repo gate shim: some interpreters can py_compile the adapter but
# cannot build dataclass(slots=True).
if "slots" not in inspect.signature(dataclasses.dataclass).parameters:
    _dataclass = dataclasses.dataclass

    def _dataclass_without_slots(*args, **kwargs):
        kwargs.pop("slots", None)
        return _dataclass(*args, **kwargs)

    dataclasses.dataclass = _dataclass_without_slots

import momo_adapter  # noqa: E402
import provider_chain  # noqa: E402

PRIMARY_BEARER = "sk-primary-adapter-owned-secret"
SECONDARY_BEARER = "sk-secondary-adapter-owned-secret"

MOMO_CHAIN = [
    {
        "provider_ref": "primary",
        "position": 0,
        "base_url": "https://primary.test/v1",
        "mode": "external-hermes",
        "enabled": True,
    },
    {
        "provider_ref": "secondary",
        "position": 1,
        "base_url": "https://secondary.test/v1",
        "mode": "external-hermes",
        "enabled": True,
    },
]

EFFORT_TABLE = {
    "entries": [
        {
            "provider": "external-hermes",
            "model": "kim-intern-l",
            "efforts": ["low", "medium", "high", "xhigh"],
        },
        {
            "provider": "external-hermes",
            "model": "kim-intern-s",
            "efforts": ["low", "medium"],
        },
    ]
}


def run(coro):
    return asyncio.run(coro)


class MockProviderTransport:
    """Scripted HTTP transport. Records every call; never touches the network."""

    def __init__(self, script):
        # script: {(METHOD, url_suffix): [response | Exception, ...]}
        self.script = {key: list(value) for key, value in script.items()}
        self.calls = []

    async def __call__(self, method, url, *, headers=None, json_body=None):
        self.calls.append(
            {
                "method": method.upper(),
                "url": url,
                "headers": dict(headers or {}),
                "json_body": None if json_body is None else dict(json_body),
            }
        )
        for (script_method, suffix), queue in self.script.items():
            if script_method.upper() != method.upper() or not url.endswith(suffix):
                continue
            if not queue:
                continue
            item = queue.pop(0) if len(queue) > 1 else queue[0]
            if isinstance(item, Exception):
                raise item
            return item
        return provider_chain.ProviderResponse(status=404, body='{"error":"unscripted"}')


def ok_completion(text="ok", model="kim-intern-l"):
    return provider_chain.ProviderResponse(
        status=200,
        body=json.dumps(
            {
                "model": model,
                "choices": [{"message": {"role": "assistant", "content": text}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 7},
            }
        ),
    )


def build_chain(transport, *, env=None, chain=None):
    entries = provider_chain.parse_provider_chain(chain or MOMO_CHAIN)
    store = provider_chain.ProviderCredentialStore(
        env if env is not None else {
            "HERMES_PROVIDER_BEARER__PRIMARY": PRIMARY_BEARER,
            "HERMES_PROVIDER_BEARER__SECONDARY": SECONDARY_BEARER,
        }
    )
    return entries, provider_chain.build_provider_adapters(
        entries, credentials=store, transport=transport
    )


# ---------------------------------------------------------------------------
# Chain shape + ADR-0004 boundary
# ---------------------------------------------------------------------------
class ProviderChainShapeTests(unittest.TestCase):
    def test_chain_is_ordered_by_position_and_drops_disabled_links(self):
        entries = provider_chain.parse_provider_chain(
            [
                {"provider_ref": "third", "position": 2, "base_url": "https://c.test/v1", "mode": "external-hermes"},
                {"provider_ref": "off", "position": 1, "base_url": "https://b.test/v1", "mode": "external-hermes", "enabled": False},
                {"provider_ref": "first", "position": 0, "base_url": "https://a.test/v1/", "mode": "external-hermes"},
            ]
        )

        self.assertEqual([entry.provider_ref for entry in entries], ["first", "third"])
        # Trailing slash normalized so path joins stay single-slash.
        self.assertEqual(entries[0].base_url, "https://a.test/v1")

    def test_chain_rejects_credential_material_from_momo(self):
        for leaked in ("bearer", "api_key", "apiKey", "authorization", "token", "headers"):
            with self.subTest(field=leaked):
                with self.assertRaises(provider_chain.ProviderCredentialLeak):
                    provider_chain.parse_provider_chain(
                        [
                            {
                                "provider_ref": "primary",
                                "position": 0,
                                "base_url": "https://primary.test/v1",
                                "mode": "external-hermes",
                                leaked: "sk-should-never-arrive",
                            }
                        ]
                    )

    def test_chain_entry_has_no_credential_attribute(self):
        entries = provider_chain.parse_provider_chain(MOMO_CHAIN)
        fields = {f.name for f in dataclasses.fields(entries[0])}

        self.assertEqual(
            fields, {"provider_ref", "position", "base_url", "mode", "enabled"}
        )

    def test_credentials_come_only_from_adapter_environment(self):
        transport = MockProviderTransport({("POST", "/chat/completions"): [ok_completion()]})
        _, providers = build_chain(transport)

        run(providers[0].chat({"model": "kim-intern-l", "messages": []}))

        self.assertEqual(
            transport.calls[0]["headers"]["Authorization"], f"Bearer {PRIMARY_BEARER}"
        )
        # Second link gets its own env credential, not the first one's.
        self.assertEqual(
            providers[1].credential.headers()["Authorization"],
            f"Bearer {SECONDARY_BEARER}",
        )

    def test_credential_repr_is_redacted(self):
        credential = provider_chain.ProviderCredential(bearer=PRIMARY_BEARER)

        self.assertNotIn(PRIMARY_BEARER, repr(credential))
        self.assertNotIn(PRIMARY_BEARER, str(credential))

    def test_mock_modes_never_send_a_credential(self):
        transport = MockProviderTransport({("POST", "/chat/completions"): [ok_completion()]})
        _, providers = build_chain(
            transport,
            env={"HERMES_PROVIDER_BEARER": PRIMARY_BEARER},
            chain=[
                {
                    "provider_ref": "mock",
                    "position": 0,
                    "base_url": "http://127.0.0.1:1/v1",
                    "mode": "local-mock",
                }
            ],
        )

        run(providers[0].chat({"model": "m", "messages": []}))

        self.assertNotIn("Authorization", transport.calls[0]["headers"])
        self.assertEqual(run(providers[0].probe_quota()), [])


# ---------------------------------------------------------------------------
# Failure classification (ADR-0135 D1)
# ---------------------------------------------------------------------------
class FailureClassificationTests(unittest.TestCase):
    def test_no_response_and_429_and_5xx_are_fallback_candidates(self):
        for status in (None, 429, 500, 502, 503, 504):
            with self.subTest(status=status):
                self.assertEqual(
                    provider_chain.classify_provider_failure(status=status),
                    provider_chain.FALLBACK,
                )

    def test_validation_4xx_propagates_instead_of_re_billing(self):
        for status in (400, 401, 403, 404, 409, 413, 422):
            with self.subTest(status=status):
                self.assertEqual(
                    provider_chain.classify_provider_failure(status=status),
                    provider_chain.PROPAGATE,
                )

    def test_rule_is_identical_to_the_momo_gateway_rule(self):
        for status in list(range(400, 600)) + [None]:
            with self.subTest(status=status):
                expected = (
                    True
                    if status is None
                    else momo_adapter.MomoAdapter._is_retryable_http_status(status)
                )
                self.assertEqual(provider_chain.is_fallback_status(status), expected)

    def test_cancellation_is_never_a_fallback(self):
        self.assertEqual(
            provider_chain.classify_provider_failure(
                status=None, error=asyncio.CancelledError()
            ),
            provider_chain.PROPAGATE,
        )


# ---------------------------------------------------------------------------
# Cascade (ADR-0135 D1)
# ---------------------------------------------------------------------------
class ProviderCascadeTests(unittest.TestCase):
    def _cascade(self, script, *, records=None):
        transport = MockProviderTransport(script)
        _, providers = build_chain(transport)
        sink = records.append if records is not None else None
        return transport, provider_chain.ProviderCascade(providers, on_fallback=sink)

    def test_two_link_chain_falls_back_on_503(self):
        records = []
        transport, cascade = self._cascade(
            {
                ("POST", "/chat/completions"): [
                    provider_chain.ProviderResponse(status=503, body="upstream down"),
                    ok_completion("second link answered"),
                ]
            },
            records=records,
        )

        outcome = run(cascade.chat({"model": "kim-intern-l", "messages": []}))

        self.assertEqual(outcome.provider_ref, "secondary")
        self.assertEqual(len(transport.calls), 2)
        self.assertTrue(transport.calls[0]["url"].startswith("https://primary.test/v1"))
        self.assertTrue(transport.calls[1]["url"].startswith("https://secondary.test/v1"))
        self.assertEqual(
            [record.to_payload() for record in records],
            [{"from": "primary", "to": "secondary", "reason": "http_503"}],
        )
        self.assertEqual(records, list(outcome.fallbacks))

    def test_two_link_chain_falls_back_on_429(self):
        records = []
        _, cascade = self._cascade(
            {
                ("POST", "/chat/completions"): [
                    provider_chain.ProviderResponse(status=429, body="rate limited"),
                    ok_completion(),
                ]
            },
            records=records,
        )

        outcome = run(cascade.chat({"model": "kim-intern-l", "messages": []}))

        self.assertEqual(outcome.provider_ref, "secondary")
        self.assertEqual(records[0].reason, "http_429")

    def test_two_link_chain_falls_back_when_the_first_link_never_answers(self):
        records = []
        _, cascade = self._cascade(
            {
                ("POST", "/chat/completions"): [
                    OSError("connection reset"),
                    ok_completion(),
                ]
            },
            records=records,
        )

        outcome = run(cascade.chat({"model": "kim-intern-l", "messages": []}))

        self.assertEqual(outcome.provider_ref, "secondary")
        self.assertEqual(records[0].to_payload()["reason"], "no_response")

    def test_4xx_propagates_and_the_second_link_is_never_called(self):
        records = []
        transport, cascade = self._cascade(
            {
                ("POST", "/chat/completions"): [
                    provider_chain.ProviderResponse(status=400, body="bad model"),
                    ok_completion(),
                ]
            },
            records=records,
        )

        with self.assertRaises(provider_chain.ProviderCallError) as ctx:
            run(cascade.chat({"model": "kim-intern-l", "messages": []}))

        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.disposition, provider_chain.PROPAGATE)
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(records, [])

    def test_exhausted_chain_raises_the_last_failure(self):
        records = []
        _, cascade = self._cascade(
            {
                ("POST", "/chat/completions"): [
                    provider_chain.ProviderResponse(status=500, body="a"),
                    provider_chain.ProviderResponse(status=502, body="b"),
                ]
            },
            records=records,
        )

        with self.assertRaises(provider_chain.ProviderCallError) as ctx:
            run(cascade.chat({"model": "kim-intern-l", "messages": []}))

        self.assertEqual(ctx.exception.status, 502)
        self.assertEqual(len(records), 1)

    def test_empty_chain_is_an_explicit_error(self):
        cascade = provider_chain.ProviderCascade([])

        with self.assertRaises(provider_chain.ProviderChainEmpty):
            run(cascade.chat({"model": "m", "messages": []}))

    def test_health_probes_every_link(self):
        transport = MockProviderTransport(
            {("GET", "/models"): [provider_chain.ProviderResponse(status=200, body="{}")]}
        )
        _, providers = build_chain(transport)

        health = run(provider_chain.ProviderCascade(providers).health())

        self.assertEqual([item.provider_ref for item in health], ["primary", "secondary"])
        self.assertTrue(all(item.ok for item in health))

    def test_provider_call_error_message_redacts_credentials(self):
        error = provider_chain.ProviderCallError(
            "primary", status=401, detail=f"Authorization: Bearer {PRIMARY_BEARER}"
        )

        self.assertNotIn(PRIMARY_BEARER, str(error))
        # `assertNotIn(PRIMARY_BEARER, ...)` on its own is a false pass: a pattern
        # that eats only the first character removes the *exact* string while
        # leaking everything from the second character on.
        self.assertNotIn(PRIMARY_BEARER[1:], str(error))


class RedactionTests(unittest.TestCase):
    """`_redact` must consume the *whole* secret, and no pattern may disarm another.

    Every case here is a regression of one defect family: a pattern that matches
    a credential but consumes less than all of it, leaving a usable suffix in the
    log line — and, worse, mangling the prefix that the next pattern anchors on.
    """

    def assertFullyRedacted(self, raw, *secrets):
        redacted = provider_chain._redact(raw)
        for secret in secrets:
            self.assertNotIn(secret, redacted, f"{secret!r} survived in {redacted!r}")
            # A surviving suffix is still a leak, so walk every suffix down to 8
            # characters instead of only comparing the exact string.
            for start in range(1, max(len(secret) - 8, 1)):
                self.assertNotIn(
                    secret[start:],
                    redacted,
                    f"suffix {secret[start:]!r} survived in {redacted!r}",
                )
        return redacted

    def test_bearer_redaction_consumes_the_entire_token(self):
        token = "sk-proj-AbCdEf0123456789ZZ"
        self.assertFullyRedacted(f"Authorization: Bearer {token}", token, token[1:])

    def test_bearer_redaction_covers_opaque_tokens_without_a_known_prefix(self):
        # No `sk-`/`ghp_`/`xox` prefix, so the bearer pattern is the *only*
        # defense here — there is no second pattern to fall back on.
        token = "hx_live_9f8e7d6c5b4a3210deadbeef"
        self.assertFullyRedacted(f"Authorization: Bearer {token}", token, token[1:])

    def test_bearer_pattern_does_not_disarm_the_prefix_patterns(self):
        # The defect: the bearer pattern ate the leading `s` of `sk-`, so the
        # `\bsk-` pattern no longer matched what was left behind.
        redacted = self.assertFullyRedacted(
            f"Authorization: Bearer {PRIMARY_BEARER}", PRIMARY_BEARER
        )
        self.assertNotIn("k-primary", redacted)

    def test_bearer_redaction_is_case_insensitive_and_survives_json(self):
        token = "sk-json-embedded-secret-value"
        serialized = json.dumps(
            {"headers": {"authorization": f"bearer {token}"}, "status": 401}
        )
        redacted = self.assertFullyRedacted(serialized, token)
        # Over-redaction has a floor too: the surrounding structure must survive
        # or the log line stops being diagnosable.
        self.assertIn("status", redacted)

    def test_prefixed_tokens_are_consumed_to_their_end(self):
        for token in (
            "sk-proj-AbCdEf0123456789",
            "ghp_AbCdEf0123456789zz",
            "xoxb-1234567890-abcdefghij",
            "ya29.a0AfB_abcdefghijklmnop",
        ):
            with self.subTest(token=token):
                self.assertFullyRedacted(f"detail token={token} end", token)

    def test_agent_token_and_jwt_signatures_are_not_left_behind(self):
        # `momo_agent_v1.<payload>.<signature>` and a JWT both carry a trailing
        # segment that the patterns stopped short of.
        self.assertFullyRedacted(
            "token=momo_agent_v1.abcdef12.SIGNATUREPART",
            "momo_agent_v1.abcdef12.SIGNATUREPART",
        )
        self.assertFullyRedacted(
            "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SIGSIGSIGSIG",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SIGSIGSIGSIG",
        )

    def test_snapshot_screening_still_catches_every_pattern(self):
        base = {
            "provider_ref": "primary",
            "window": "short",
            "remaining_ratio": 0.5,
            "resets_at": "2026-07-26T12:00:00Z",
            "probed_at": "2026-07-26T11:00:00Z",
        }
        for poisoned in (
            "Bearer hx_live_9f8e7d6c5b4a3210deadbeef",
            "bearer sk-proj-AbCdEf0123456789",
            "momo_agent_v1.abcdef12.SIGNATUREPART",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SIGSIGSIGSIG",
        ):
            with self.subTest(poisoned=poisoned):
                with self.assertRaises(provider_chain.ProviderQuotaContractError):
                    provider_chain.assert_snapshot_credential_free(
                        {**base, "provider_ref": poisoned}
                    )


# ---------------------------------------------------------------------------
# Effort (ADR-0134 D2)
# ---------------------------------------------------------------------------
class EffortMappingTests(unittest.TestCase):
    def setUp(self):
        self.table = provider_chain.EffortTable.from_payload(EFFORT_TABLE)

    def test_supported_effort_maps_to_the_provider_request_field(self):
        binding = provider_chain.resolve_effort(
            self.table, provider="external-hermes", model="kim-intern-l", effort="xhigh"
        )

        self.assertIsNotNone(binding)
        self.assertEqual(binding.request_fields(), {"reasoning_effort": "xhigh"})

    def test_unsupported_effort_for_the_model_is_ignored_and_logged(self):
        with self.assertLogs("momo.adapter.provider", level="WARNING") as logs:
            binding = provider_chain.resolve_effort(
                self.table,
                provider="external-hermes",
                model="kim-intern-s",
                effort="xhigh",
            )

        self.assertIsNone(binding)
        self.assertIn("ignored", "\n".join(logs.output))
        self.assertIn("kim-intern-s", "\n".join(logs.output))

    def test_unknown_model_is_ignored_and_logged(self):
        with self.assertLogs("momo.adapter.provider", level="WARNING"):
            self.assertIsNone(
                provider_chain.resolve_effort(
                    self.table,
                    provider="external-hermes",
                    model="not-in-table",
                    effort="high",
                )
            )

    def test_missing_table_drops_effort_instead_of_guessing(self):
        with self.assertLogs("momo.adapter.provider", level="WARNING"):
            self.assertIsNone(
                provider_chain.resolve_effort(
                    None, provider="external-hermes", model="kim-intern-l", effort="high"
                )
            )

    def test_absent_effort_is_not_an_error(self):
        self.assertIsNone(
            provider_chain.resolve_effort(
                self.table, provider="external-hermes", model="kim-intern-l", effort=None
            )
        )

    def test_table_accepts_the_nested_provider_shape(self):
        table = provider_chain.EffortTable.from_payload(
            {
                "providers": [
                    {
                        "provider": "external-hermes",
                        "models": [
                            {
                                "model": "claude-x",
                                "efforts": ["low", "high"],
                                "param": "thinking_effort",
                            }
                        ],
                    }
                ]
            }
        )

        binding = table.resolve(
            provider="external-hermes", model="claude-x", effort="high"
        )

        # Providers that split Effort and Thinking name their own request field.
        self.assertEqual(binding.request_fields(), {"thinking_effort": "high"})

    def test_chat_request_carries_the_mapped_effort(self):
        binding = provider_chain.EffortBinding(effort="high")

        request = provider_chain.chat_request(
            model="kim-intern-l",
            messages=[{"role": "user", "content": "hi"}],
            effort=binding,
        )

        self.assertEqual(request["reasoning_effort"], "high")
        self.assertEqual(request["model"], "kim-intern-l")
        self.assertFalse(request["stream"])

    def test_chat_request_omits_effort_when_unmapped(self):
        request = provider_chain.chat_request(
            model="kim-intern-l", messages=[], effort=None
        )

        self.assertNotIn("reasoning_effort", request)


# ---------------------------------------------------------------------------
# Quota probe (ADR-0135 D2)
# ---------------------------------------------------------------------------
class QuotaProbeTests(unittest.TestCase):
    def test_snapshot_payload_is_exactly_the_adr_ingest_body(self):
        snapshot = provider_chain.QuotaSnapshot(
            provider_ref="primary",
            window="short",
            remaining_ratio=0.42,
            resets_at="2026-07-26T12:00:00Z",
            probed_at="2026-07-26T11:00:00Z",
        )

        payload = snapshot.to_payload()

        self.assertEqual(
            sorted(payload),
            ["probed_at", "provider_ref", "remaining_ratio", "resets_at", "window"],
        )
        self.assertIsInstance(payload["remaining_ratio"], float)

    def test_snapshot_rejects_extra_keys(self):
        with self.assertRaises(provider_chain.ProviderQuotaContractError):
            provider_chain.assert_snapshot_credential_free(
                {
                    "provider_ref": "primary",
                    "window": "short",
                    "remaining_ratio": 0.5,
                    "resets_at": "2026-07-26T12:00:00Z",
                    "probed_at": "2026-07-26T11:00:00Z",
                    "authorization": "Bearer nope",
                }
            )

    def test_snapshot_rejects_credential_shaped_text(self):
        with self.assertRaises(provider_chain.ProviderQuotaContractError):
            provider_chain.assert_snapshot_credential_free(
                {
                    "provider_ref": f"Bearer {PRIMARY_BEARER}",
                    "window": "short",
                    "remaining_ratio": 0.5,
                    "resets_at": "2026-07-26T12:00:00Z",
                    "probed_at": "2026-07-26T11:00:00Z",
                }
            )

    def test_snapshot_rejects_bad_window_and_out_of_range_ratio(self):
        base = {
            "provider_ref": "primary",
            "window": "short",
            "remaining_ratio": 0.5,
            "resets_at": "2026-07-26T12:00:00Z",
            "probed_at": "2026-07-26T11:00:00Z",
        }
        with self.assertRaises(provider_chain.ProviderQuotaContractError):
            provider_chain.assert_snapshot_credential_free({**base, "window": "daily"})
        with self.assertRaises(provider_chain.ProviderQuotaContractError):
            provider_chain.assert_snapshot_credential_free({**base, "remaining_ratio": 1.5})
        with self.assertRaises(provider_chain.ProviderQuotaContractError):
            provider_chain.assert_snapshot_credential_free({**base, "resets_at": "soon"})

    def test_probe_lifts_only_numbers_out_of_the_provider_body(self):
        transport = MockProviderTransport(
            {
                ("GET", "/usage"): [
                    provider_chain.ProviderResponse(
                        status=200,
                        body=json.dumps(
                            {
                                "account": "acct_secret_name",
                                "authorization": f"Bearer {PRIMARY_BEARER}",
                                "windows": [
                                    {
                                        "window": "short",
                                        "remaining": 40,
                                        "limit": 200,
                                        "resets_in_seconds": 300,
                                    },
                                    {
                                        "window": "weekly",
                                        "remaining_ratio": 0.83,
                                        "resets_at": "2026-08-01T00:00:00Z",
                                    },
                                ],
                            }
                        ),
                    )
                ]
            }
        )
        _, providers = build_chain(transport)

        snapshots = run(providers[0].probe_quota())
        payloads = [snapshot.to_payload() for snapshot in snapshots]
        serialized = json.dumps(payloads)

        self.assertEqual([item["window"] for item in payloads], ["short", "weekly"])
        self.assertAlmostEqual(payloads[0]["remaining_ratio"], 0.2)
        self.assertEqual(payloads[1]["resets_at"], "2026-08-01T00:00:00Z")
        self.assertNotIn(PRIMARY_BEARER, serialized)
        self.assertNotIn("acct_secret_name", serialized)
        self.assertNotIn("Bearer", serialized)
        for payload in payloads:
            self.assertEqual(set(payload), set(provider_chain.QUOTA_SNAPSHOT_KEYS))

    def test_probe_falls_back_to_rate_limit_headers(self):
        transport = MockProviderTransport(
            {
                ("GET", "/usage"): [provider_chain.ProviderResponse(status=404, body="")],
                ("GET", "/models"): [
                    provider_chain.ProviderResponse(
                        status=200,
                        body="{}",
                        headers={
                            "x-ratelimit-remaining-requests": "25",
                            "x-ratelimit-limit-requests": "100",
                            "x-ratelimit-reset-requests": "1m30s",
                        },
                    )
                ],
            }
        )
        _, providers = build_chain(transport)

        payloads = [snapshot.to_payload() for snapshot in run(providers[0].probe_quota())]

        self.assertEqual(len(payloads), 1)
        self.assertEqual(payloads[0]["window"], "short")
        self.assertAlmostEqual(payloads[0]["remaining_ratio"], 0.25)

    def test_probe_returns_nothing_when_the_provider_is_silent(self):
        transport = MockProviderTransport(
            {
                ("GET", "/usage"): [OSError("no route to host")],
                ("GET", "/models"): [OSError("no route to host")],
            }
        )
        _, providers = build_chain(transport)

        self.assertEqual(run(providers[0].probe_quota()), [])

    def test_reset_delta_parsing(self):
        self.assertAlmostEqual(provider_chain.parse_reset_delta_seconds("90s"), 90.0)
        self.assertAlmostEqual(provider_chain.parse_reset_delta_seconds("1m30s"), 90.0)
        self.assertAlmostEqual(provider_chain.parse_reset_delta_seconds("250ms"), 0.25)
        self.assertAlmostEqual(provider_chain.parse_reset_delta_seconds(60), 60.0)
        self.assertIsNone(provider_chain.parse_reset_delta_seconds(None))

    def test_snapshot_from_window_payload_derives_absolute_reset(self):
        now = datetime(2026, 7, 26, 11, 0, 0, tzinfo=timezone.utc)

        snapshot = provider_chain.snapshot_from_window_payload(
            "primary",
            {"window": "short", "remaining": 1, "limit": 4, "resets_in_seconds": 3600},
            now=now,
        )

        self.assertEqual(snapshot.resets_at, "2026-07-26T12:00:00Z")
        self.assertEqual(snapshot.probed_at, "2026-07-26T11:00:00Z")
        self.assertAlmostEqual(snapshot.remaining_ratio, 0.25)

    def test_scheduler_publishes_every_window_once(self):
        transport = MockProviderTransport(
            {
                ("GET", "/usage"): [
                    provider_chain.ProviderResponse(
                        status=200,
                        body=json.dumps(
                            {
                                "windows": [
                                    {"window": "short", "remaining_ratio": 0.5, "resets_in_seconds": 60},
                                    {"window": "weekly", "remaining_ratio": 0.9, "resets_in_seconds": 600},
                                ]
                            }
                        ),
                    )
                ]
            }
        )
        _, providers = build_chain(transport)
        published = []

        async def publish(payload):
            published.append(dict(payload))

        scheduler = provider_chain.QuotaProbeScheduler(
            providers=lambda: providers, publish=publish, interval_s=1.0
        )

        run(scheduler.run_once())

        # 2 links x 2 windows.
        self.assertEqual(len(published), 4)
        self.assertEqual(
            {(item["provider_ref"], item["window"]) for item in published},
            {
                ("primary", "short"),
                ("primary", "weekly"),
                ("secondary", "short"),
                ("secondary", "weekly"),
            },
        )

    def test_scheduler_survives_a_failing_link(self):
        class Boom(provider_chain.ProviderAdapter):
            provider_ref = "boom"

            def __init__(self):
                pass

            async def probe_quota(self):
                raise RuntimeError("probe exploded")

        published = []

        async def publish(payload):
            published.append(dict(payload))

        scheduler = provider_chain.QuotaProbeScheduler(
            providers=lambda: [Boom()], publish=publish, interval_s=1.0
        )

        self.assertEqual(run(scheduler.run_once()), [])
        self.assertEqual(published, [])

    def test_scheduler_interval_floor_and_jitter_bounds(self):
        scheduler = provider_chain.QuotaProbeScheduler(
            providers=list, publish=None, interval_s=1.0
        )

        self.assertEqual(scheduler.interval_s, 30.0)
        for _ in range(50):
            delay = scheduler.next_delay()
            self.assertGreaterEqual(delay, 27.0)
            self.assertLessEqual(delay, 33.0)


# ---------------------------------------------------------------------------
# Result shaping
# ---------------------------------------------------------------------------
class GatewayResultShapeTests(unittest.TestCase):
    def test_completion_maps_to_the_momo_usage_shape(self):
        result = provider_chain.gateway_result_from_chat(
            {
                "model": "kim-intern-l",
                "choices": [{"message": {"content": "hello"}}],
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 5,
                    "prompt_tokens_details": {"cached_tokens": 3},
                    "completion_tokens_details": {"reasoning_tokens": 2},
                },
            }
        )

        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["body"], "hello")
        self.assertEqual(
            result["usage"],
            {
                "model": "kim-intern-l",
                "prompt_tokens": 12,
                "completion_tokens": 5,
                "cached_tokens": 3,
                "reasoning_tokens": 2,
                "cost_micro_usd": 0,
                "was_estimated": False,
            },
        )

    def test_missing_usage_is_marked_estimated(self):
        result = provider_chain.gateway_result_from_chat(
            {"choices": [{"message": {"content": "x"}}]}, model="fallback-model"
        )

        self.assertTrue(result["usage"]["was_estimated"])
        self.assertEqual(result["usage"]["model"], "fallback-model")


# ---------------------------------------------------------------------------
# Adapter wiring (MomoAdapter side, still momo-server-free)
# ---------------------------------------------------------------------------
class ChainAdapter(momo_adapter.MomoAdapter):
    """MomoAdapter with momo REST and the provider transport both captured."""

    def __init__(self, transport, *, env=None):
        cfg = momo_adapter.MomoConfig(
            api_base_url="http://momo.test",
            workspace_id="11111111-1111-7111-8111-111111111111",
            agent_member_id="22222222-2222-7222-8222-222222222222",
            agent_handle="hermes",
            agent_token="agent-token-fixture",
            allow_insecure_http=True,
        )
        super().__init__(cfg)
        self.momo_posts = []
        self.momo_gets = []
        self._test_transport = transport
        self._provider_credentials = provider_chain.ProviderCredentialStore(
            env if env is not None else {
                "HERMES_PROVIDER_BEARER__PRIMARY": PRIMARY_BEARER,
                "HERMES_PROVIDER_BEARER__SECONDARY": SECONDARY_BEARER,
            }
        )

    async def _provider_transport(self, method, url, *, headers=None, json_body=None):
        return await self._test_transport(
            method, url, headers=headers, json_body=json_body
        )

    async def _post(self, path, body):
        self.momo_posts.append({"path": path, "body": json.loads(json.dumps(dict(body)))})
        return {"status": "accepted"}

    async def _get(self, path):
        self.momo_gets.append(path)
        if path == provider_chain.EFFORT_TABLE_PATH:
            return EFFORT_TABLE
        return {}


def job_payload(**overrides):
    payload = {
        "workspace_id": "11111111-1111-7111-8111-111111111111",
        "run_id": "33333333-3333-7333-8333-333333333333",
        "channel_id": "44444444-4444-7444-8444-444444444444",
        "model": "kim-intern-l",
        "messages": [{"role": "user", "content": "hi"}],
        "provider_chain": MOMO_CHAIN,
    }
    payload.update(overrides)
    return payload


class AdapterProviderWiringTests(unittest.TestCase):
    def test_job_runs_through_the_chain_and_reports_the_fallback(self):
        transport = MockProviderTransport(
            {
                ("POST", "/chat/completions"): [
                    provider_chain.ProviderResponse(status=503, body="down"),
                    ok_completion("second link answered"),
                ]
            }
        )
        adapter = ChainAdapter(transport)
        adapter._gateway_job_leases["33333333-3333-7333-8333-333333333333"] = (
            momo_adapter.GatewayJobLease(job_id=1, lease_id="lease", expires_at_ms=1)
        )

        result = run(adapter._run_gateway_job(job_payload()))

        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["body"], "second link answered")
        fallback_posts = [
            post
            for post in adapter.momo_posts
            if "provider.cascade.fallback" in str(post["body"].get("detail", ""))
        ]
        self.assertEqual(len(fallback_posts), 1)
        detail = fallback_posts[0]["body"]["detail"]
        self.assertEqual(
            json.loads(detail.split("provider.cascade.fallback ", 1)[1]),
            {"from": "primary", "to": "secondary", "reason": "http_503"},
        )

    def test_4xx_from_the_first_link_is_not_cascaded_by_the_adapter(self):
        transport = MockProviderTransport(
            {
                ("POST", "/chat/completions"): [
                    provider_chain.ProviderResponse(status=422, body="bad request"),
                    ok_completion(),
                ]
            }
        )
        adapter = ChainAdapter(transport)

        with self.assertRaises(provider_chain.ProviderCallError):
            run(adapter._run_gateway_job(job_payload()))

        self.assertEqual(len(transport.calls), 1)

    def test_supported_effort_reaches_the_provider_request(self):
        transport = MockProviderTransport(
            {("POST", "/chat/completions"): [ok_completion()]}
        )
        adapter = ChainAdapter(transport)

        run(adapter._run_gateway_job(job_payload(routing={"effort": "xhigh"})))

        self.assertIn(provider_chain.EFFORT_TABLE_PATH, adapter.momo_gets)
        self.assertEqual(transport.calls[0]["json_body"]["reasoning_effort"], "xhigh")

    def test_unsupported_effort_is_dropped_before_the_provider_call(self):
        transport = MockProviderTransport(
            {("POST", "/chat/completions"): [ok_completion(model="kim-intern-s")]}
        )
        adapter = ChainAdapter(transport)

        with self.assertLogs("momo.adapter.provider", level="WARNING"):
            run(
                adapter._run_gateway_job(
                    job_payload(model="kim-intern-s", routing={"effort": "xhigh"})
                )
            )

        self.assertNotIn("reasoning_effort", transport.calls[0]["json_body"])

    def test_routing_model_override_wins_over_the_payload_model(self):
        transport = MockProviderTransport(
            {("POST", "/chat/completions"): [ok_completion()]}
        )
        adapter = ChainAdapter(transport)

        run(
            adapter._run_gateway_job(
                job_payload(routing={"model": "kim-intern-s", "effort": "medium"})
            )
        )

        self.assertEqual(transport.calls[0]["json_body"]["model"], "kim-intern-s")
        self.assertEqual(transport.calls[0]["json_body"]["reasoning_effort"], "medium")

    def test_chain_with_credential_material_is_rejected_and_not_installed(self):
        transport = MockProviderTransport({})
        adapter = ChainAdapter(transport)
        leaky = [dict(MOMO_CHAIN[0], bearer="sk-should-never-arrive")]

        with self.assertLogs("momo.adapter", level="ERROR") as logs:
            adapter._sync_provider_chain({"provider_chain": leaky})

        self.assertEqual(adapter._provider_adapters, ())
        self.assertIn("ADR-0004", "\n".join(logs.output))

    def test_quota_probe_posts_only_the_adr_ingest_body_to_momo(self):
        transport = MockProviderTransport(
            {
                ("GET", "/usage"): [
                    provider_chain.ProviderResponse(
                        status=200,
                        body=json.dumps(
                            {
                                "authorization": f"Bearer {PRIMARY_BEARER}",
                                "windows": [
                                    {"window": "short", "remaining_ratio": 0.5, "resets_in_seconds": 60},
                                    {"window": "weekly", "remaining_ratio": 0.9, "resets_in_seconds": 600},
                                ],
                            }
                        ),
                    )
                ]
            }
        )
        adapter = ChainAdapter(transport)
        adapter._sync_provider_chain({"provider_chain": MOMO_CHAIN})

        published = run(adapter.probe_provider_quotas())

        ingest = [
            post
            for post in adapter.momo_posts
            if post["path"] == provider_chain.QUOTA_SNAPSHOT_PATH
        ]
        self.assertEqual(len(ingest), 4)
        self.assertEqual(len(published), 4)
        for post in ingest:
            self.assertEqual(set(post["body"]), set(provider_chain.QUOTA_SNAPSHOT_KEYS))
        serialized = json.dumps(ingest)
        self.assertNotIn(PRIMARY_BEARER, serialized)
        self.assertNotIn(SECONDARY_BEARER, serialized)
        self.assertNotIn("Bearer", serialized)
        self.assertNotIn("Authorization", serialized)

    def test_probe_is_a_noop_without_a_chain(self):
        adapter = ChainAdapter(MockProviderTransport({}))

        self.assertEqual(run(adapter.probe_provider_quotas()), [])
        self.assertEqual(adapter.momo_posts, [])

    def test_effort_is_forwarded_to_a_runtime_chat_that_accepts_it(self):
        seen = {}

        class Runtime:
            async def chat(self, *, messages, model, reasoning_effort=None):
                seen["model"] = model
                seen["reasoning_effort"] = reasoning_effort
                return {"body": "runtime answered"}

        adapter = ChainAdapter(MockProviderTransport({}))
        adapter.runtime = Runtime()

        result = run(adapter._run_gateway_job(job_payload(routing={"effort": "high"})))

        self.assertEqual(result["body"], "runtime answered")
        self.assertEqual(seen, {"model": "kim-intern-l", "reasoning_effort": "high"})

    def test_effort_is_not_forwarded_to_a_runtime_chat_that_rejects_it(self):
        class Runtime:
            async def chat(self, *, messages, model):
                return {"body": "runtime answered"}

        adapter = ChainAdapter(MockProviderTransport({}))
        adapter.runtime = Runtime()

        result = run(adapter._run_gateway_job(job_payload(routing={"effort": "high"})))

        self.assertEqual(result["body"], "runtime answered")

    def test_effort_table_is_fetched_once_and_cached(self):
        transport = MockProviderTransport(
            {("POST", "/chat/completions"): [ok_completion()]}
        )
        adapter = ChainAdapter(transport)

        run(adapter._run_gateway_job(job_payload(routing={"effort": "high"})))
        run(adapter._run_gateway_job(job_payload(routing={"effort": "low"})))

        self.assertEqual(
            adapter.momo_gets.count(provider_chain.EFFORT_TABLE_PATH), 1
        )


if __name__ == "__main__":
    unittest.main()
