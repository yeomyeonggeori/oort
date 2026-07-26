import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import type { ProviderChain, ProviderChainProbe } from "./api";
import {
  addDraftRow,
  cascadeProbeSummary,
  chainErrorCopy,
  chainSaveMessage,
  chainSummary,
  draftErrors,
  draftFromChain,
  draftIsDirty,
  draftRowError,
  draftToInput,
  fallbackEntries,
  headEntry,
  hopOrdinal,
  MAX_FALLBACK_HOPS,
  nextPosition,
  parseProbeEntries,
  parseProviderChain,
  patchDraftRow,
  probeReasonCopy,
  probeRows,
  removeDraftRow,
  type ChainDraftRow,
} from "./chainModel";

// =============================================================================
// The fixtures below are the ADR-0135 D1 contract as
// server/Sources/MomoServer/Routes/ProviderLinkChainRoutes.swift emits it
// (`ProviderChainResponse` / `ProviderChainEntryDTO` / `ProviderChainProbeDTO`),
// transcribed rather than invented: the endpoint has not landed on the server
// this client talks to, so the wire shape is pinned here or nowhere.
//
// The live baseline is measured, not assumed: on momowebqa (2026-07-26)
// `GET /v1/provider/link/chain` answers 404 and `POST /v1/provider/link/test`
// answers the MOMO-572 body with no `entries` and no `cascadeOk`. Both of those
// cases have a test below, because both are what a person sees today.
// =============================================================================

/** Head from the operator's saved singleton, plus two fallback hops. */
const CHAIN: ProviderChain = {
  schema: "momo.provider_link.chain.v0",
  entries: [
    {
      position: 0,
      source: "provider_link",
      mode: "external-hermes",
      baseUrl: "https://api.anthropic.com/v1",
      endpointLabel: "api.anthropic.com",
      enabled: true,
      bearerConfigured: true,
      bearerLast4: "8f21",
      updatedAtMs: 1_785_000_000_000,
    },
    {
      position: 1,
      source: "chain",
      mode: "external-hermes",
      baseUrl: "https://gateway.dawn.internal:8443/v1",
      endpointLabel: "gateway.dawn.internal:8443",
      enabled: true,
      bearerConfigured: true,
      bearerLast4: "c40a",
      updatedAtMs: 1_785_000_100_000,
    },
    {
      position: 2,
      source: "chain",
      mode: "external-hermes",
      baseUrl: "https://backup.dawn.internal/v1",
      endpointLabel: "backup.dawn.internal",
      enabled: false,
      bearerConfigured: true,
      bearerLast4: "1b77",
    },
  ],
  fallbackCount: 2,
  // `ProviderCascade.attemptable` filters the WHOLE plan, head included, so a
  // live head plus one live fallback plus one parked fallback is 2, not 2
  // fallbacks. The summary sentence has to say which it is counting.
  attemptableCount: 2,
};

const HEAD_ONLY: ProviderChain = {
  schema: "momo.provider_link.chain.v0",
  entries: [CHAIN.entries[0]],
  fallbackCount: 0,
  attemptableCount: 1,
};

