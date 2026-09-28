import { afterEach, describe, expect, it, vi } from "vitest";
import golden from "../../../../../../docs/api/work-permission-decision.golden.json";
import { installCoreHost, resetCoreHost, type SessionPort } from "@momo/core/runtime/host";
import {
  ApiError,
  decideWorkPermission,
  workPermissionDecisionBody,
  type WorkPermissionDecisionBody,
} from "@momo/core/lib/api";
import {
  PERMISSION_HOST_WAIT_MS,
  permissionFailure,
  permissionLapsed,
  permissionSentLine,
} from "@momo/core/features/workbench/agentPane";
import { agentRoutes } from "./agentPaneSource";

// #3013: A 칸 권한 카드가 #3000 결정 라우트에 붙는 모양을 골든
// (docs/api/work-permission-decision.golden.json)과 맞춘다. 서버 단위 시험과 workd
// inv_3가 같은 파일을 읽는다. 코어 순수성 게이트가 src 밖 import를 막으므로 골든을
// 읽는 계약 시험은 웹 트리에 둔다(MessageRow.gc8Golden.test.tsx와 같은 자리 규칙).

const WS = "00000000-0000-7000-8000-000000000001";
const SESSION = golden.ok_response.permissionRequest.sessionId;

function installHost(): void {
  const session: SessionPort = {
    getAccessToken: () => "access-token",
    getRefreshToken: () => null,
    getPersistedSession: () => null,
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: () => {},
    clearSession: () => {},
  };
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

function goldenCase(name: string) {
  const found = golden.cases.find((c) => c.name === name);
  if (!found) throw new Error(`golden case ${name} missing`);
  return found;
}

/**
 * 골든 규칙대로 답하는 서버 흉내. 비어 있지 않은 `instruction`은 R2 전까지 400
 * `permission_instruction_unsupported`다(골든 `instruction` 사례).
 */
function goldenServer() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, method: String(init.method), body });
    if (typeof body.instruction === "string" && body.instruction.trim() !== "") {
      return new Response(
        JSON.stringify({ error: { message: "instruction unsupported", code: "permission_instruction_unsupported" } }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify(golden.ok_response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("decision request matches the golden", () => {
  for (const name of ["owner_allow_once", "owner_reject_once"]) {
    it(`${name}: path, method and the exact body`, async () => {
      installHost();
      const calls = goldenServer();
      const c = goldenCase(name);
      const decided = await decideWorkPermission(WS, SESSION, c.body as WorkPermissionDecisionBody);
      expect(calls).toHaveLength(1);
      const path = golden.route.path.replace("{workspaceId}", WS).replace("{workSessionId}", SESSION);
      expect(calls[0].url).toBe(`https://oort.test${path}`);
      expect(calls[0].method).toBe(golden.route.method);
      // 엄격한 같음: 골든에 없는 키 하나(지시문·세션 id)도 얹히지 않는다.
      expect(calls[0].body).toStrictEqual(c.body);
      expect(Object.keys(calls[0].body as object).sort()).toEqual(["kind", "optionId", "requestEventId"]);
      expect(decided.status).toBe(golden.ok_response.permissionRequest.status);
    });
  }

  it("a caller's stray instruction never reaches the wire (R2 refusal is never tripped)", async () => {
    installHost();
    const calls = goldenServer();
    const c = goldenCase("instruction");
    // 지시문을 실은 객체를 넘겨도 본문은 셋뿐이다. 실리면 골든 서버가 400으로 거부한다.
    await expect(
      decideWorkPermission(WS, SESSION, c.body as unknown as WorkPermissionDecisionBody)
    ).resolves.toMatchObject({ requestEventId: c.body.requestEventId });
    expect(calls[0].body).not.toHaveProperty("instruction");
    expect(workPermissionDecisionBody(c.body as unknown as WorkPermissionDecisionBody)).toStrictEqual({
      requestEventId: c.body.requestEventId,
      optionId: c.body.optionId,
      kind: c.body.kind,
    });
  });

  it("carries error.code on the ApiError for every golden refusal", async () => {
    installHost();
    for (const c of golden.cases.filter((x) => "code" in x && x.code)) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(JSON.stringify({ error: { message: "refused", code: (c as { code: string }).code } }), {
            status: c.status,
            headers: { "content-type": "application/json" },
          })
        )
      );
      const err = await decideWorkPermission(WS, SESSION, c.body as WorkPermissionDecisionBody).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(c.status);
      expect((err as ApiError).code).toBe((c as { code: string }).code);
    }
  });
});

describe("honest sentences for each answer", () => {
  it("the two 409s say different things and both close the card", () => {
    const already = permissionFailure(new ApiError(409, "", "permission_already_decided"));
    const closed = permissionFailure(new ApiError(409, "", "permission_request_closed"));
    expect(already).toEqual({
      closed: true,
      text: "이미 다른 결정이 먼저 들어갔어요. 다른 기기에서 결정했을 수 있어요.",
    });
    expect(closed.closed).toBe(true);
    expect(closed.text).toContain("이미 닫혔어요");
    expect(closed.text).not.toBe(already.text);
  });

  it("403 owner_only closes; a network failure keeps the buttons for a retry", () => {
    expect(permissionFailure(new ApiError(403, "", "permission_owner_only"))).toEqual({
      closed: true,
      text: "이 세션의 소유자만 결정할 수 있어요. 서버가 이 결정을 받지 않았어요.",
    });
    expect(permissionFailure(new TypeError("fetch failed")).closed).toBe(false);
    expect(permissionFailure(new ApiError(503, "")).closed).toBe(false);
  });

  it("every golden error code has a sentence, and no sentence carries a code", () => {
    for (const code of golden.error_codes) {
      const status = code === "permission_already_decided" || code === "permission_request_closed"
        ? 409
        : code.endsWith("owner_only") || code.endsWith("not_human")
          ? 403
          : 400;
      const f = permissionFailure(new ApiError(status, "", code));
      expect(f.closed).toBe(true);
      expect(f.text).not.toMatch(/permission_|[A-Za-z]{4,}/);
      expect(f.text).toMatch(/요\.$/);
    }
    expect(permissionSentLine("allow_once")).toMatch(/요\.$/);
    expect(permissionSentLine("reject_once")).toMatch(/요\.$/);
  });
});

describe("lapse", () => {
  it("the card closes when the host stops waiting: server TTL + 30s", () => {
    expect(PERMISSION_HOST_WAIT_MS).toBe(golden.ttl_seconds * 1000 + 30_000);
    const atMs = 1_790_550_000_000;
    expect(permissionLapsed({ atMs }, atMs + PERMISSION_HOST_WAIT_MS - 1)).toBe(false);
    expect(permissionLapsed({ atMs }, atMs + PERMISSION_HOST_WAIT_MS)).toBe(true);
  });
});

describe("product route wiring", () => {
  it("re-reads the thread after a 200 and after a settled 409; the error still reaches the card", async () => {
    installHost();
    goldenServer();
    const reread = vi.fn();
    const routes = agentRoutes(WS, reread);
    const c = goldenCase("owner_allow_once");
    await routes.decide!({ sessionId: SESSION, ...(c.body as WorkPermissionDecisionBody) });
    expect(reread).toHaveBeenCalledTimes(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "x", code: "permission_already_decided" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })
      )
    );
    const err = await routes.decide!({ sessionId: SESSION, ...(c.body as WorkPermissionDecisionBody) }).catch((e) => e);
    expect((err as ApiError).code).toBe("permission_already_decided");
    expect(reread).toHaveBeenCalledTimes(2);
    expect(routes.reply).toBeNull();
  });
});

describe("device signature required (#3029)", () => {
  it("a 403 device_signature_required re-reads the flag so the pane turns to the app line", async () => {
    installHost();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "x", code: "device_signature_required" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      )
    );
    const reread = vi.fn();
    const recheck = vi.fn();
    const routes = agentRoutes(WS, reread, recheck);
    const c = goldenCase("owner_allow_once");
    const err = await routes.decide!({ sessionId: SESSION, ...(c.body as WorkPermissionDecisionBody) }).catch((e) => e);
    expect((err as ApiError).code).toBe("device_signature_required");
    expect(recheck).toHaveBeenCalledTimes(1);
    // 다른 403은 플래그를 다시 읽지 않는다.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "x", code: "permission_owner_only" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      )
    );
    await routes.decide!({ sessionId: SESSION, ...(c.body as WorkPermissionDecisionBody) }).catch(() => undefined);
    expect(recheck).toHaveBeenCalledTimes(1);
  });
});
