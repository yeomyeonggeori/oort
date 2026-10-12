// =============================================================================
// 온보딩 진행 상태의 영속 슬롯 (#3696).
//
// 대기 표지·S1 초안·첫 가입·첫 에이전트 대기 표지가 sessionStorage에만 있으면
// 데스크탑 앱을 끄는 순간 사라지고, S1 전에 종료한 소유자가 시드 이름
// 「momo Demo Workspace」·@demo 그대로 셸에 들어간다. 그래서 로그인한 계정이 있으면
// localStorage에 쓰되 **계정·서버 단위**로 가른다: 키 꼬리가 `workspaceId:memberId`
// 이고(다른 계정·다른 서버의 값은 보이지 않는다), 값에는 시각이 붙어 14일이 지나면
// 없는 것으로 읽는다(오래전에 버린 가입이 한참 뒤에 되살아나지 않게).
//
// 저장된 계정이 없으면(로그인 전·시험) 옛 동작 그대로 sessionStorage의 이름 그대로
// 슬롯을 쓴다. 저장소가 막혀 있으면 조용히 비는 것도 같다(표면은 동작한다).
// 정본 사실은 서버다: 이 슬롯은 「어디까지 했는가」의 힌트일 뿐이고, 시드 이름
// 재판정(`seedWorkspace.ts`)이 서버 값으로 한 번 더 확인한다.
// =============================================================================

import { getPersistedSession } from "@/lib/session";

export const DURABLE_SLOT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface Stored {
  v: string;
  at: number;
  /** 사람이 「다시 묻지 않기」로 남긴 값(#3714): TTL이 없고 로그아웃도 지우지 않는다. */
  p?: true;
}

function local(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** 지금 로그인한 계정의 꼬리. 저장된 계정이 없으면 null. */
export function durableScope(): string | null {
  const member = getPersistedSession()?.member;
  if (!member) return null;
  return `${member.workspaceId.toLowerCase()}:${member.id.toLowerCase()}`;
}

function scopedKey(slot: string, scope: string): string {
  return `${slot}@${scope}`;
}

function parse(raw: string | null): Stored | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { v, at, p } = value as Record<string, unknown>;
    if (typeof v !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null;
    return { v, at, ...(p === true ? { p: true as const } : {}) };
  } catch {
    return null;
  }
}

export function readDurable(slot: string, nowMs: number = Date.now()): string | null {
  try {
    const scope = durableScope();
    if (scope === null) return session()?.getItem(slot) ?? null;
    const store = local();
    const key = scopedKey(slot, scope);
    const stored = parse(store?.getItem(key) ?? null);
    if (stored === null) return null;
    if (stored.p !== true && nowMs - stored.at > DURABLE_SLOT_TTL_MS) {
      store?.removeItem(key);
      return null;
    }
    return stored.v;
  } catch {
    return null;
  }
}

export function writeDurable(
  slot: string,
  value: string,
  nowMs: number = Date.now(),
  options: { permanent?: boolean } = {}
): void {
  try {
    const scope = durableScope();
    if (scope === null) {
      session()?.setItem(slot, value);
      return;
    }
    local()?.setItem(
      scopedKey(slot, scope),
      JSON.stringify({ v: value, at: nowMs, ...(options.permanent ? { p: true } : {}) } satisfies Stored)
    );
  } catch {
    // 막힌 저장소: 다시 열면 이어지지 않을 뿐 표면은 동작한다.
  }
}

export function removeDurable(slot: string): void {
  try {
    const scope = durableScope();
    if (scope === null) session()?.removeItem(slot);
    else local()?.removeItem(scopedKey(slot, scope));
  } catch {
    // same as write
  }
}

/**
 * 로그아웃은 「이 기기에서 내 흔적을 지운다」다(`signOut`의 초안 정리와 같은 약속).
 * 지금 계정의 영속 슬롯을 모두 지운다. 만료로 세션이 끊긴 경우(`clearSession`)는
 * 이어가야 하므로 부르지 않는다. 세션이 지워지기 **전에** 불러야 꼬리를 안다.
 */
export function clearDurableForCurrentAccount(): void {
  try {
    const scope = durableScope();
    const store = local();
    if (scope === null || store === null) return;
    const suffix = `@${scope}`;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key.endsWith(suffix)) keys.push(key);
    }
    for (const key of keys) {
      // 사람이 남긴 「다시 묻지 않기」는 로그아웃으로 지우지 않는다(#3714).
      if (parse(store.getItem(key))?.p === true) continue;
      store.removeItem(key);
    }
  } catch {
    // same as write
  }
}
