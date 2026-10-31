import {DEFAULT_UNFURL_SIZE, type UnfurlSize} from '@momo/core/features/timeline/unfurl';
import {useSyncExternalStore} from 'react';

import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';

// =============================================================================
// 「링크 미리보기」 — 이 폰의 선택 (#4883, owner 2026-10-31).
//
// 웹(`clients/web/src/features/timeline/linkPreviewPreference.ts`)과 **같은 값 이름·같은 기본값**이다.
// 값은 코어의 `UnfurlSize` 세 낱말(`compact` 작게 · `rich` 크게 · `off` 끄기)이고, 기본은 코어의
// `DEFAULT_UNFURL_SIZE` 한 곳이다 — 폰이 따로 기본을 쥐지 않는다. 화면의 낱말(작게·크게·끄기)은
// 사전 키 `settings.appearance.linkPreview*` 를 웹과 같이 쓴다.
//
// 저장은 이 폰의 비밀 아닌 저장소(MMKV, `NON_SECRET_KEYS.linkPreview`)다. 동기로 읽히므로 첫 프레임에
// 카드가 기본 모양으로 그려졌다 뒤집히지 않는다. 모르는 값(옛 판·손상)은 기본으로 읽고 되쓰지 않는다 —
// 읽기가 쓰기를 부르지 않으니 두 판이 서로 덮는 일이 없다.
// =============================================================================

/**
 * 세 낱말은 **키**로만 적는다. 값 이름을 문자열 리터럴로 되풀이하지 않고(직접 문구 장부는 낱말 하나짜리 리터럴도 세므로),
 * `satisfies Record<UnfurlSize, true>` 가 코어에 네 번째 크기가 생기면 컴파일을 멈춘다 — 화면의 선택지와 저장 값 검사가 코어
 * 타입과 갈라질 수 없다.
 */
const CHOICES = {compact: true, rich: true, off: true} as const satisfies Record<UnfurlSize, true>;

/** 화면 순서(작게 · 크게 · 끄기) — 기본값이 앞에 온다. */
export const LINK_PREVIEW_CHOICES = Object.keys(CHOICES) as readonly UnfurlSize[];

export function isLinkPreviewChoice(value: string | null | undefined): value is UnfurlSize {
  return value != null && Object.hasOwn(CHOICES, value);
}

export function linkPreviewPreference(): UnfurlSize {
  const stored = nonSecretStore().getString(NON_SECRET_KEYS.linkPreview);
  return isLinkPreviewChoice(stored) ? stored : DEFAULT_UNFURL_SIZE;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 고른 값을 적는다. **같은 값이어도 쓴다**: 기본을 직접 고른 사람의 선택은 저장돼야, 나중에 기본이 바뀌어도
 * 이 기기가 따라 움직이지 않는다(웹 `setLinkPreviewPreference` 와 같은 이유). 구독자는 값이 바뀔 때만 깨운다.
 */
export function setLinkPreviewPreference(next: UnfurlSize): void {
  if (!isLinkPreviewChoice(next)) return;
  const changed = next !== linkPreviewPreference();
  nonSecretStore().set(NON_SECRET_KEYS.linkPreview, next);
  if (changed) listeners.forEach(listener => listener());
}

export function useLinkPreviewPreference(): UnfurlSize {
  return useSyncExternalStore(subscribe, linkPreviewPreference, linkPreviewPreference);
}
