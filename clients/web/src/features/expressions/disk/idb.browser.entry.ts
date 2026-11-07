// 실제 엔진 시험(`idb.browser.test.ts`)이 페이지에 올리는 번들의 입구. 앱의 IndexedDB 구현을 그대로 쓰고, 부를 때마다 **새 백엔드(새 연결)**를 만든다:
// 「같은 객체가 메모리에 쥐고 있어서 읽힌다」가 답이 될 수 없게 하려는 것이다.
import { indexedDbExpressionDisk } from "./idb";
import type { DiskImage } from "@momo/core/features/expressions/diskCache";

declare global {
  var __expressionDiskClock: number | undefined;
}

const backend = (limits: { budgetBytes?: number; lifetimeMs?: number } = {}) => indexedDbExpressionDisk(undefined, () => globalThis.__expressionDiskClock ?? Date.now(), limits);
const compartment = (name: string, limits?: { budgetBytes?: number; lifetimeMs?: number }) => {
  const opened = backend(limits).open(name);
  if (opened === null) throw new Error("compartment unavailable");
  return opened;
};
const image = (bytes: number[], mime: string): DiskImage => ({ bytes: Uint8Array.from(bytes).buffer, mime });

export interface ExpressionDiskApi {
  write(name: string, entryKey: string, bytes: number[], mime: string): Promise<void>;
  read(name: string, entryKey: string): Promise<{ bytes: number[]; mime: string } | null>;
  keys(name: string): Promise<string[] | null>;
  remove(name: string, keys: string[]): Promise<void>;
  removeIds(name: string, ids: string[]): Promise<void>;
  trim(name: string, limits?: { budgetBytes?: number; lifetimeMs?: number }): Promise<void>;
  destroy(name: string): Promise<void>;
  list(): Promise<string[]>;
  /** 칸 이름 장부(localStorage). */
  registry(): string[];
}

const api: ExpressionDiskApi = {
  write: (name, entryKey, bytes, mime) => compartment(name).write(entryKey, image(bytes, mime)),
  read: async (name, entryKey) => {
    const found = await compartment(name).read(entryKey);
    return found === null ? null : { bytes: Array.from(new Uint8Array(found.bytes)), mime: found.mime };
  },
  keys: (name) => compartment(name).keys(),
  remove: (name, keys) => compartment(name).remove(keys),
  removeIds: (name, ids) => compartment(name).removeIds(ids),
  trim: (name, limits) => compartment(name, limits).trim(),
  destroy: (name) => backend().destroy(name),
  list: () => backend().list(),
  registry: () => JSON.parse(localStorage.getItem("oort.expressions.disk.names.v1") ?? "[]") as string[],
};
(globalThis as unknown as { __expressionDisk: ExpressionDiskApi }).__expressionDisk = api;
