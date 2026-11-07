// 시험 도구: 저장소 수준 시험이 쓰는 가짜 세계(서버 목록 + 그림 바이트 + 앱 재시작을 흉내 내는 디스크). 앱 코드는 이 파일을 가져가지 않는다.
// 그림 바이트는 **실제 sha256** 을 가진다(저장소가 쓸 때·읽을 때 sha 를 대조하므로 목록의 값과 바이트가 맞아야 한다).
import { createHash } from "node:crypto";
import { vi } from "vitest";
import { FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import type { Expression, ExpressionList, ExpressionMedia, ExpressionImage as ExpressionImageMeta } from "@momo/core/features/expressions/types";
import { ExpressionStore } from "../ExpressionStore";
import { ExpressionHttpError, type ExpressionRequest, type ExpressionTransport } from "../transport";
import { createMemoryDiskBackend, type MemoryDiskBackend } from "./memory";
import { openExpressionDisk } from "./open";
import { expressionDiskName } from "./port";

export const WS = FIXTURE_WORKSPACE_ID;
export const ME = FIXTURE_MEMBER_ID;
export const OTHER_ME = "00000000-0000-4000-8000-0000000000aa";
export const OTHER_WS = "00000000-0000-4000-8000-0000000000bb";
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(1000 + n).padStart(12, "0")}`;
export const diskName = (workspace = WS, member = ME) => expressionDiskName(workspace, member)!;

export interface Pic { bytes: Uint8Array; sha: string; src: string; mime: string }
function bytesOf(seed: string, length: number): Uint8Array {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) { hash = Math.imul(hash ^ index, 16777619) >>> 0; out[index] = hash & 255; }
  return out;
}
export function pic(seed: string, length = 80, mime = "image/png"): Pic {
  const bytes = bytesOf(seed, length);
  return { bytes, sha: createHash("sha256").update(bytes).digest("hex"), src: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`, mime };
}
const metaOf = (p: Pic): ExpressionImageMeta => ({ mime: p.mime as ExpressionImageMeta["mime"], sha256: p.sha, bytes: p.bytes.length, width: 64, height: 64, frameCount: p.mime === "image/gif" ? 2 : 1, durationMs: p.mime === "image/gif" ? 200 : 0 });

type Size = "small" | "large" | "thumb";
export const SIZES: Size[] = ["small", "large", "thumb"];

/** 서버가 가진 목록과 그림. `json`·`image` 가 `ExpressionTransport` 이고, 부르는 횟수를 센다. */
export class World {
  version = 0;
  active = new Map<string, Expression>();
  hidden = new Map<string, Expression>();
  pics = new Map<string, Pic>();
  /** 그림 요청(경로) 기록. 시험이 비우며 센다. */
  imageCalls: string[] = [];
  /** 목록 읽기의 쿼리(`""` 은 `since` 없는 전체 읽기, `?since=6` 은 증분). */
  listCalls: string[] = [];
  /** 이 오류를 목록 읽기가 던진다(`null` 이면 정상). */
  failList: unknown = null;
  /** 이 오류를 그림 요청이 던진다(`null` 이면 정상, 그림 하나의 404 는 따로 숨김·없는 id 가 낸다). */
  failImage: unknown = null;
  private listGate: Promise<void> | null = null;
  private imageGate: Promise<void> | null = null;

