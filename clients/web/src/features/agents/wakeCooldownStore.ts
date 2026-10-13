import { useSyncExternalStore } from "react";

// 「다시 깨우기」 쿨다운(연결당 60초, 시간당 5회 — 서버가 센다). 서버가 준 때를 이
// 세션 안에서 기억할 뿐이다: 라벨을 닫았다 열어도(패널·행이 다시 마운트돼도) 같은 연결의
// 쿨다운이 이어지게. 서버의 한도를 대신 집행하지는 않는다(서버가 429로 다시 말해 준다).

let until: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

function emit(next: ReadonlyMap<string, number>): void {
  until = next;
  for (const listener of listeners) listener();
}

/** 이 연결을 다시 깨울 수 있게 되는 시각(이 기기의 시계). */
export function setWakeCooldown(connectionId: string, untilMs: number): void {
  const key = connectionId.toLowerCase();
  if (until.get(key) === untilMs) return;
  const next = new Map(until);
  next.set(key, untilMs);
  emit(next);
}

export function resetWakeCooldowns(): void {
  if (until.size > 0) emit(new Map());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = (): ReadonlyMap<string, number> => until;

export function wakeCooldownUntil(connectionId: string): number | undefined {
  return until.get(connectionId.toLowerCase());
}

export function useWakeCooldownUntil(connectionId: string | null): number | undefined {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  return connectionId === null ? undefined : all.get(connectionId.toLowerCase());
}
