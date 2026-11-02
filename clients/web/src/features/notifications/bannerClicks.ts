import { CLICKABLE_OUTCOME, readNotificationClick } from "@momo/core/features/notifications/bannerClick";
import {
  notificationClickSupported,
  showClickableNotification,
  showNotification,
} from "@/lib/tauri";

// =============================================================================
// 데스크탑 배너의 클릭을 진짜 클릭으로 받는 길 (#5059, #4667 후속).
//
// 지금까지 웹은 어느 배너가 눌렸는지 몰랐다. 배너를 띄울 때 목적지를 무장하고(`armOpen`) 창이 앞에 오는 순간 그리로
// 갔다 — 배너를 무시하고 20초 안에 앱으로 돌아와도 같은 곳으로 갔다(잘못 이동). 셸이 배너의 핸들을 쥐고 클릭 때
// `momo:notification-click` 을 쏘게 된 뒤로는(`clients/desktop/src-tauri/src/notification_click.rs`) 이 모듈이 두 일을 한다.
//
//   1. 배너마다 id 를 만들고 「이 id 는 이 목적지」를 장부에 먼저 적은 뒤 셸에 보낸다(`showDesktopBanner`).
//   2. 클릭 이벤트가 오면 장부와 대조해 **앱이 만든 배너의 목적지**만 돌려준다(`claimBanner`).
//
// 이벤트 페이로드를 그대로 라우트로 쓰지 않는다. 장부에 없는 id, id 는 아는데 목적지가 다른 페이로드, 이미 쓴 id 는
// 모두 버려진다. 이동할 곳은 늘 **장부에 적어 둔 값**이다.
//
// 셸이 클릭을 알려 주지 못하는 때(다른 OS, 옛 셸, 동시에 기다리는 배너가 한도를 넘어 일반 배너로 뜬 것)에만 옛 어림이 남는다:
// 그때는 호출한 쪽(`DesktopNotifications`)이 등록한 처리기가 그 배너의 어림 재료(`BannerArm`)로 목적지를 무장한다.
// =============================================================================

/**
 * 옛 어림(`armOpen`)이 쓰는 한 알림의 재료. 알림을 만드는 쪽이 만들어 배너에 실어 두고, 셸이 그 배너의 클릭을 알려 주지
 * 못한다고 답했을 때만 쓰인다.
 */
export interface BannerArm {
  channelId: string;
  /** 카드로 착지해야 하는 알림(승인·스레드 답글)만 있다. */
  messageId?: string;
  /** 같은 스레드의 답글끼리 묶이는 규칙에 쓰는 스레드 루트(스레드 답글만). */
  threadRoot?: string;
  /** 이벤트가 가진 루트(승인 카드가 스레드 안에 있을 때 주소에 `&thread=` 를 붙이는 데 쓴다). */
  eventRootId?: string;
}

/** 데스크탑 배너 하나가 알려 주는 것: 눌렀을 때 갈 곳과, 클릭이 안 오는 때를 위한 어림 재료. */
export interface DesktopBannerTarget {
  route?: string;
  arms?: readonly BannerArm[];
}

/**
 * 장부에 남기는 배너 수의 상한. 셸이 한꺼번에 기다리는 배너(`MAX_PENDING_CLICKS`, 8)보다 훨씬 넉넉하다 — 기다림이 끝난
 * 배너(닫음·사라짐)는 셸이 웹에 알리지 않으므로 오래된 것부터 밀려나게 둔다.
 */
export const SHOWN_BANNER_CAP = 64;

/** id → 그 배너가 열 곳. 삽입 순서가 곧 나이다. */
const shown = new Map<string, string>();

/** 이 페이지 수명의 표식. 페이지가 다시 열려도 셸에 남은 옛 id 와 새 id 가 겹치지 않는다. */
const nonce = Math.random().toString(36).slice(2, 10);
let counter = 0;

/** 배너 하나의 id 를 만들고 목적지를 장부에 적는다. 셸에 보내기 **전에** 불러야 한다(클릭이 응답보다 먼저 올 수 있다). */
export function recordBanner(route: string): string {
  counter += 1;
  const id = `n-${nonce}-${counter}`;
  shown.set(id, route);
  while (shown.size > SHOWN_BANNER_CAP) {
    const oldest = shown.keys().next();
    if (oldest.done) break;
    shown.delete(oldest.value);
  }
  return id;
}

/** 클릭이 오지 않을 배너(일반 배너로 떴거나 뜨지 않았다)의 줄을 지운다. */
export function forgetBanner(id: string): void {
  shown.delete(id);
}

/** 장부를 비운다. 로그아웃으로 이 화면이 내려갈 때: 앞 사람의 대화 주소가 다음 사람에게 남지 않게. */
export function clearBanners(): void {
  shown.clear();
}

/**
 * 셸이 알려 온 클릭을 장부와 대조한다. 앱이 만든 배너의 목적지면 그 값을 돌려주고 줄을 지운다(한 번만). 아니면 `null`.
 * 인자는 IPC 경계를 넘어온 값이라 모양부터 확인한다.
 */
export function claimBanner(click: unknown): string | null {
  const read = readNotificationClick(click);
  if (read === null) return null;
  const route = shown.get(read.id);
  // 목적지까지 같아야 한다. 어긋난 페이로드는 진짜 클릭이 아니므로 줄도 지우지 않는다(진짜 클릭이 뒤따를 수 있다).
  if (route === undefined || route !== read.target) return null;
  shown.delete(read.id);
  return route;
}

type PlainBannerHandler = (arms: readonly BannerArm[]) => void;
let onPlainBanner: PlainBannerHandler | null = null;

/**
 * 셸이 「떴지만 클릭은 못 알린다」고 답한 배너를 위한 처리기. `DesktopNotifications` 가 등록해 그 배너의 어림 재료로
 * 옛 어림을 무장한다. 등록자가 없으면(로그아웃 뒤) 아무 일도 없다.
 */
export function setPlainBannerHandler(handler: PlainBannerHandler | null): void {
  onPlainBanner = handler;
}

/**
 * 데스크탑 배너 하나를 보낸다. 셸이 클릭을 알려 주고 갈 곳이 있는 배너는 클릭 가능한 길로, 그 밖에는 예전 그대로 보낸다.
 * 뜬 배너에 대해 참을 돌려준다(`showNotification` 과 같은 뜻).
 */
export async function showDesktopBanner(
  title: string,
  body: string | undefined,
  target: DesktopBannerTarget
): Promise<boolean> {
  const route = target.route;
  if (route === undefined || !(await notificationClickSupported())) return showNotification(title, body);

  const id = recordBanner(route);
  const outcome = await showClickableNotification(title, body, { id, target: route });
  if (outcome === CLICKABLE_OUTCOME.clickable) return true;

  // 클릭이 올 일이 없다: 장부에서 지운다.
  forgetBanner(id);
  // 떴지만 클릭을 못 알리는 배너(한도 초과 등)는 어림이 마지막 길이다. 뜨지 않은 배너(거절)는 어림도 필요 없다.
  const shownPlain = outcome === CLICKABLE_OUTCOME.plain;
  if (shownPlain) onPlainBanner?.(target.arms ?? []);
  return shownPlain;
}

/** 시험 전용: 모듈 상태를 처음으로. */
export function resetBannerClicksForTest(): void {
  shown.clear();
  counter = 0;
  onPlainBanner = null;
}
