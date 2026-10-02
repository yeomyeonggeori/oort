import type { ShareRefusal } from "./paneShare";

// 「채널에 공유」의 문구(#2867). 해요체. 「응답 필요」 어휘는 칸 상태 쪽 것을 그대로 쓰고 여기서
// 다시 정하지 않는다. 「팀은 이름·상태·worktree만 봅니다」는 제안서 §6과 ADR-0190 D4-b Q5의 문장이다.

export const SHARE_COPY = {
  menuLabel: "공유",
  menuShare: "채널에 공유",
  menuCopyLink: "링크 복사",
  menuUnshare: "공유 끄기",
  menuBusy: "공유를 바꾸는 중이에요",
  chipOn: (channel: string | null) => (channel ? `공유 중 · #${channel}` : "공유 중"),
  chipSyncFailed: "공유 중 · 요약을 못 보냈어요",

  shareTitle: "채널에 공유",
  shareLead: "이 칸을 고른 채널의 작업 카드로 올려요. 팀은 이름·상태·worktree만 봅니다.",
  copyTitle: "이 세션을 공유할까요?",
  copyLead: "팀은 이름·상태·worktree만 봅니다. 링크는 공유된 세션에만 있어서, 공유를 켜야 복사할 수 있어요.",
  never: "터미널 내용과 커밋 제목은 올라가지 않아요. 공유는 언제든 끌 수 있어요.",
  pickerLegend: "공유할 채널",
  pickerLast: "이 저장소로 마지막에 공유한 채널",
  pickerFirst: "처음이라면 직접 골라 주세요. 워크스페이스 전체 공개는 없어요.",
  lockedHome: (channel: string) =>
    `이 세션의 집 채널은 #${channel}이에요. 한 번 정하면 바꿀 수 없어요. 다른 채널에는 링크를 붙여 알려 주세요.`,
  channelPublic: "공개 채널",
  channelPrivate: "비공개 채널",
  noChannels: "공유할 수 있는 채널이 없어요. 채널에 먼저 들어가 주세요.",
  preparing: "이 칸을 확인하는 중이에요",
  submitShare: "채널에 공유",
  submitCopy: "공유하고 링크 복사",
  submitting: "공유하는 중이에요",
  cancel: "취소",
  linkCopied: "링크를 복사했어요",
  linkNote: "팀 작업 보드 주소예요. oort:// 링크는 곧 붙어요.",
  copyFailed: "링크를 복사하지 못했어요. 팀 작업 보드에서 직접 열어 주세요.",
  unshared: "공유를 껐어요. 팀 보드에서 이 세션이 사라져요",
  unshareFailed: "공유를 끄지 못했어요. 아직 공유 중이에요. 다시 시도해 주세요",
  shared: (channel: string | null) => (channel ? `#${channel}에 공유했어요` : "공유했어요"),

  hostGo: "이 맥 등록하러 가기",
  hostNotRegistered:
    "공유하려면 이 맥을 작업 호스트로 먼저 등록해야 해요. 설정의 「이 맥」에서 등록할 수 있어요.",
  hostNotRunning:
    "이 맥의 작업 호스트가 꺼져 있어요. 설정의 「이 맥」에서 켠 뒤 다시 시도해 주세요.",
  hostElsewhere:
    "이 맥은 다른 워크스페이스나 서버에 등록돼 있어요. 설정의 「이 맥」에서 이 워크스페이스로 다시 등록해 주세요.",
  hostNoShell: "공유는 데스크탑 앱에서만 할 수 있어요.",
} as const;

export function refusalLine(reason: ShareRefusal): string {
  switch (reason) {
    case "host_not_registered":
      return SHARE_COPY.hostNotRegistered;
    case "host_not_running":
      return SHARE_COPY.hostNotRunning;
    case "host_elsewhere":
      return SHARE_COPY.hostElsewhere;
    case "no_shell":
      return SHARE_COPY.hostNoShell;
    case "channel_forbidden":
      return "이 채널에는 글을 쓸 수 없어요. 다른 채널을 골라 주세요.";
    case "limit":
      return "공유 중인 칸이 너무 많아요. 다른 칸의 공유를 끄고 다시 시도해 주세요.";
    case "offline":
      return "서버에 닿지 못했어요. 연결을 확인하고 다시 시도해 주세요.";
    case "no_pane":
      return "이 칸이 이미 닫혔어요.";
    default:
      return "공유하지 못했어요. 잠시 뒤 다시 시도해 주세요.";
  }
}
