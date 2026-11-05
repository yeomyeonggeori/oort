import { describe, expect, it } from "vitest";
import { argumentSpecs, loadMessageCatalog, messageKeys } from "../../i18n";
import type { RestOutcome } from "../../lib/http";
import { createMessageCopy } from "../../testkit/i18n";
import { CONNECTION_KEYS as K } from "./copyKeys";
import {
  copyForCause,
  deriveConnectionState,
  foldConnectionEvent,
  initialConnectionInput,
  type ConnectionEvent,
  type ConnectionInput,
  type ConnectionView,
} from "./model";
import { INITIAL_REST_SIGNAL } from "./restSignal";
import * as thresholds from "./thresholds";

// 이 파일의 시험은 숫자를 상수가 아니라 **글자 그대로**(1_000, 10_000) 단정한다. 상수를 바꿔 문턱을 깨뜨렸을
// 때 단정이 같이 움직여 초록으로 남는 일이 없게 하려는 것이다.

const T0 = 1_700_000_000_000;

/** 기기 온라인, 소켓 연결됨(틈 없음), REST 이력 없음. */
function healthy(over: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    deviceOnline: true,
    socket: { status: "connected", open: null, ended: false },
    rest: INITIAL_REST_SIGNAL,
    sessionExpired: false,
    ...over,
  };
}

function run(events: ConnectionEvent[], from: ConnectionInput = healthy()): ConnectionInput {
  return events.reduce(foldConnectionEvent, from);
}

const drop = (at: number, status: "connecting" | "disconnected" = "disconnected"): ConnectionEvent => ({
  kind: "socket",
  at,
  status,
});

function unreachable(path: string): ConnectionEvent {
  const outcome: RestOutcome = {
    kind: "network",
    failure: "unreachable",
    at: T0,
    method: "GET",
    target: `http://server.test${path}`,
  };
  return { kind: "rest", outcome };
}

function at(input: ConnectionInput, ms: number): ConnectionView {
  return deriveConnectionState(input, T0 + ms);
}

describe("① 소켓 틈의 시계: 1초 미만 침묵, 10초 경계", () => {
  // 지키는 것: 1초 안에 돌아오는 소켓 흔들림은 화면에 아무 말도 하지 않고(웹이 잠금·붉은 막대를 즉시 걸던
  // 것을 막는다), 10초를 채우기 전에는 「끊김」이라 말하지 않는다. 틈은 connecting과 disconnected를 가르지
  // 않는다(웹은 한 번 붙은 뒤의 connecting을 disconnected로 보고한다, #786).
  it.each(["connecting", "disconnected"] as const)(
    "%s 틈: 999ms 침묵, 1000ms부터 「연결 중」, 9999ms까지 「연결 중」, 10000ms부터 끊김",
    (status) => {
      const input = run([drop(T0, status)]);
      expect(at(input, 0)).toMatchObject({ phase: "quiet", copy: null, nextChangeAt: T0 + 1_000 });
      expect(at(input, 999)).toMatchObject({ phase: "quiet", copy: null, canSend: true });
      expect(at(input, 1_000)).toMatchObject({
        phase: "connecting",
        cause: null,
        copy: { title: K.connecting, detail: null },
        action: null,
        canSend: true,
        nextChangeAt: T0 + 10_000,
      });
      expect(at(input, 9_999)).toMatchObject({ phase: "connecting", canSend: true });
      expect(at(input, 10_000)).toMatchObject({ phase: "down", cause: "realtimeDown", nextChangeAt: null });
    },
  );

  it("끝난 소켓(서버가 다시 연결하지 말라고 했다)은 기다리지 않고 바로 끊김이고, 늦은 connecting으로 되살아나지 않는다", () => {
    const ended = run([{ kind: "socket", at: T0, status: "disconnected", ended: true }]);
    expect(at(ended, 0)).toMatchObject({ phase: "down", cause: "realtimeDown" });
    const late = run([{ kind: "socket", at: T0 + 500, status: "connecting" }], ended);
    expect(at(late, 500).phase).toBe("down");
    const back = run([{ kind: "socket", at: T0 + 800, status: "connected" }], late);
    expect(at(back, 800).phase).toBe("ok");
  });
});