  add(n: number, mime = "image/png", length = 80): Expression {
    this.version += 1;
    const media = Object.fromEntries(SIZES.map((size) => {
      const p = pic(`${n}:${size}:${this.version}`, length + (size === "large" ? 20 : 0), mime);
      this.pics.set(`${uuid(n)}:${size}`, p);
      return [size, metaOf(p)];
    })) as unknown as ExpressionMedia;
    const item: Expression = { ...FIXTURE_EXPRESSIONS[0], id: uuid(n), workspaceId: WS, name: `expr_${n}`, displayName: `표현 ${n}`, kind: "sticker", version: String(this.version), status: "active", media };
    this.active.set(item.id, item);
    this.hidden.delete(item.id);
    return item;
  }
  hide(n: number): void {
    const item = this.active.get(uuid(n));
    if (!item) throw new Error(`no active ${n}`);
    this.version += 1;
    this.active.delete(item.id);
    this.hidden.set(item.id, { ...item, version: String(this.version), status: "hidden", media: null });
  }
  srcOf(n: number, size: Size): string { return this.pics.get(`${uuid(n)}:${size}`)!.src; }
  shaOf(n: number, size: Size): string { return this.pics.get(`${uuid(n)}:${size}`)!.sha; }
  /** 이 표현의 그림 주소(`ExpressionStore.base` 가 앞에 붙는다). */
  pathOf(store: ExpressionStore, n: number, size: Size): string { return `${store.base}/expressions/${uuid(n)}/image?size=${size}&v=${this.shaOf(n, size)}`; }
  draftPathOf(store: ExpressionStore, size: Size = "large", draftId = "00000000-0000-4000-8000-0000000000d1"): string { return `${store.base}/expression-drafts/${draftId}/image?size=${size}&v=${"d".repeat(64)}`; }
  /** 다음 목록 읽기부터 풀어 줄 때까지 붙든다. 풀어 주는 함수를 돌려준다. */
  holdLists(): () => void { let release!: () => void; this.listGate = new Promise<void>((resolve) => { release = () => { this.listGate = null; resolve(); }; }); return release; }
  holdImages(): () => void { let release!: () => void; this.imageGate = new Promise<void>((resolve) => { release = () => { this.imageGate = null; resolve(); }; }); return release; }

  full(): ExpressionList { return { workspaceId: WS, version: String(this.version), baseVersion: null, reset: true, addPolicy: "members", items: [...this.active.values()] }; }
  delta(since: string): ExpressionList {
    const changed = [...this.active.values(), ...this.hidden.values()].filter((item) => Number(item.version) > Number(since));
    return { workspaceId: WS, version: String(this.version), baseVersion: since, reset: false, addPolicy: "members", items: changed };
  }

  json = vi.fn(async (request: ExpressionRequest): Promise<unknown> => {
    const url = new URL(request.path, "http://server.test");
    if (request.method === "GET" && /\/expressions$/.test(url.pathname)) {
      const gate = this.listGate;
      this.listCalls.push(url.search);
      if (gate) await gate;
      if (this.failList !== null) throw this.failList;
      const since = url.searchParams.get("since");
      return JSON.parse(JSON.stringify(since === null ? this.full() : this.delta(since)));
    }
    const report = /\/expressions\/([0-9a-f-]{36})\/report$/.exec(url.pathname);
    if (request.method === "POST" && report) {
      const item = this.active.get(report[1]);
      if (!item) throw new ExpressionHttpError(404, undefined);
      this.version += 1;
      this.active.delete(item.id);
      const row: Expression = { ...item, version: String(this.version), status: "hidden", media: null };
      this.hidden.set(item.id, row);
      return JSON.parse(JSON.stringify({ workspaceId: WS, version: String(this.version), expression: row }));
    }
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  });
  image = vi.fn(async (path: string): Promise<string> => {
    const gate = this.imageGate;
    this.imageCalls.push(path);
    if (gate) await gate;
    if (this.failImage !== null) throw this.failImage;
    if (path.includes("/expression-drafts/")) return pic(`draft:${path}`).src;
    const match = /\/expressions\/([0-9a-f-]{36})\/image\?size=(\w+)&v=([0-9a-f]{64})$/.exec(path);
    const found = match ? this.pics.get(`${match[1]}:${match[2]}`) : undefined;
    // 서버의 설계된 응답: 숨김·없는 id·틀린 sha 는 모두 같은 404 다.
    if (!match || !found || !this.active.has(match[1]) || found.sha !== match[3]) throw new ExpressionHttpError(404, undefined);
    return found.src;
  });
  transport(): ExpressionTransport { return { json: this.json, image: this.image }; }
  resetCounts(): void { this.imageCalls.length = 0; this.listCalls.length = 0; }
}

/** 저장소를 만든다. `backend` 를 같은 것으로 주면 그것이 「같은 디스크로 다시 켠 앱」이다. */
export function boot(world: World, backend: MemoryDiskBackend, member = ME, workspace = WS): ExpressionStore {
  const disk = openExpressionDisk(workspace, member, backend);
  if (disk === null) throw new Error("the disk compartment should open in tests");
  return new ExpressionStore(workspace, member, world.transport(), undefined, disk);
}
export { createMemoryDiskBackend };
