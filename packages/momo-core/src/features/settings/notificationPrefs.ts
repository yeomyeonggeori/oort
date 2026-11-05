// =============================================================================
// 알림 설정 v2 - 「데스크탑을 쓰는 동안 폰 알림 늦추기」 한 칸 (ADR-0206 D4·D13, #4508 N12).
//
// Wire contract: docs/api/openapi.yaml `notification-prefs` (GET/PATCH),
// server-rust/crates/momo-messaging/src/notification_prefs.rs.
//
// 서버의 `notification-prefs` 는 종류×표면·표현·근무 시간·지연·관통 스위치를 한 객체로 들고
// 있다(#4494). 이 파일이 읽고 쓰는 것은 그중 `phoneDelaySecs` 하나다: 다른 필드는 그 칸을 만드는
// 슬라이스(N4 #4503 등)가 이 파일을 넓히거나 자기 파일을 둔다. 쓰기는 **PATCH 로 이 필드만** 싣는다:
// 서버가 행 잠금 아래에서 합치므로 다른 기기가 방금 바꾼 다른 칸을 지우지 않는다(`notificationRules`
// 의 #3042 와 같은 이유).
//
// 읽기는 방어적이다: 이 라우트는 새것이라 중간 서버가 다른 모양의 200 을 줄 수 있다. 모르는 값은
// 서버의 「저장된 행 없음」과 같은 60초다. 옛 서버(라우트 없음)는 404·405 이고, 화면은 그때 칸을 숨긴다
// (수용 기준 38).
// =============================================================================

import { ApiError } from "../../lib/api";
import { num, record } from "../../lib/wire";
import { settingsRequest } from "./api";

/** 서버가 받는 값의 닫힌 집합이다(그 밖은 400 `invalid_phone_delay`). 300초가 상한이다. */
export const PHONE_DELAY_OPTIONS = [0, 60, 300] as const;
export type PhoneDelaySecs = (typeof PHONE_DELAY_OPTIONS)[number];

/** 저장된 값이 없을 때 서버가 읽는 값(ADR-0206 D4: 기본 1분). 0 은 「늦추지 않음」이다. */
export const DEFAULT_PHONE_DELAY_SECS: PhoneDelaySecs = 60;

export function phoneDelayFromWire(value: unknown): PhoneDelaySecs {
  const secs = num(record(value) ?? {}, "phoneDelaySecs");
  return PHONE_DELAY_OPTIONS.find((option) => option === secs) ?? DEFAULT_PHONE_DELAY_SECS;
}

function prefsPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/notification-prefs`;
}

export function fetchPhoneDelay(workspaceId: string): Promise<PhoneDelaySecs> {
  return settingsRequest<unknown>(prefsPath(workspaceId)).then(phoneDelayFromWire);
}

/** 이 칸만 바꾼다. 서버의 답(저장된 값)을 돌려준다. */
export function savePhoneDelay(
  workspaceId: string,
  secs: PhoneDelaySecs
): Promise<PhoneDelaySecs> {
  return settingsRequest<unknown>(prefsPath(workspaceId), {
    method: "PATCH",
    body: JSON.stringify({ phoneDelaySecs: secs }),
  }).then(phoneDelayFromWire);
}

/**
 * 이 서버에는 알림 설정 v2 가 없다(옛 서버): 라우트가 없다(404) 또는 메서드가 없다(405).
 * 이 서버에는 다시 묻지도 않고 칸도 그리지 않는다.
 */
export function isNotificationPrefsUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 405);
}

/**
 * 읽기가 이 대답이면 칸을 **숨긴다**(고칠 수 있는 실패가 아니라 열 수 없는 칸이다): 옛 서버(404·405)와,
 * 이 계정에 닫힌 설정(403: 에이전트 계정이거나 멤버가 아니다 - 규칙 카드가 같은 사실을 이미 말한다).
 * 네트워크 실패나 5xx 는 숨김이 아니라 다시 시도할 수 있는 실패다.
 */
export function hidesPhoneDelayRow(error: unknown): boolean {
  return (
    isNotificationPrefsUnavailable(error) ||
    (error instanceof ApiError && error.status === 403)
  );
}