describe("② 실시간만 끊김: 보내기·올리기·승인이 열려 있다", () => {
  // 지키는 것: 전송은 REST이고 소켓은 수신용이다. 소켓만 끊겼다고 컴포저·승인·올리기를 잠그지 않는다
  // (웹이 `useOffline()`으로 38개 파일을 잠그던 것).
  it("소켓이 한 시간 끊겨 있어도 기기가 온라인이고 REST가 멀쩡하면 카드는 말하지만 아무것도 막지 않는다", () => {
    const input = run([drop(T0)]);
    for (const ms of [10_000, 60_000, 3_600_000]) {
      expect(at(input, ms)).toMatchObject({
        phase: "down",
        cause: "realtimeDown",
        canSend: true,
        canUpload: true,
        canDecide: true,
        composerNote: null,
        approvalNote: null,
        copy: { title: K.realtimeDownTitle, detail: K.realtimeDownDetail },
        action: { kind: "reconnectNow", labelKey: K.reconnectNow },
      });
    }
  });
});

describe("⑥ 모르면 막지 않는다", () => {
  // 지키는 것: 기기 상태를 모르거나(NetInfo의 unknown) 서버 사정이 불분명하면 보내기·올리기·승인을 열어 둔다.
  // 「할 수 있는데 막는」 쪽이 「못 하는데 열어 두는」 쪽보다 나쁘다(승인에는 기한이 있다).
  it("기기 상태를 모르면(null) 소켓이 오래 끊겨도 막지 않는다", () => {
    const view = at(run([drop(T0)], healthy({ deviceOnline: null })), 60_000);
    expect(view).toMatchObject({ phase: "down", cause: "realtimeDown", canSend: true, canUpload: true, canDecide: true });
  });

  it("서버에 닿지 못한 요청이 있지만 선언에는 못 미치고 소켓이 끊겼으면 「알 수 없음」이고 막지 않는다", () => {
    const input = run([unreachable("/v1/a"), unreachable("/v1/b"), drop(T0)]);
    expect(at(input, 20_000)).toMatchObject({
      phase: "down",
      cause: "unknown",
      canSend: true,
      canUpload: true,
      canDecide: true,
      composerNote: null,
      approvalNote: null,
      copy: { title: K.unknownTitle, detail: K.unknownDetail },
    });
  });

  it("틈이 언제 시작했는지조차 모르는 입력은 침묵하고 막지 않는다", () => {
    const view = deriveConnectionState(
      healthy({ deviceOnline: null, socket: { status: "connecting", open: null, ended: false } }),
      T0,
    );
    expect(view).toMatchObject({ phase: "ok", copy: null, canSend: true, canUpload: true, canDecide: true });
  });
});

describe("원인 우선순위", () => {
  // 지키는 것: 같은 순간에 여러 사실이 참이어도 화면이 하나만 말한다. 만료 > 기기 오프라인 > 서버에 닿지 못함 >
  // 소켓 틈. 오프라인과 서버·소켓 문제를 가르는 것이 이 모델의 일이다.
  const serverDown = [unreachable("/v1/a"), unreachable("/v1/b"), unreachable("/v1/c")];
  const cases: Array<{
    name: string;
    input: ConnectionInput;
    ms: number;
    expected: Partial<ConnectionView>;
  }> = [
    {
      name: "만료는 오프라인·서버·소켓보다 먼저다",
      input: run([...serverDown, drop(T0), { kind: "device", at: T0, online: false }, { kind: "session", expired: true }]),
      ms: 20_000,
      expected: { phase: "expired", cause: null, canSend: false, canUpload: false, canDecide: false },
    },
    {
      name: "기기 오프라인은 서버에 닿지 못함·소켓보다 먼저다",
      input: run([...serverDown, drop(T0), { kind: "device", at: T0, online: false }]),
      ms: 20_000,
      expected: { phase: "down", cause: "deviceOffline", canSend: false, composerNote: K.composerOffline },
    },
    {
      name: "서버에 닿지 못함은 소켓이 멀쩡해도 선다",
      input: run(serverDown),
      ms: 0,
      expected: { phase: "down", cause: "serverUnreachable", canSend: false, approvalNote: K.approvalServerUnreachable },
    },
    {
      name: "서버에 닿지 못함은 소켓 틈이 침묵 구간이어도 기다리지 않는다",
      input: run([...serverDown, drop(T0)]),
      ms: 0,
      expected: { phase: "down", cause: "serverUnreachable" },
    },
    {
      name: "기기 오프라인은 소켓 틈의 10초를 기다리지 않는다",
      input: run([drop(T0), { kind: "device", at: T0, online: false }]),
      ms: 0,
      expected: { phase: "down", cause: "deviceOffline", action: null },
    },
    {
      name: "소켓만 끊기고 응답 없는 요청도 없으면 실시간만 끊김",
      input: run([drop(T0)]),
      ms: 10_000,
      expected: { phase: "down", cause: "realtimeDown" },
    },
    {
      name: "소켓이 끊기고 응답 없는 요청이 선언 아래로 있으면 알 수 없음",
      input: run([unreachable("/v1/a"), drop(T0)]),
      ms: 10_000,
      expected: { phase: "down", cause: "unknown" },
    },
  ];
  it.each(cases)("$name", ({ input, ms, expected }) => {
    expect(at(input, ms)).toMatchObject(expected);
  });

  it("기기가 돌아오면 소켓 틈 시계를 새로 시작하고(끊김을 먼저 말하지 않는다), 꺼져 있던 동안의 실패는 서버 탓으로 세지 않는다", () => {
    let input = run([drop(T0), { kind: "device", at: T0 + 1_000, online: false }]);
    input = run([unreachable("/v1/a"), unreachable("/v1/b"), unreachable("/v1/c")], input);
    expect(at(input, 60_000).cause).toBe("deviceOffline");

    input = foldConnectionEvent(input, { kind: "device", at: T0 + 60_000, online: true });
    expect(at(input, 60_000)).toMatchObject({ phase: "connecting", copy: { title: K.connecting, detail: null } });
    expect(at(input, 69_999).phase).toBe("connecting");
    expect(at(input, 70_000)).toMatchObject({ phase: "down", cause: "realtimeDown" });
  });
});

