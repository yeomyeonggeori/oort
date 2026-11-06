import { recordExpressionUse, restoreExpressionUsage } from "@momo/core/features/expressions/usage";
import { restoreExpressionFavorites, toggleExpressionFavorite } from "@momo/core/features/expressions/favorites";
import { tokenizeExpressions } from "@momo/core/features/expressions/message";
import { applyExpressionList, emptyExpressionCache } from "@momo/core/features/expressions/cache";
import { matchesExpressionContract } from "@momo/core/features/expressions/contracts";
import { photoModelRequest, readPhotoDraftResult, readPhotoModel, type PhotoDraftResult, type PhotoModel } from "@momo/core/features/expressions/photo";
import type { ExpressionDraft, ExpressionList, ExpressionMutation } from "@momo/core/features/expressions/types";
import type { ExpressionRequest, ExpressionTransport } from "./transport";
import { ImageCache, type ImageCacheLimits } from "./ImageCache";

/** 이 기기에 저장된 JSON 값. 저장소가 없거나 값이 깨졌으면 null이다(복원 함수가 빈 값으로 바꾼다 - 저장소는 선택 사항이다). */
function storedJson(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
}

export class ExpressionStore {
  private disposed = false;
  private receipts = new Set<string>();
  private usageKey: string;
  private favoritesKey: string;
  private listeners = new Set<() => void>();
  private generation = 0;
  private refreshSerial = 0;
  /** 인증된 그림의 메모리 캐시: 바이트 예산 LRU(#5468). 로그아웃·워크스페이스 전환·숨김·삭제·오프라인은 아래 `clearImages` 가 통째로 비운다. */
  private images: ImageCache;
  readonly base: string;
  snapshot;
  constructor(readonly workspaceId: string, readonly memberId: string, readonly transport: ExpressionTransport, imageLimits?: ImageCacheLimits) {
    this.images = new ImageCache(imageLimits);
    this.usageKey = `oort.expressions.usage:${workspaceId}:${memberId}`;
    // 즐겨찾기도 사용 기록과 같은 자리 규칙이다: 이 기기 · 이 워크스페이스 · 이 사람. 서버로 가지 않는다(owner 2026-11-07, #5453).
    this.favoritesKey = `oort.expressions.favorites:${workspaceId}:${memberId}`;
    const usage = restoreExpressionUsage(storedJson(this.usageKey), workspaceId, memberId);
    const favorites = restoreExpressionFavorites(storedJson(this.favoritesKey), workspaceId, memberId);
    this.base = `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
    this.snapshot = { usage, favorites, cache: emptyExpressionCache(workspaceId, memberId), status: "loading" as "loading" | "ready" | "error", epoch: 0, offline: false, failure: null as unknown };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private emit() { this.snapshot = { ...this.snapshot }; this.listeners.forEach((listener) => listener()); }
  clearImages() { this.generation++; this.images.clear(); this.snapshot.epoch++; this.emit(); }
  dispose() { this.disposed = true; this.refreshSerial++; this.clearImages(); this.snapshot.cache = emptyExpressionCache(this.workspaceId, this.memberId); this.listeners.clear(); }
  setOffline(offline: boolean) { this.snapshot.offline = offline; if (offline) this.clearImages(); else this.emit(); }
  /**
   * 목록을 읽는다. **그림은 목록이 실제로 바뀐 만큼만 걷는다**(#5330): 앞 판은 읽기를 시작할 때마다 그림을 전부 걷어서(`clearImages`) 창 초점이 돌아올 때와
   * 30초마다 보이는 그림이 모두 다시 내려받아졌다(깜빡임). 지금은 답이 와서 목록을 바꿔 끼울 때 코어 `applyExpressionList` 가 돌려주는 `evictImageIds`
   * (지워지거나 그림이 바뀐 등록)가 있을 때만 걷는다. 숨김·삭제를 **즉시** 걷는 길은 그대로다: 실시간 변경 알림(`ExpressionsProvider`)·`mutate`·오프라인·
   * 오류가 각자 `clearImages` 를 부른다. 읽는 동안에도 `status` 는 `ready` 그대로라 이미 읽은 목록이 서 있다(스켈레톤은 맨 처음 읽을 때만).
   */
  async refresh(full = true) {
    this.disposed = false;
    const serial = ++this.refreshSerial;
    try {
      const since = !full && this.snapshot.cache.version !== null ? `?since=${this.snapshot.cache.version}` : "";
      const value = await this.transport.json({ method: "GET", path: `${this.base}/expressions${since}` });
      if (serial !== this.refreshSerial) return;
      if (!matchesExpressionContract("List", value)) throw new Error("expression list");
      const next = applyExpressionList(this.snapshot.cache, value as ExpressionList);
      if (next.needsFullRefresh && !full) { await this.refresh(); return; }
      if (!next.applied && !next.needsFullRefresh) return;
      if (!next.applied) throw new Error("expression snapshot");
      this.snapshot.cache = next.cache;
      this.snapshot.status = "ready";
      this.snapshot.failure = null;
      if (next.evictImageIds.length > 0) this.clearImages();
    } catch (error) {
      // 오류 객체를 버리지 않는다(#5279 C): 화면이 이 실패가 연결 쪽인지(오프라인 / 서버에 닿지 못함)를 말하려면 객체가 있어야 한다.
      if (serial === this.refreshSerial) { this.snapshot.status = "error"; this.snapshot.failure = error; this.clearImages(); }
    }
    if (serial === this.refreshSerial) this.emit();
  }
  async draft(request: ExpressionRequest): Promise<ExpressionDraft> {
    const value = await this.transport.json(request);
    if (!matchesExpressionContract("Draft", value) || (value as ExpressionDraft).workspaceId !== this.workspaceId) throw new Error("expression draft");
    return value as ExpressionDraft;
  }
  /** 팀에 이미지 모델이 연결돼 있는가, 있다면 사진이 어느 회사로 가는가(ADR-0218 §8 H9). */
  async photoModel(): Promise<PhotoModel> {
    const model = readPhotoModel(await this.transport.json(photoModelRequest(this.base)));
    if (!model) throw new Error("expression photo model");
    return model;
  }
  /** 사진 한 장으로 만든 초안과 서버가 배경에 한 일. */
  async photoDraft(request: ExpressionRequest): Promise<PhotoDraftResult> {
    const result = readPhotoDraftResult(await this.transport.json(request), this.workspaceId);
    if (!result) throw new Error("expression photo draft");
    return result;
  }
  async mutate(request: ExpressionRequest): Promise<ExpressionMutation> {
    const value = await this.transport.json(request);
    if (!matchesExpressionContract("Mutation", value) || (value as ExpressionMutation).workspaceId !== this.workspaceId) throw new Error("expression mutation");
    const result = value as ExpressionMutation;
    const prior = this.snapshot.cache;
    const next = applyExpressionList(prior, { workspaceId: this.workspaceId, version: result.version, baseVersion: prior.version, reset: false, addPolicy: prior.addPolicy, items: [result.expression] });
    // Remove all visible bytes before publishing a hide/delete, including pending reads.
    this.clearImages();
    if (next.applied) { this.snapshot.cache = next.cache; this.emit(); }
    else await this.refresh();
    return result;
  }
  recordSuccess(body: string, receipt: string) {
    if (this.disposed || this.receipts.has(receipt)) return;
    const ids = new Set(tokenizeExpressions(body, this.snapshot.cache.items).flatMap((token) => token.type === "expression" ? [token.expression.id] : []));
    if (!ids.size) return;
    this.receipts.add(receipt);
    while (this.receipts.size > 2000) this.receipts.delete(this.receipts.values().next().value!);
    for (const id of ids) this.snapshot.usage = recordExpressionUse(this.snapshot.usage, id, Date.now());
    try { localStorage.setItem(this.usageKey, JSON.stringify(this.snapshot.usage)); } catch { /* Storage is optional. */ }
    this.emit();
  }
  /** 쥐고 있는 그림 수·바이트(시험·진단용). */
  imageCacheStats() { return this.images.stats(); }
  /** 즐겨찾기를 켜고 끈다(있으면 빼고 없으면 더한다). 이 기기에만 저장한다. */
  toggleFavorite(id: string) {
    if (this.disposed) return;
    this.snapshot.favorites = toggleExpressionFavorite(this.snapshot.favorites, id);
    try { localStorage.setItem(this.favoritesKey, JSON.stringify(this.snapshot.favorites)); } catch { /* Storage is optional. */ }
    this.emit();
  }
  image(path: string): Promise<string> {
    if (this.snapshot.offline) return Promise.reject(new Error("offline"));
    const hit = this.images.get(path);
    if (hit) return hit;
    const generation = this.generation;
    // 메모리 캐시만(ADR-0218 D3): 총량은 `ImageCache` 가 바이트 예산 LRU 로 묶는다.
    return this.images.add(path, this.transport.image(path).then((src) => {
      if (generation !== this.generation) throw new Error("evicted expression");
      return src;
    }));
  }
}
