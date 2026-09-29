import { useState } from "react";
import { ApiError, type WorkSession } from "@momo/core/lib/api";
import type { InstructFrom } from "@momo/core/features/auth/humanSignature";
import type { WorkSessionEvent } from "@momo/core/features/work/workSessionModel";
import { agentPaneModel, type AgentPaneModel } from "@momo/core/features/workbench/agentPane";
import {
  permissionPreviewGate,
  type PermissionPreviewGate,
} from "@momo/core/features/workbench/permissionPreviewGate";
import { permissionPreviewSha256, type PermissionPreview } from "@momo/core/features/workbench/permissionPreview";
import { AgentProgressView, type AgentPaneActions } from "./AgentProgressView";
import { createAgentPaneStore } from "./agentPanes";
import { summaryOf, type AgentPaneSource } from "./agentPaneSource";

// 디자인 하네스의 A 칸 원천(#2779). 캡처와 디자인 검수가 라이트·다크에서 진행 뷰를
// 보는 자리다. 모양은 서버 투영(`validatedACPEvent`)이 실제로 싣는 키만 쓴다.

const OWNER = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-000000000202";
// 권한 요청은 630초가 지나면 닫힌 것으로 그리므로(#3013) 시각은 지금에서 거꾸로 센다.
// 「만료」 장면만 요청(5분째)을 11분 전에 둔다.
const MINUTE = 60_000;
let T0 = Date.now() - 6 * MINUTE;

function session(id: string, label: string, tool: string, status: WorkSession["status"]): WorkSession {
  return {
    id,
    workspaceId: "00000000-0000-7000-8000-000000000001",
    channelId: "019f9a34-53fd-7f7a-abff-1e1369f61090",
    memberId: OWNER,
    hostId: "019f9a34-53f2-793d-9ca7-5d5480407c9e",
    rootMessageId: `${id}-root`,
    tool,
    label,
    status,
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: T0,
  };
}

function builder(sessionId: string) {
  let n = 0;
  const ev = (type: string, payload: Record<string, unknown>, minute: number): WorkSessionEvent => {
    n += 1;
    return {
      eventId: `${sessionId}-ev-${n}`,
      type: type as WorkSessionEvent["type"],
      sessionId,
      atMs: T0 + minute * 60_000 + n,
      seq: n,
      payload: { work_session_id: sessionId, ...payload },
    };
  };
  const status = (extra: Record<string, unknown>, minute: number) =>
    ev("agent.status", { phase: "streaming", run_status: "running", ...extra }, minute);
  return { ev, status };
}

export const SESSION_WAIT = "019f9a34-0001-7000-8000-00000000a001";
export const SESSION_RUN = "019f9a34-0002-7000-8000-00000000a002";