describe("wire parsing", () => {
  it("reads the contract body unchanged", () => {
    expect(parseProviderChain(CHAIN)).toEqual(CHAIN);
  });

  // The measured crash: gate:shell's `**/v1/**` catch-all answers 200 with
  // `{channels:[],members:[],…}` for any route nobody mocked. Reading `entries`
  // off that threw inside render and unmounted the WHOLE 설정 route. This route
  // does not exist on the server yet, so a 200 is not proof of the contract.
  it("refuses a 200 that is not a chain at all", () => {
    expect(
      parseProviderChain({ channels: [], members: [], read_states: [] })
    ).toBeNull();
    expect(parseProviderChain({ entries: "nope" })).toBeNull();
    expect(parseProviderChain(null)).toBeNull();
    expect(parseProviderChain([])).toBeNull();
    expect(parseProviderChain("<!doctype html>")).toBeNull();
  });

  it("drops an entry with no position or address, and keeps the rest", () => {
    const parsed = parseProviderChain({
      entries: [CHAIN.entries[0], { position: 1 }, null, CHAIN.entries[1]],
    });
    expect(parsed?.entries.map((e) => e.position)).toEqual([0, 1]);
  });

  // fallbackCount is recomputed because the rows carry it. attemptableCount is
  // NOT: it depends on stored bearers this client never sees, so a default of 0
  // would be an invented fact ("시도되는 경로 0개") rather than a missing one.
  it("recomputes the fallback count and leaves the attemptable count absent", () => {
    const parsed = parseProviderChain({ entries: CHAIN.entries });
    expect(parsed?.fallbackCount).toBe(2);
    expect(parsed?.attemptableCount).toBeUndefined();
  });

  it("falls back to the address when a row carries no label", () => {
    const parsed = parseProviderChain({
      entries: [{ position: 1, baseUrl: "https://api.example.com/v1" }],
    });
    expect(parsed?.entries[0].endpointLabel).toBe("https://api.example.com/v1");
    expect(parsed?.entries[0].enabled).toBe(true);
    expect(parsed?.entries[0].bearerConfigured).toBe(false);
  });

  // `entries` is an ADR-0135 D1 ADDITION to the MOMO-572 probe body, so the
  // live momowebqa answer has no such key (measured 2026-07-26). That has to
  // degrade to the old single-hop sentence, never to a crash or an empty table.
  it("answers an empty hop list for a pre-chain probe body", () => {
    expect(parseProbeEntries(undefined)).toEqual([]);
    expect(parseProbeEntries("nope")).toEqual([]);
    expect(parseProbeEntries([null, {}, 7])).toEqual([]);
  });

  it("reads the probe hops a chain server sends", () => {
    const hop = {
      position: 0,
      source: "provider_link",
      mode: "external-hermes",
      endpointLabel: "api.anthropic.com",
      enabled: true,
      ok: false,
      reason: "provider_unreachable",
      disposition: "fall_over",
    };
    expect(parseProbeEntries([hop])).toEqual([hop]);
  });
});

describe("chain projection", () => {
  it("keeps the head out of the editable list", () => {
    expect(headEntry(CHAIN)?.position).toBe(0);
    expect(fallbackEntries(CHAIN).map((e) => e.position)).toEqual([1, 2]);
  });

  it("sorts fallback hops by position whatever order the server sent", () => {
    const shuffled: ProviderChain = {
      ...CHAIN,
      entries: [CHAIN.entries[2], CHAIN.entries[0], CHAIN.entries[1]],
    };
    expect(fallbackEntries(shuffled).map((e) => e.position)).toEqual([1, 2]);
  });

  it("answers null for a head the server did not project", () => {
    expect(headEntry({ ...CHAIN, entries: [CHAIN.entries[1]] })).toBeNull();
  });
});

describe("attempt order is what a person reads", () => {
  it("counts the provider link as 1차", () => {
    expect(hopOrdinal(0)).toBe("1차");
    expect(hopOrdinal(1)).toBe("2차");
  });

  // The whole reason ordinals are derived from list order: delete the hop at
  // position 1 and the survivor still sits at position 2 on the server, but it
  // is now the SECOND thing tried. Printing "3차" there would be a lie about
  // what happens, and printing the raw position is wire vocabulary anyway.
  it("renumbers the label, never the stored position", () => {
    const draft = removeDraftRow(draftFromChain(CHAIN), "hop-1");
    expect(draft.map((row) => row.position)).toEqual([2]);
    expect(hopOrdinal(0 + 1)).toBe("2차");
  });
});

describe("draft seeding", () => {
  it("starts every key field empty and marks stored rows as not new", () => {
    const draft = draftFromChain(CHAIN);
    expect(draft.map((row) => row.bearer)).toEqual(["", ""]);
    expect(draft.map((row) => row.isNew)).toEqual([false, false]);
    expect(draft.map((row) => row.bearerLast4)).toEqual(["c40a", "1b77"]);
  });

  it("carries the server's enabled flag", () => {
    expect(draftFromChain(CHAIN).map((row) => row.enabled)).toEqual([true, false]);
  });

  it("seeds nothing from a chain that is only its head", () => {
    expect(draftFromChain(HEAD_ONLY)).toEqual([]);
  });
});