describe("문턱의 정본", () => {
  // 지키는 것: 웹·폰 화면이 읽는 값이 코어 한 곳에 있고 바뀌지 않았다. 웹 띠의 옛 15초(`SUSTAINED_DOWN_MS`)와
  // 누른 뒤 6초(`RETRY_WINDOW_MS`)는 #5220이 띠를 모델로 옮기며 지웠으므로, 다시 생기면 이 표가 붉다.
  it("읽는 값이 글자 그대로이고, 지운 값은 없다", () => {
    expect({ ...thresholds }).toEqual({
      CONNECTING_BAND_DELAY_MS: 1_000,
      DISPLAY_GRACE_MS: 10_000,
      HEALED_MS: 5_000,
      SERVER_UNREACHABLE_STREAK: 3,
      AUTO_RESEND_MAX_ATTEMPTS: 3,
      AUTO_RESEND_WINDOW_MS: 300_000,
      RESUME_AFTER_HIDDEN_MS: 30_000,
      RECOVERED_FLASH_MS: 2_000,
    });
  });
});

describe("문구 키 전수", () => {
  // 지키는 것: 모델이 내놓는 문구 키는 모두 사전(ko·en)에 있고 비지 않게 풀린다. 사전에만 있거나 표에만 있는
  // 키(죽은 키·빠진 키)가 없다. 서버 원문·키 문자열이 사용자에게 새지 않는다(ADR-0213 §4·§7).
  const registry = Object.values(K).sort();

  it("사전의 connection.* 키와 CONNECTION_KEYS가 정확히 같다", () => {
    const inCatalog = messageKeys.filter((key) => key.startsWith("connection.")).sort();
    expect(registry).toEqual(inCatalog);
  });

  it("모든 키가 ko·en에서 폴백 없이 풀리고, ko는 한글이고 en은 한글이 없다", async () => {
    const format = async (locale: "ko-KR" | "en-US") => {
      const copy = createMessageCopy({
        messageLocale: locale,
        catalog: await loadMessageCatalog(locale),
      }) as unknown as (key: string, values?: Record<string, unknown>) => string;
      return Object.fromEntries(
        registry.map((key) => {
          const spec = (argumentSpecs as unknown as Record<string, Record<string, string>>)[key] ?? {};
          const values = Object.fromEntries(
            Object.entries(spec).map(([name, kind]) => [name, kind === "number" ? 2 : kind === "date" ? 0 : "3m"]),
          );
          return [key, copy(key, values)];
        }),
      );
    };
    const ko = await format("ko-KR");
    const en = await format("en-US");
    // 값만 잇는 틀(제목 + 이유를 한 문장으로 묶는 `{title}. {reason}`)에는 글자가 없다. 한글 검사 대신 두 값이 모두 들어갔는지 잰다(#5242).
    const templateOnly = new Set<string>([K.loadSentence]);
    for (const key of registry) {
      if (templateOnly.has(key)) {
        expect(ko[key], key).toBe("3m. 3m");
        expect(en[key], key).toBe("3m. 3m");
        continue;
      }
      expect(ko[key], key).toMatch(/[가-힣]/);
      expect(en[key], key).not.toMatch(/[가-힣]/);
      expect(en[key].trim(), key).not.toBe("");
    }
  });

  it("모델이 내놓을 수 있는 모든 키(상태·원인·행동·원인별 문장표)가 표 안에 있다", () => {
    const grid: ConnectionInput[] = [
      healthy(),
      run([drop(T0)]),
      run([unreachable("/v1/a"), drop(T0)]),
      run([unreachable("/v1/a"), unreachable("/v1/b"), unreachable("/v1/c")]),
      healthy({ deviceOnline: false }),
      healthy({ sessionExpired: true }),
    ];
    const emitted = new Set<string>();
    for (const input of grid) {
      for (const ms of [0, 1_000, 10_000]) {
        const view = at(input, ms);
        for (const key of [view.copy?.title, view.copy?.detail, view.composerNote, view.approvalNote, view.action?.labelKey]) {
          if (key) emitted.add(key);
        }
      }
    }
    for (const cause of ["deviceOffline", "serverUnreachable", "realtimeDown", "unknown", null] as const) {
      for (const key of Object.values(copyForCause(cause))) if (key) emitted.add(key);
    }
    expect(emitted.size).toBeGreaterThanOrEqual(10);
    for (const key of emitted) expect(registry, key).toContain(key);
  });
});

