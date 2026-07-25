import type { Message, RosterMember } from "@/lib/api";

// =============================================================================
// Synthetic, in-memory timeline for the 1k-scroll performance gate. This
// isolates react-virtuoso rendering cost from network/DB, so the gate measures
// the WEBVIEW's virtualized-scroll behavior, which is independent of where the
// rows came from. Real seq-ordering and resume are measured separately against
// live momowebqa data (gates/gate-seq.mjs, gates/gate-resume.mjs).
//
// The fixture ships its own roster (design-taste-web §7: previews use realistic
// Korean+English team content, never "테스트 메시지 1"). Without it every row
// renders as a uuid stub, which hides the two things the dense capture exists
// to review: author grouping and the --agent token on the agent rows.
// =============================================================================

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const SEONGJAE = "00000000-0000-7000-8000-000000000101";
const DAYEON = "00000000-0000-7000-8000-000000000102";
const HERMES = "00000000-0000-7000-8000-000000000103";

export const STRESS_CHANNEL_ID = "00000000-0000-7000-8000-0000000002ff";

function member(overrides: Partial<RosterMember> & { id: string }): RosterMember {
  return {
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    displayName: "",
    handle: "",
    channelCount: 1,
    channelIds: [STRESS_CHANNEL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

/** Two humans and one agent, so grouping and agent identity are both visible. */
export function makeStressRoster(): RosterMember[] {
  return [
    member({ id: SEONGJAE, displayName: "곽성재", handle: "seongjae" }),
    member({ id: DAYEON, displayName: "박다연", handle: "dayeon" }),
    member({
      id: HERMES,
      kind: "agent",
      displayName: "김인턴",
      handle: "hermes",
      capabilities: ["shell", "code"],
      ownerHumanId: SEONGJAE,
      agentModel: "hermes-agent",
    }),
  ];
}

// Real work talk from the engine track: mixed Korean prose with the English
// identifiers people actually type. Lengths vary on purpose so the gate exercises
// variable row heights rather than a uniform grid.
const SCRIPT: Array<[string, string]> = [
  [SEONGJAE, "relay outbox lag p99가 1.2s 근처예요. batch size 만지기 전에 원인부터 봅시다."],
  [SEONGJAE, "grafana 대시보드 링크는 엔진 채널 상단에 고정해뒀습니다."],
  [
    HERMES,
    "outbox_drain 워커 로그를 읽었습니다. 재시작 루프 1건, 마지막 30분은 안정입니다. lag 상승 구간은 relay 재구독 직후 12초에 몰려 있습니다.",
  ],
  [DAYEON, "그 구간이면 centrifugo 쪽 backpressure 아닐까요? presence join 폭주 봤던 그 패턴이랑 비슷한데."],
  [SEONGJAE, "@hermes centrifugo node metrics도 같이 붙여줘요."],
  [
    HERMES,
    "붙였습니다. num_clients 3,412 / num_subs 18,904, publish p99 34ms. 병목은 transport가 아니라 PG advisory lock 대기로 보입니다.",
  ],
  [DAYEON, "그럼 drain 워커를 채널 샤드별로 쪼개는 게 맞겠네요. 스키마 변경은 없고요."],
  [SEONGJAE, "좋아요. ADR 없이 갈 수 있는 범위인지 먼저 확인하고 티켓 끊읍시다."],
  [
    HERMES,
    "rm -rf build/ 로 빌드 캐시를 정리하려 합니다. 되돌릴 수 없어서 승인이 필요합니다.",
  ],
  [SEONGJAE, "승인합니다. 끝나면 seq 기준 복구 마커 남는지 확인 부탁해요."],
  [HERMES, "정리 완료. 3개 디렉터리 삭제, 소요 2.4s. 승인 원장에 기록했습니다."],
  [DAYEON, "야간 소크 돌려두고 아침에 그래프 보죠. 저는 web 쪽 토큰 교체 diff 마저 봅니다."],
];

export function makeSyntheticMessages(count: number): Message[] {
  const base = Date.now() - count * 1000;
  const out: Message[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const [author, body] = SCRIPT[i % SCRIPT.length];
    out[i] = {
      id: `synthetic-${i + 1}`,
      channelId: STRESS_CHANNEL_ID,
      seq: i + 1,
      hlcTs: base + i * 1000,
      hlcCount: 0,
      authorMemberId: author,
      type: "text",
      body,
      state: "sent",
      createdAtMs: base + i * 1000,
    };
  }
  return out;
}