describe("position assignment (the credential identity rule)", () => {
  // PUT keeps the ciphertext stored AT A POSITION when the body omits a bearer.
  // A new row that reused a live position would therefore inherit another
  // provider's key, so `nextPosition` is one past the HIGHEST, never length+1.
  it("never reuses the position of a surviving hop after a delete", () => {
    const afterDelete = removeDraftRow(draftFromChain(CHAIN), "hop-1");
    expect(nextPosition(afterDelete)).toBe(3);
    const added = addDraftRow(afterDelete);
    expect(added.map((row) => row.position)).toEqual([2, 3]);
  });

  it("starts fallback hops at 1, because 0 is the singleton", () => {
    expect(nextPosition([])).toBe(1);
    expect(addDraftRow([])[0].position).toBe(1);
  });

  it("keeps stored positions untouched when a row is edited", () => {
    const draft = draftFromChain(CHAIN);
    const patched = patchDraftRow(draft, "hop-2", { enabled: true });
    expect(patched.map((row) => row.position)).toEqual([1, 2]);
    expect(patched[1].enabled).toBe(true);
  });
});

describe("draft validation mirrors the server", () => {
  const NEW_ROW: ChainDraftRow = {
    key: "new-1",
    position: 1,
    baseUrl: "",
    bearer: "",
    mode: "external-hermes",
    enabled: true,
    isNew: true,
  };

  it("asks for an address before anything else", () => {
    expect(draftRowError(NEW_ROW)).toEqual({
      field: "baseUrl",
      message: "provider 주소를 입력하세요.",
    });
  });

  it("rejects an address the server's validatedBaseURL would reject", () => {
    expect(draftRowError({ ...NEW_ROW, baseUrl: "api.example.com" })).toEqual({
      field: "baseUrl",
      message: "주소는 http:// 또는 https:// 로 시작해야 합니다.",
    });
  });

  // "bearer is required for new chain position N" — a new row with no key is a
  // guaranteed 400, so it is stopped here where the person can read why. The
  // field travels with the message: a key error rendered under provider 주소
  // sends a person to fix the one input they already filled in correctly.
  it("requires a key for a hop the server has never stored, and says so on the key", () => {
    expect(
      draftRowError({ ...NEW_ROW, baseUrl: "https://api.example.com/v1" })
    ).toEqual({
      field: "bearer",
      message: "새 provider는 키를 입력해야 저장됩니다.",
    });
  });

  // The opposite case, and it is not an error: an empty key on a STORED hop is
  // the documented way to keep a secret the API can never show anyone again.
  it("accepts an empty key on a stored hop", () => {
    const stored = draftFromChain(CHAIN)[0];
    expect(draftRowError(stored)).toBeNull();
    expect(draftErrors(draftFromChain(CHAIN)).size).toBe(0);
  });

  it("reports errors per row key so the message lands on the right field", () => {
    const draft = addDraftRow(draftFromChain(CHAIN));
    const errors = draftErrors(draft);
    expect([...errors.keys()]).toEqual(["new-3"]);
  });
});

describe("PUT body", () => {
  it("omits bearer entirely when the operator left it alone", () => {
    expect(draftToInput(draftFromChain(CHAIN))).toEqual([
      {
        position: 1,
        baseUrl: "https://gateway.dawn.internal:8443/v1",
        mode: "external-hermes",
        enabled: true,
      },
      {
        position: 2,
        baseUrl: "https://backup.dawn.internal/v1",
        mode: "external-hermes",
        enabled: false,
      },
    ]);
  });

  it("sends a typed key trimmed, and only for the row it was typed into", () => {
    const draft = patchDraftRow(draftFromChain(CHAIN), "hop-2", {
      bearer: "  sk-rotated  ",
    });
    const body = draftToInput(draft);
    expect(body[0]).not.toHaveProperty("bearer");
    expect(body[1].bearer).toBe("sk-rotated");
  });

  it("trims the address, because the server compares the stored string", () => {
    const draft = patchDraftRow(draftFromChain(CHAIN), "hop-1", {
      baseUrl: "  https://gateway.dawn.internal:8443/v1  ",
    });
    expect(draftToInput(draft)[0].baseUrl).toBe(
      "https://gateway.dawn.internal:8443/v1"
    );
  });

  it("stays inside the server's ceiling of fallback hops", () => {
    let draft: ChainDraftRow[] = [];
    for (let i = 0; i < MAX_FALLBACK_HOPS; i += 1) draft = addDraftRow(draft);
    expect(draftToInput(draft).length).toBe(MAX_FALLBACK_HOPS);
    expect(draft[MAX_FALLBACK_HOPS - 1].position).toBe(MAX_FALLBACK_HOPS);
  });
});