function waitingEvents(): WorkSessionEvent[] {
  const { ev, status } = builder(SESSION_WAIT);
  return [
    status({ terminal_event: "created", detail: "MacBook에서 새 worktree로 열었어요" }, 0),
    status(
      {
        has_plan: true,
        plan: [
          { content: "온보딩 문구 파일 읽기", status: "completed" },
          { content: "존댓말 섞인 4곳을 해요체로", status: "in_progress" },
          { content: "「웹에서」 문구 고치기", status: "pending" },
          { content: "스냅샷 시험 갱신하고 PR 열기", status: "pending" },
        ],
      },
      1
    ),
    status({ tool_call_name: "read_file", detail: "onboarding/copy.ts · 184줄" }, 1),
    status({ tool_call_name: "grep", detail: "「합니다」 4곳, 「웹에서」 1곳" }, 2),
    // #3152: 소유자의 「이 세션 동안」 허락이 덮은 읽기 — 묻지 않고 지나간 한 줄(대기 카드와 섞이지 않는다).
    ev(
      "approval.auto_allowed",
      { action: "auto_allowed", status: "approved", scope: "session", tool_kind: "read", preview_sha256: "c".repeat(64) },
      2
    ),
    ev("agent.partial", { text_delta: "1단계 제목과 설명부터 해요체로 맞출게요. " }, 3),
    ev("agent.partial", { text_delta: "버튼 문구는 그다음에 봅니다." }, 3),
    status({ tool_call_name: "edit_file", detail: "onboarding/copy.ts\n- 워크스페이스를 만듭니다\n+ 워크스페이스를 만들어요\n- 팀원을 초대합니다\n+ 팀원을 초대해요\n(+6 −6)" }, 5),
    ev(
      "approval.requested",
      {
        action: "requested",
        action_type: "tool_call",
        status: "pending",
        options: [
          { option_id: "allow-once", name: "Allow once", kind: "allow_once" },
          { option_id: "allow-always", name: "Always allow", kind: "allow_always" },
          { option_id: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
      5
    ),
    ev("mystery.kind", { v: 2 }, 5),
  ];
}

function runningEvents(count = 0): WorkSessionEvent[] {
  const { ev, status } = builder(SESSION_RUN);
  const out: WorkSessionEvent[] = [
    status({ terminal_event: "created", detail: "team-box에서 이 폴더 그대로 열었어요" }, 0),
    status(
      {
        has_plan: true,
        plan: [
          { content: "재시도 발행 경로 찾기", status: "completed" },
          { content: "client_msg_id 중복 검사 넣기", status: "completed" },
          { content: "relay 회귀 시험 돌리기", status: "in_progress" },
        ],
      },
      1
    ),
    status({ tool_call_name: "search", detail: "relay/outbox.rs · publish_with_retry" }, 1),
    status({ tool_call_name: "read_file", detail: "server-rust/bins/momo-relay/src/outbox.rs" }, 2),
    status({ tool_call_name: "apply_diff", detail: "outbox.rs +42 −18 · 파일 3" }, 4),
    ev("approval.requested", { action: "requested", action_type: "tool_call", status: "pending", options: [{ option_id: "o", name: "Allow once", kind: "allow_once" }] }, 5),
    ev("approval.decided", { action: "decided", status: "approved", option_id: "o" }, 6),
    status({ tool_call_name: "bash", detail: "cargo test -p momo-relay dedupe" }, 6),
  ];
  for (let i = 0; i < count; i += 1) {
    const kinds = ["read_file", "grep", "edit_file", "bash", "apply_diff", "web_fetch"];
    out.push(status({ tool_call_name: kinds[i % kinds.length], detail: `단계 ${i + 1} 요약` }, 7 + Math.floor(i / 10)));
  }
  return out;
}

const DEMO_ACTIONS: AgentPaneActions = {
  decide: async () => undefined,
  reply: async () => undefined,
};

/** 결정 라우트의 답을 장면별로 흉내 낸다(골든 `cases`의 오류 코드). */
function sceneActions(scene: AgentFixtureScene): AgentPaneActions {
  if (scene === "unavailable") return { decide: null, reply: null };
  if (scene === "conflict") {
    return {
      decide: async () => {
        throw new ApiError(409, "permission already decided", "permission_already_decided");
      },
      reply: null,
    };
  }
  if (scene === "closed") {
    return {
      decide: async () => {
        throw new ApiError(409, "permission request closed", "permission_request_closed");
      },
      reply: null,
    };
  }
  // 서명을 요구하는 서버인데 이 칸이 아직 몰랐다(플래그 모름): 서버가 이름으로 거부한다(#3029).
  if (scene === "signature") {
    return {
      decide: async () => {
        throw new ApiError(403, "this instruction needs the owner's device-key signature", "device_signature_required");
      },
      reply: null,
    };
  }
  // #3028: 데스크탑 셸 + 서명을 요구하는 서버. 허락·지시가 서명 경로로 간다(흉내: 셸 없이 성공).
  if (scene === "signed" || scene.startsWith("signed-preview")) {
    return {
      decide: async () => undefined,
      reply: async () => ({ state: "sent" }),
      sessionScope: true,
      rejectWithInstruction: async () => ({ state: "rejected", instruction: { state: "sent" } }),
    };
  }
  // #3028: 서명·전달이 실패한다. 지시는 「전달 안 됨」, 거부는 갔지만 지시는 닿지 않음.
  if (scene === "signed-fail") {
    return {
      decide: async () => undefined,
      reply: async () => ({
        state: "not_delivered",
        stage: "sign",
        text: "서명을 취소해서 보내지 않았어요.",
        error: null,
      }),
      sessionScope: true,
      rejectWithInstruction: async () => ({
        state: "rejected",
        instruction: {
          state: "not_delivered",
          stage: "server",
          text: "호스트가 90초 넘게 응답하지 않아 보내지 않았어요. 호스트가 켜져 있는지 확인한 뒤 다시 보내 주세요.",
          error: null,
        },
      }),
    };
  }
  // 제품과 같이 지시(답장) 길은 없다(R2).
  if (scene === "decided" || scene === "lapsed" || scene === "offline" || scene === "browser") {
    return { ...DEMO_ACTIONS, reply: null };
  }
  return DEMO_ACTIONS;
}

export type AgentFixtureScene =
  | "tab"
  | "one"
  | "observer"
  | "long"
  | "unavailable"
  | "decided"
  | "conflict"
  | "closed"
  | "lapsed"
  | "offline"
  /** 일반 브라우저 + 서명을 요구하는 서버(ADR-0146 개정 D-4, #3029). */
  | "browser"
  /** 허락이 403 `device_signature_required`로 돌아온다(#3029). */
  | "signature"
  /** 데스크탑 셸이 서명한다(#3028): 「이 세션 동안」·「거부 + 지시」·지시 칸. */
  | "signed"
  /** 같은 표면, 서명·전달 실패(#3028 「전달 안 됨」). */
  | "signed-fail"
  /** #3128: 서명하는 표면 + 소유자 조회로 받은 host 미리보기(확인 통과). */
  | "signed-preview"
  /** #3128: 서버가 바꾼 미리보기 — 해시가 맞지 않아 허락이 닫힌다. */
  | "signed-preview-mismatch"
  /** #3128: 잘린 미리보기 — 보이지만 허락할 수 없다. */
  | "signed-preview-cut"
  /** #3128: 미리보기를 받는 중. */
  | "signed-preview-loading"
  /** #3128: 옛 host — 미리보기가 없다. */
  | "signed-preview-missing";

/** #3128: host가 만든 미리보기(흉내). 칸은 이것을 그대로 보이고 해시를 다시 계산한다. */
const HOST_PREVIEW: PermissionPreview = {
  schema: "momo.work_permission.preview.v1",
  kind: "edit",
  title: "Edit onboarding/copy.ts",
  locations: "/Users/me/oort/clients/web/src/onboarding/copy.ts:42",
  input: '{"new_string":"워크스페이스를 만들어요","old_string":"워크스페이스를 만듭니다","path":"onboarding/copy.ts"}',
  truncated: false,
};

function sceneGate(scene: AgentFixtureScene): PermissionPreviewGate | null {
  if (!scene.startsWith("signed-preview")) return null;
  const read = (preview: unknown) => ({
    status: "ok" as const,
    data: {
      permissionRequest: { id: "r", sessionId: SESSION_WAIT, requestEventId: "e", status: "pending" as const },
      options: [],
      preview,
    },
  });
  const hash = permissionPreviewSha256(HOST_PREVIEW);
  if (scene === "signed-preview-loading") return { state: "loading" };
  if (scene === "signed-preview-missing") return permissionPreviewGate(null, read(null));
  if (scene === "signed-preview-mismatch") {
    return permissionPreviewGate(hash, read({ ...HOST_PREVIEW, kind: "read", title: "Read README.md", input: '{"path":"README.md"}' }));
  }
  if (scene === "signed-preview-cut") {
    const cut: PermissionPreview = {
      ...HOST_PREVIEW,
      locations: Array.from({ length: 12 }, (_, i) => `/Users/me/oort/clients/web/src/onboarding/step${i + 1}.ts`).join("\n"),
      truncated: true,
    };
    return permissionPreviewGate(permissionPreviewSha256(cut), read(cut));
  }
  return permissionPreviewGate(hash, read(HOST_PREVIEW));
}

/**
 * `signature` 장면: 제품처럼 403 `device_signature_required`를 받으면 플래그를 다시
 * 읽어 안내로 바뀐다(agentPaneSource `recheck`). 캡처는 오류 직후가 아니라 바뀐 뒤다.
 */
function SignatureScene({ model, actions }: { model: AgentPaneModel; actions: AgentPaneActions }) {
  const [from, setFrom] = useState<InstructFrom>("here");
  const decide = actions.decide;
  return (
    <AgentProgressView
      model={model}
      ownerName="곽성재"
      instructFrom={from}
      actions={{
        ...actions,
        decide: decide
          ? async (d) => {
              try {
                await decide(d);
              } catch (err) {
                setTimeout(() => setFrom("app"), 300);
                throw err;
              }
            }
          : null,
      }}
    />
  );
}

/** 하네스 장면별 원천. 묶음은 메모리 저장소(캡처는 이 기기 저장소를 건드리지 않는다). */
export function fixtureAgentSource(scene: AgentFixtureScene): AgentPaneSource {
  T0 = Date.now() - (scene === "lapsed" ? 16 : 6) * MINUTE;
  const mem = new Map<string, string>();
  const store = createAgentPaneStore(() => ({
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
  }));
  const viewer = scene === "observer" ? OTHER : OWNER;
  const models = new Map<string, AgentPaneModel>([
    [
      SESSION_WAIT,
      agentPaneModel({
        session: session(SESSION_WAIT, "온보딩 1단계 문구 다듬기", "Claude Code", "running"),
        events: waitingEvents(),
        truncated: false,
        viewerMemberId: viewer,
        hostName: "MacBook",
      }),
    ],
    [
      SESSION_RUN,
      agentPaneModel({
        session: session(SESSION_RUN, "푸시 알림 두 번 오는 문제 수리", "Codex", "running"),
        events: runningEvents(scene === "long" ? 600 : 0),
        truncated: false,
        viewerMemberId: viewer,
        hostName: "team-box",
      }),
    ],
  ]);
  if (scene === "tab") {
    store.bind("p2", SESSION_WAIT);
    store.bind("p3", SESSION_RUN);
  } else if (scene === "long") {
    store.bind("p1", SESSION_RUN);
  } else {
    store.bind("p1", SESSION_WAIT);
  }
  const actions = sceneActions(scene);
  return {
    store,
    bindings: store.get(),
    candidates: [
      { id: SESSION_WAIT, label: "온보딩 1단계 문구 다듬기", harness: "Claude Code", hostName: "MacBook", status: "running" },
      { id: SESSION_RUN, label: "푸시 알림 두 번 오는 문제 수리", harness: "Codex", hostName: "team-box", status: "running" },
    ],
    summary: (id) => {
      const m = models.get(id);
      return m ? summaryOf(m) : null;
    },
    render: (id) => {
      const m = models.get(id);
      if (m && scene === "signature") return <SignatureScene model={m} actions={actions} />;
      return m ? (
        <AgentProgressView
          model={m}
          ownerName="곽성재"
          actions={actions}
          offline={scene === "offline"}
          instructFrom={scene === "browser" ? "app" : "here"}
          previewGate={id === SESSION_WAIT ? sceneGate(scene) : null}
        />
      ) : null;
    },
  };
}
