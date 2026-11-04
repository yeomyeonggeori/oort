import { emptyExpressionUsage, recordExpressionUse, restoreExpressionUsage } from "@momo/core/features/expressions/usage";
import { tokenizeExpressions } from "@momo/core/features/expressions/message";
import { applyExpressionList, emptyExpressionCache } from "@momo/core/features/expressions/cache";
import { matchesExpressionContract } from "@momo/core/features/expressions/contracts";
import { photoModelRequest, readPhotoDraftResult, readPhotoModel, type PhotoDraftResult, type PhotoModel } from "@momo/core/features/expressions/photo";
import type { ExpressionDraft, ExpressionList, ExpressionMutation } from "@momo/core/features/expressions/types";
import type { ExpressionRequest, ExpressionTransport } from "./transport";

export class ExpressionStore {
  private disposed = false;
  private receipts = new Set<string>();
  private usageKey: string;
  private listeners = new Set<() => void>();
  private generation = 0;
  private refreshSerial = 0;
  private images = new Map<string, Promise<string>>();
  readonly base: string;
  snapshot;
  constructor(readonly workspaceId: string, readonly memberId: string, readonly transport: ExpressionTransport) {
    this.usageKey = `oort.expressions.usage:${workspaceId}:${memberId}`;
    let usage = emptyExpressionUsage(workspaceId, memberId);
    try { usage = restoreExpressionUsage(JSON.parse(localStorage.getItem(this.usageKey) ?? "null"), workspaceId, memberId); } catch { /* Storage is optional. */ }
    this.base = `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
    this.snapshot = { usage, cache: emptyExpressionCache(workspaceId, memberId), status: "loading" as "loading" | "ready" | "error", epoch: 0, offline: false };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private emit() { this.snapshot = { ...this.snapshot }; this.listeners.forEach((listener) => listener()); }
  clearImages() { this.generation++; this.images.clear(); this.snapshot.epoch++; this.emit(); }
  dispose() { this.disposed = true; this.refreshSerial++; this.clearImages(); this.snapshot.cache = emptyExpressionCache(this.workspaceId, this.memberId); this.listeners.clear(); }
  setOffline(offline: boolean) { this.snapshot.offline = offline; if (offline) this.clearImages(); else this.emit(); }
  async refresh(full = true) {
    this.disposed = false;
    const serial = ++this.refreshSerial;
    this.clearImages();
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
    } catch { if (serial === this.refreshSerial) this.snapshot.status = "error"; }
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
  image(path: string): Promise<string> {
    if (this.snapshot.offline) return Promise.reject(new Error("offline"));
    const hit = this.images.get(path);
    if (hit) return hit;
    const generation = this.generation;
    const pending = this.transport.image(path).then((src) => {
      if (generation !== this.generation) throw new Error("evicted expression");
      return src;
    }).catch((error: unknown) => { if (this.images.get(path) === pending) this.images.delete(path); throw error; });
    this.images.set(path, pending);
    // Authenticated memory cache only; bounded for large workspaces.
    while (this.images.size > 96) this.images.delete(this.images.keys().next().value!);
    return pending;
  }
}