describe("dirty tracking", () => {
  it("is clean straight after a load", () => {
    expect(draftIsDirty(draftFromChain(CHAIN), CHAIN)).toBe(false);
  });

  it("notices a typed key even though nothing else moved", () => {
    const draft = patchDraftRow(draftFromChain(CHAIN), "hop-1", {
      bearer: "sk-rotated",
    });
    expect(draftIsDirty(draft, CHAIN)).toBe(true);
  });

  it("notices a parked hop and a removed hop", () => {
    expect(
      draftIsDirty(
        patchDraftRow(draftFromChain(CHAIN), "hop-1", { enabled: false }),
        CHAIN
      )
    ).toBe(true);
    expect(draftIsDirty(removeDraftRow(draftFromChain(CHAIN), "hop-1"), CHAIN)).toBe(
      true
    );
  });
});

describe("failure copy", () => {
  // The live case today: momowebqa answers 404 for this route. The panel must
  // read that as "this server has no chain yet", never as an empty chain.
  it("turns the pre-engine 404 into a sentence with a next step", () => {
    expect(chainErrorCopy(new ApiError(404, "HTTP 404"))).toBe(
      "이 서버는 아직 프로바이더 연결 순서를 제공하지 않습니다. 지금은 위의 provider 하나만 쓰입니다. 서버를 업데이트한 뒤 다시 열어보세요."
    );
  });

  it("leaves every other failure to the shared error path", () => {
    expect(chainErrorCopy(new ApiError(500, "boom"))).toBeNull();
    expect(chainErrorCopy(new Error("offline"))).toBeNull();
  });

  it("relays the server's own 400 reason, because only it knows the rule", () => {
    expect(
      chainSaveMessage(new ApiError(400, "duplicate chain position 2"))
    ).toBe(
      "서버가 이 연결 순서를 받지 않았습니다. 서버가 보고한 사유: duplicate chain position 2"
    );
  });

  it("answers a 403 with who can, not with a retry", () => {
    expect(chainSaveMessage(new ApiError(403, "forbidden"))).toBe(
      "provider 연결은 이 서버의 운영자만 바꿀 수 있습니다."
    );
  });
});

describe("summary line", () => {
  it("says what a chain of one actually means", () => {
    expect(chainSummary(HEAD_ONLY)).toBe(
      "폴백 provider가 없습니다. 첫 provider가 응답하지 않으면 그 실행은 실패합니다."
    );
  });

  // attemptableCount is the server's number (enabled AND usable), so a parked
  // or half-written hop is not counted as a route a turn would take. It counts
  // the head too, and the sentence names that: "폴백 2개, 경로 2개" beside a
  // 꺼둠 chip read as "both fallbacks are live", the opposite of the truth.
  it("reports the server's attemptable count and says the head is in it", () => {
    expect(chainSummary(CHAIN)).toBe(
      "폴백 provider 2개. 첫 provider까지 합쳐 지금 실제로 시도되는 경로는 2개입니다."
    );
    expect(chainSummary({ ...CHAIN, attemptableCount: 1 })).toBe(
      "폴백 provider 2개. 첫 provider까지 합쳐 지금 실제로 시도되는 경로는 1개입니다."
    );
  });

  // The clause is dropped, not filled with a zero. This parser exists because a
  // non-contract 200 is possible, so "시도되는 경로는 0개입니다" out of a missing
  // key would be exactly the invented fact it was written to prevent.
  it("drops the attempt clause when the body carried no count", () => {
    const parsed = parseProviderChain({ entries: CHAIN.entries })!;
    expect(chainSummary(parsed)).toBe("폴백 provider 2개를 두었습니다.");
  });
});

