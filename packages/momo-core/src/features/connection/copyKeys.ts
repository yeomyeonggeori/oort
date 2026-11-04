// =============================================================================
// 연결 상태 문구의 사전 키 표 (#5219, 감사 문서 §7). 웹·데스크탑·폰이 같은 표를 읽는다.
//
// 이 파일에는 문구가 없다. 문구는 `i18n/catalogs/{ko-KR,en-US}/connection.json`에 있다. 여기는 문장에
// 짧은 이름을 붙여 화면이 키 문자열을 손으로 적지 않게 하는 표다. `satisfies`가 표와 사전이 갈라지면
// (키를 지웠거나 오타가 났을 때) 컴파일을 멈춘다. 사전에 키를 더하고 이 표에 빠뜨리는 쪽은
// `model.test.ts`의 「문구 키 전수」가 잡는다.
//
// 키는 `feature.surface.intent` 세 칸이다(`i18n/tooling/generate.mjs`의 KEY 규칙). 감사 문서 §7의
// `connection.card.realtimeDown.title`처럼 네 칸이던 이름은 마지막 두 칸을 붙여
// `connection.card.realtimeDownTitle`로 폈다. 문장의 뜻은 그대로다.
// =============================================================================

import type { MessageArgs, MessageKey } from "../../i18n/generated/messages";

export type ConnectionKey = Extract<MessageKey, `connection.${string}`>;

/** 값을 받지 않는 문구의 키만. 모델이 내놓는 키는 모두 이 타입이라 `formatMessage(key)`가 인자 없이 불린다. */
export type ConnectionPlainKey = {
  [K in ConnectionKey]: MessageArgs[K] extends Record<string, never> ? K : never;
}[ConnectionKey];

export const CONNECTION_KEYS = {
  // 지속 표시(웹 연결 카드·폰 띠)
  connecting: "connection.card.connecting",
  realtimeDownTitle: "connection.card.realtimeDownTitle",
  realtimeDownDetail: "connection.card.realtimeDownDetail",
  serverUnreachableTitle: "connection.card.serverUnreachableTitle",
  serverUnreachableDetail: "connection.card.serverUnreachableDetail",
  /** 서버가 점검·재시작을 알릴 때만 쓴다(S-E #5223). 모델은 아직 읽지 않는다. */
  serverUpdatingTitle: "connection.card.serverUpdatingTitle",
  serverUpdatingDetail: "connection.card.serverUpdatingDetail",
  offlineTitle: "connection.card.offlineTitle",
  offlineDetail: "connection.card.offlineDetail",
  unknownTitle: "connection.card.unknownTitle",
  unknownDetail: "connection.card.unknownDetail",
  /** 「끊김」이 보였던 경우에만 2초(화면이 `끊김 → 정상` 전이로 판단한다). */
  recovered: "connection.card.recovered",
  /** 값 `relativeTime`(로케일 서비스의 `formatRelativeTime` 결과)을 받는다. */
  lastSynced: "connection.card.lastSynced",
  /** 받은함 · 목록이 한 번도 불러와지지 않은 채 오프라인일 때(「마지막 동기화」를 말할 시각이 없다). */
  neverSynced: "connection.card.neverSynced",
  // 행동
  reconnectNow: "connection.action.reconnectNow",
  retry: "connection.action.retry",
  // 막힌 자리의 한 줄
  composerOffline: "connection.composer.offline",
  composerServerUnreachable: "connection.composer.serverUnreachable",
  approvalOffline: "connection.approval.offline",
  approvalServerUnreachable: "connection.approval.serverUnreachable",
  // 불러오기 실패: 표면별 제목 + 이유
  loadConversationTitle: "connection.load.conversationTitle",
  loadChannelListTitle: "connection.load.channelListTitle",
  loadThreadTitle: "connection.load.threadTitle",
  loadMembersTitle: "connection.load.membersTitle",
  /** 받아 둔 글이 있을 때 목록 위 한 줄(상자로 덮지 않는다). */
  loadNewerTitle: "connection.load.newerTitle",
  loadInboxTitle: "connection.load.inboxTitle",
  loadInboxMoreTitle: "connection.load.inboxMoreTitle",
  loadMemberProfileTitle: "connection.load.memberProfileTitle",
  loadAgentRosterTitle: "connection.load.agentRosterTitle",
  loadAgentProfileTitle: "connection.load.agentProfileTitle",
  loadAgentHistoryTitle: "connection.load.agentHistoryTitle",
  loadAgentChannelsTitle: "connection.load.agentChannelsTitle",
  loadAgentRunTitle: "connection.load.agentRunTitle",
  loadActivityTitle: "connection.load.activityTitle",
  loadDeviceKeysTitle: "connection.load.deviceKeysTitle",
  loadLinkedDevicesTitle: "connection.load.linkedDevicesTitle",
  loadNotificationRulesTitle: "connection.load.notificationRulesTitle",
  loadLinkPreviewSettingTitle: "connection.load.linkPreviewSettingTitle",
  loadHermesStatusTitle: "connection.load.hermesStatusTitle",
  loadDmApprovalTitle: "connection.load.dmApprovalTitle",
  loadReasonOffline: "connection.load.reasonOffline",
  loadReasonServer: "connection.load.reasonServer",
  loadReasonUnknown: "connection.load.reasonUnknown",
  /** 값 `title`·`reason`(제목 문장과 이유 문장)을 받는다. 상자가 안 맞는 좁은 자리의 한 줄이 둘을 잇는다. */
  loadSentence: "connection.load.sentence",
  // 보내기 실패
  sendFailed: "connection.send.failed",
  resend: "connection.send.resend",
  /** 값 `count`(개수)를 받는다. 복수형은 언어별 틀이다. */
  resendAll: "connection.send.resendAll",
  /** 보내지 못한 글 곁의 원인 한 줄. 종류는 `sendFailure.ts`의 `SendFailureKind`. */
  sendReasonOffline: "connection.send.reasonOffline",
  sendReasonServer: "connection.send.reasonServer",
  sendReasonRejected: "connection.send.reasonRejected",
  // 올리기 실패
  uploadFailedOffline: "connection.upload.failedOffline",
  uploadFailedServer: "connection.upload.failedServer",
  /** 구분 코드가 올 때만 쓴다(S-E #5223). */
  uploadFailedNoArchive: "connection.upload.failedNoArchive",
  // 앱 전체
  sessionExpired: "connection.session.expired",
  /**
   * 로그인 전 화면(`ConnectScreen`)의 오프라인 안내 상자 설명(#5262). 제목은 `offlineTitle`을 쓴다. 카드의 `offlineDetail`은 「받아 둔 내용만 보여요」라
   * 받아 둔 것이 없는 로그인 전 화면에는 맞지 않는다.
   */
  bootOfflineDetail: "connection.boot.offlineDetail",
  /** 환영 화면에서 오프라인일 때 QR을 찍을 수 없는 까닭 한 줄(#5262). */
  bootOfflineQrDetail: "connection.boot.offlineQrDetail",
  bootUnreachable: "connection.boot.unreachable",
} as const satisfies Record<string, ConnectionKey>;