describe("불러오기 이유: 단추 곁 문장은 다음 행동을 되풀이하지 않는다 (#5307 L2)", () => {
  // 지키는 것: 곁에 「다시 시도」 단추가 서 있는 자리(상자·한 줄)가 쓰는 이유(`loadReasonBare`)에는 다음 행동(다시 시도해 주세요)이 없고, 단추가 없는 자리의
  // 이유(`loadReason`)는 다음 행동까지 말한다. 서버 못 닿음·원인 없음만 다르고 오프라인은 「연결되면 다시 불러올 수 있어요」라는 조건이라 둘이 같다.
  const causes = ["deviceOffline", "serverUnreachable", "realtimeDown", "unknown", null] as const;
  const say = async (locale: "ko-KR" | "en-US") => {
    const copy = createMessageCopy({
      messageLocale: locale,
      catalog: await loadMessageCatalog(locale),
    }) as unknown as (key: string) => string;
    return copy;
  };

  it("ko: 서버 못 닿음·원인 없음의 bare 문장에는 「다시 시도」가 없고, 단추 없는 문장에는 있다", async () => {
    const ko = await say("ko-KR");
    for (const cause of ["serverUnreachable", "realtimeDown", "unknown", null] as const) {
      const { loadReason, loadReasonBare } = copyForCause(cause);
      expect(ko(loadReasonBare), String(cause)).not.toContain("다시 시도");
      expect(ko(loadReason), String(cause)).toContain("다시 시도해 주세요");
      expect(loadReasonBare, String(cause)).not.toBe(loadReason);
    }
  });

  it("en: 같은 짝이 영어에서도 선다", async () => {
    const en = await say("en-US");
    for (const cause of ["serverUnreachable", "realtimeDown", "unknown", null] as const) {
      const { loadReason, loadReasonBare } = copyForCause(cause);
      expect(en(loadReasonBare), String(cause)).not.toMatch(/try again/i);
      expect(en(loadReason), String(cause)).toMatch(/try again/i);
    }
  });

  it("오프라인은 둘이 같다(「연결되면 다시 불러올 수 있어요」는 단추의 되풀이가 아니라 조건이다)", () => {
    const { loadReason, loadReasonBare } = copyForCause("deviceOffline");
    expect(loadReasonBare).toBe(loadReason);
  });

  it("모든 원인이 bare 문장을 갖는다", () => {
    for (const cause of causes) expect(copyForCause(cause).loadReasonBare, String(cause)).toMatch(/^connection\.load\./);
  });
});

describe("처음 입력", () => {
  it("앱이 뜨는 순간의 입력은 첫 핸드셰이크를 틈으로 세어 1초 침묵 뒤 「연결 중」이다", () => {
    const input = initialConnectionInput(T0);
    expect(at(input, 999).phase).toBe("quiet");
    expect(at(input, 1_000).phase).toBe("connecting");
    expect(at(input, 10_000).phase).toBe("down");
  });
});