describe("probe results (entries[] + cascadeOk)", () => {
  const ENTRIES: ProviderChainProbe[] = [
    {
      position: 0,
      source: "provider_link",
      mode: "external-hermes",
      endpointLabel: "api.anthropic.com",
      enabled: true,
      ok: false,
      reason: "provider_unreachable",
      disposition: "fall_over",
    },
    {
      position: 1,
      source: "chain",
      mode: "external-hermes",
      endpointLabel: "gateway.dawn.internal:8443",
      enabled: true,
      ok: true,
      disposition: "ok",
    },
    {
      position: 2,
      source: "chain",
      mode: "external-hermes",
      endpointLabel: "backup.dawn.internal",
      enabled: false,
      ok: false,
      reason: "hop_disabled",
      disposition: "skipped",
    },
  ];

  /**
   * What a default self-host instance answers, and what momowebqa answers
   * today: no operator link, `HERMES_BASE_URL` pointing at the bundled mock, so
   * `probeHop` returns before calling anything. `disposition: propagate` is the
   * server's spelling for "a caller/config fact", not for "this failed".
   */
  const MOCK_HEAD: ProviderChainProbe = {
    position: 0,
    source: "environment",
    mode: "local-mock",
    endpointLabel: "127.0.0.1:8088",
    enabled: true,
    ok: false,
    reason: "not_external_provider",
    disposition: "propagate",
  };

  it("labels each hop by attempt order and by what a turn would do", () => {
    expect(probeRows(ENTRIES)).toEqual([
      {
        ordinal: "1차",
        endpointLabel: "api.anthropic.com",
        tone: "warn",
        label: "다음으로 넘어감",
        detail: "주소에 닿지 못했습니다. 다음 provider로 넘어갑니다.",
      },
      {
        ordinal: "2차",
        endpointLabel: "gateway.dawn.internal:8443",
        tone: "ok",
        label: "응답함",
        detail: "이 provider가 지금 실행을 처리합니다.",
      },
      {
        ordinal: "3차",
        endpointLabel: "backup.dawn.internal",
        tone: "muted",
        label: "꺼둠",
        detail: "꺼져 있어 시도하지 않습니다.",
      },
    ]);
  });

  // The distinction the whole ADR turns on: a 4xx does NOT fall over, because
  // spending a second budget on a caller error hides the real cause. An
  // operator reading every red row as "the cascade handles it" is the misread
  // this row exists to prevent.
  it("separates a config error from a provider outage", () => {
    const rows = probeRows([
      {
        position: 0,
        source: "provider_link",
        mode: "external-hermes",
        endpointLabel: "api.anthropic.com",
        enabled: true,
        ok: false,
        reason: "provider_status_401",
        disposition: "propagate",
      },
    ]);
    expect(rows[0].tone).toBe("danger");
    expect(rows[0].label).toBe("여기서 멈춤");
    expect(rows[0].detail).toBe(
      "provider가 401로 답했습니다. 다음 provider로 넘겨도 같은 이유로 실패하므로 여기서 멈춥니다."
    );
  });

  // The reason leads and the consequence follows it, because a fixed "응답하지
  // 않아" contradicted itself the moment the reason was 429 or 5xx: the provider
  // DID answer, it answered with a refusal.
  it("does not call a 503 or a 429 an absence of response", () => {
    const rows = probeRows([
      { ...ENTRIES[0], reason: "provider_status_503" },
      { ...ENTRIES[0], reason: "provider_rate_limited" },
    ]);
    expect(rows[0].detail).toBe(
      "provider가 503로 답했습니다. 다음 provider로 넘어갑니다."
    );
    expect(rows[1].detail).toBe(
      "요청 한도를 넘었습니다. 다음 provider로 넘어갑니다."
    );
    expect(rows.every((row) => !row.detail.includes("응답하지 않아"))).toBe(true);
  });

  // `probeHop` refuses to call a hop whose mode is not external-hermes and
  // answers `not_external_provider` with `disposition: propagate`. That is a
  // configuration fact, not an outage: drawing it danger "여기서 멈춤" told a
  // default self-host instance it was broken while its turns were succeeding.
  it("reads a mock-mode hop as a mode, not as a failure", () => {
    const rows = probeRows([MOCK_HEAD]);
    expect(rows[0].tone).toBe("muted");
    expect(rows[0].label).toBe("목 모드");
    expect(rows[0].detail).toBe(
      "모드가 목으로 되어 있어 이번 확인에서는 실제 provider를 부르지 않았습니다."
    );
  });

  // A cascade that fell over to a working hop is the cascade WORKING. Reporting
  // it as broken sends an operator to fix a provider that is doing its job. The
  // count is over hops that were actually CALLED, so the parked third one is
  // not counted as something that was checked.
  it("headlines a fallen-over-but-serving chain as serving", () => {
    expect(cascadeProbeSummary(true, ENTRIES)).toEqual({
      tone: "ok",
      text: "2차 provider가 응답했습니다. 확인한 2개 중 1개가 응답합니다.",
    });
  });

  it("headlines a chain nobody answered as a chain that fails now", () => {
    expect(
      cascadeProbeSummary(false, [ENTRIES[0], { ...ENTRIES[1], ok: false }])
    ).toEqual({
      tone: "warn",
      text: "확인한 provider 2개 중 응답한 곳이 없습니다. 지금은 실행이 실패합니다.",
    });
  });

  // The self-host default, and the sentence that was false. A momowebqa-shaped
  // instance serves its turns through the mock and answers them, while this
  // table said "지금은 실행이 실패합니다" about a check that called nothing.
  it("never claims a failure for an instance whose only hop is a mock", () => {
    const summary = cascadeProbeSummary(false, [MOCK_HEAD]);
    expect(summary).toEqual({
      tone: "muted",
      text: "확인할 수 있는 실제 provider가 없습니다. 모드가 목으로 되어 있어 이번 확인은 어디에도 요청하지 않았습니다.",
    });
    expect(summary.text).not.toContain("실패");
  });

  // Mixed: one real hop was called and did not answer, one mock hop was never
  // called, so what a turn would do is not this check's to state.
  it("reports what was checked and not the fate of what was not", () => {
    expect(
      cascadeProbeSummary(false, [
        { ...ENTRIES[0], ok: false },
        { ...MOCK_HEAD, position: 1, source: "chain" },
      ])
    ).toEqual({
      tone: "warn",
      text: "확인한 provider 1개 중 응답한 곳이 없습니다. 목 모드 provider는 이번 확인에서 부르지 않았습니다.",
    });
  });

  it("says so when every hop is parked", () => {
    expect(cascadeProbeSummary(false, [{ ...ENTRIES[2], position: 0 }])).toEqual({
      tone: "warn",
      text: "켜져 있는 provider가 없습니다. 하나 이상 켜야 실행할 수 있습니다.",
    });
  });

  // A flag with no matching row would otherwise name "0차", a hop that does not
  // exist. The rows are the more trustworthy answer when the two disagree.
  it("trusts the rows over a cascadeOk flag they do not support", () => {
    expect(cascadeProbeSummary(true, [{ ...ENTRIES[0], ok: false }])).toEqual({
      tone: "warn",
      text: "확인한 provider 1개 중 응답한 곳이 없습니다. 지금은 실행이 실패합니다.",
    });
  });

  it("translates every reason the probe can emit, generated ones included", () => {
    expect(probeReasonCopy("not_external_provider")).toBe(
      "모드가 목으로 되어 있어 실제 provider를 부르지 않습니다."
    );
    expect(probeReasonCopy("provider_not_configured")).toBe("주소나 키가 비어 있습니다.");
    expect(probeReasonCopy("provider_rate_limited")).toBe("요청 한도를 넘었습니다.");
    expect(probeReasonCopy("probe_not_run")).toBe("확인이 끝나지 않았습니다.");
    expect(probeReasonCopy("provider_status_503")).toBe("provider가 503로 답했습니다.");
    expect(probeReasonCopy(undefined)).toBe("");
  });

  // 401/403, and the most common operator mistake on this panel: a key pasted
  // wrong or rotated away. It was reaching the screen as the machine label.
  it("translates the auth failure the classifier names in its own comment", () => {
    expect(probeReasonCopy("provider_auth_failed")).toBe(
      "provider가 저장된 키를 받아들이지 않았습니다."
    );
  });

  it("names an unmapped reason as the server's report, never bare", () => {
    expect(probeReasonCopy("brand_new_label")).toBe(
      "서버가 보고한 사유: brand_new_label"
    );
  });
});
