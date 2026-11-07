import { recordExpressionUse, restoreExpressionUsage } from "@momo/core/features/expressions/usage";
import { restoreExpressionFavorites, toggleExpressionFavorite } from "@momo/core/features/expressions/favorites";
import { tokenizeExpressions } from "@momo/core/features/expressions/message";
import { loopForeverDataUrl } from "@momo/core/features/expressions/gifLoop";
import { applyExpressionList, compareExpressionVersions, emptyExpressionCache, isNextExpressionVersion } from "@momo/core/features/expressions/cache";
import { matchesExpressionContract } from "@momo/core/features/expressions/contracts";
import { photoModelRequest, readPhotoDraftResult, readPhotoModel, type PhotoDraftResult, type PhotoModel } from "@momo/core/features/expressions/photo";
import type { ExpressionDraft, ExpressionList, ExpressionMutation, ExpressionVersion } from "@momo/core/features/expressions/types";
import type { ExpressionRequest, ExpressionTransport } from "./transport";
import { ImageCache, type ImageCacheLimits } from "./ImageCache";
import { expressionIdOfImagePath } from "./media";
import { bytesToDataUrl, parseImageDataUrl, sha256Hex } from "./disk/bytes";
import type { ExpressionDisk } from "./disk/open";
import { activeDiskKeys, isListedDiskTarget, listedDiskTarget, parseExpressionImagePath, type DiskImage, type ListedDiskTarget } from "@momo/core/features/expressions/diskCache";

/** 이 기기에 저장된 JSON 값. 저장소가 없거나 값이 깨졌으면 null이다(복원 함수가 빈 값으로 바꾼다 - 저장소는 선택 사항이다). */
function storedJson(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
}

/** 목록 읽기가 401·403·404로 끝났다: 로그인이 끝났거나 멤버에서 빠졌거나 워크스페이스가 없다. 그림 하나의 404(숨김·틀린 sha에 대한 설계된 응답)는 이것이 아니다. */
function listReadRefused(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403 || status === 404;
}
const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** 확인된 알림 version을 기억하는 수(같은 version의 늦은 프레임이 문을 다시 닫지 않게 한다). */
const CONFIRMED_NOTICE_MEMORY = 64;
/** 디스크에 쓴 횟수가 이 수의 배수일 때마다(그리고 첫 쓰기에) 수명·바이트 상한 청소를 한다. */
const TRIM_EVERY_WRITES = 32;

/** 목록을 읽어 적용한 뒤의 상태 이름(직접 문구 장부가 센 리터럴을 늘리지 않으려고 한 번만 적는다). */
const READY = "ready" as const;

export class ExpressionStore {
  private disposed = false;
  private receipts = new Set<string>();
  private usageKey: string;
  private favoritesKey: string;
  private listeners = new Set<() => void>();
  private generation = 0;
  private refreshSerial = 0;
  /** 표현 id 별 걷기 횟수. 숨김·삭제 상세가 그 id 의 그림만 걷을 때(`evictImages`) 오른다: 그 칸은 새 세대가 되고 그 id 의 받는 중 읽기는 버려진다(다른 그림은 그대로). */
  private revoked = new Map<string, number>();
  /** 인증된 그림의 메모리 캐시: 바이트 예산 LRU(#5468). 로그아웃·워크스페이스 전환·숨김·삭제·오프라인은 아래 `clearImages` 가 통째로 비운다. */
  private images: ImageCache;
  // ---- 이모티콘 그림의 기기 캐시(ADR-0218 §14, #5455 B-1). 읽기 문·쓰기 문·대조 청소는 **모두 이 저장소 한 곳**에 있다(화면 부품은 모른다). `disk` 가 없으면(`null`)
  // 아래는 아무 일도 하지 않고 저장소는 예전처럼 메모리만 쓴다.
  private disk: ExpressionDisk | null;
  /** 아직 확인되지 않은 알림: version → 기록한 순번. 그 알림의 version 을 **담은 읽기**가 올 때까지 읽기 문은 닫혀 있다(M2.4-1 4번, R2-M1). */
  private pendingNotices = new Map<string, number>();
  /** 최근에 확인된 알림 version(늦게 온 같은 version 의 프레임이 문을 다시 닫지 않게 한다). */
  private confirmedNotices = new Set<string>();
  private noticeSerial = 0;
  /** 재연결·오프라인 복귀의 횟수와 그중 전체 목록 읽기가 확인한 횟수. 재연결은 version 이 없으므로 **전체 목록**만 문을 연다. */
  private reconnectSerial = 0;
  private reconnectConfirmed = 0;
  /** 이 저장소의 첫 구독을 이미 봤는가: 첫 구독은 재연결이 아니다(`reconnected`). */
  private subscribedOnce = false;
  /** 디스크 쓰기가 한 번 실패하면 이 세션은 쓰기를 쉰다(재시도 폭주 방지). */
  private writesPaused = false;
  private writesSinceTrim = 0;
  private diskTasks = new Set<Promise<void>>();
  private reconcileChain: Promise<void> = Promise.resolve();
  readonly base: string;
  snapshot;
  constructor(readonly workspaceId: string, readonly memberId: string, readonly transport: ExpressionTransport, imageLimits?: ImageCacheLimits, disk: ExpressionDisk | null = null) {
    this.images = new ImageCache(imageLimits);
    this.disk = disk;
    this.usageKey = `oort.expressions.usage:${workspaceId}:${memberId}`;
    // 즐겨찾기도 사용 기록과 같은 자리 규칙이다: 이 기기 · 이 워크스페이스 · 이 사람. 서버로 가지 않는다(owner 2026-11-07, #5453).
    this.favoritesKey = `oort.expressions.favorites:${workspaceId}:${memberId}`;
    const usage = restoreExpressionUsage(storedJson(this.usageKey), workspaceId, memberId);
    const favorites = restoreExpressionFavorites(storedJson(this.favoritesKey), workspaceId, memberId);
    this.base = `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
    this.snapshot = { usage, favorites, cache: emptyExpressionCache(workspaceId, memberId), status: "loading" as "loading" | "ready" | "error", epoch: 0, revoked: this.revoked as ReadonlyMap<string, number>, offline: false, failure: null as unknown };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private emit() { this.snapshot = { ...this.snapshot }; this.listeners.forEach((listener) => listener()); }
  clearImages() { this.generation++; this.images.clear(); this.snapshot.epoch++; this.emit(); }
  /**
   * 이 id 들의 그림만 걷는다(숨김·삭제 상세, ADR-0218 §15): 메모리 그림·받는 중 읽기·보관함 항목. 다른 그림은 그대로이고 그 칸들은 다시 그려지지 않는다.
   * 이 알림보다 앞서 시작한 목록 읽기의 답은 버린다(낡은 목록이 숨긴 등록을 되살리지 못한다). 목록은 부르는 쪽이 새로 읽는다.
   */
  evictImages(ids: readonly string[]) {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    this.refreshSerial++;
    for (const id of gone) this.revoked.set(id, (this.revoked.get(id) ?? 0) + 1);
    this.images.removeWhere((path) => { const id = expressionIdOfImagePath(path); return id !== null && gone.has(id); });
    // id 를 이름으로 알려 주는 알림만 그 id 의 디스크 항목을 지운다(ADR §14 M2.4-2·M2.4-3). 이름 없는 알림은 디스크를 지우지 않는다.
    if (this.disk !== null) this.trackDisk(this.disk.compartment.removeIds([...gone]));
    const cache = this.snapshot.cache;
    this.snapshot.cache = { ...cache, items: cache.items.filter((item) => !gone.has(item.id)) };
    this.emit();
  }
  /** 이 저장소를 놓는다(계정·워크스페이스 전환, 세션 끝). **앞 보관 칸을 통째로 지운다**(M2.5: 앞 칸을 남기지 않는 보수적 선택). */
  dispose() {
    this.disposed = true; this.refreshSerial++; this.clearImages(); this.snapshot.cache = emptyExpressionCache(this.workspaceId, this.memberId); this.listeners.clear();
    if (this.disk !== null) this.trackDisk(this.disk.compartment.destroy());
  }
  setOffline(offline: boolean) {
    this.snapshot.offline = offline;
    // 오프라인 동안 알림을 못 받았을 수 있다: 복귀 뒤에는 **전체 목록**이 적용돼야 읽기 문이 열린다. 디스크는 지우지 않는다(M2.5 「오프라인」).
    if (offline) { this.noteReconnect(); this.clearImages(); } else this.emit();
  }
  // ------------------------------------------------------------------------------------------------ 읽기 문의 상태 (M2.4-1 4번)
  /**
   * 알림 프레임 하나를 기록한다. **어떤 조기 반환보다 먼저** 부른다(`notices.ts`): 이미 처리한 version 의 둘째 프레임, 이미 가진 version 이라 읽기를 건너뛰는 프레임,
   * 그림을 그대로 두는 등록·고치기·정책 상세까지 모두 이 문을 닫는다. 알림의 version 을 **담은 읽기**(전체 목록이거나 since < version ≤ 응답 version)가 적용돼야 열린다.
   * 내 쓰기 응답(`mutate`)은 확인이 아니다. version 을 읽을 수 없는 알림은 재연결처럼 전체 목록만 문을 연다.
   */
  noticed(workspaceId: string, version: ExpressionVersion) {
    if (this.disk === null || workspaceId !== this.workspaceId) return;
    if (!DECIMAL.test(version)) { this.noteReconnect(); return; }
    if (this.confirmedNotices.has(version) || this.pendingNotices.has(version)) return;
    this.pendingNotices.set(version, ++this.noticeSerial);
  }
  /** 실시간 (재)구독 신호. **첫 구독은 재연결이 아니다**: 이 세션의 첫 목록 읽기가 기준이고, 끊겼다 돌아온 구독부터 전체 목록이 적용될 때까지 문을 닫는다(ADR §14 M2.4-1 4번). */
  reconnected() {
    if (this.disk === null) return;
    if (!this.subscribedOnce) { this.subscribedOnce = true; return; }
    this.noteReconnect();
  }
  private noteReconnect() {
    if (this.disk === null) return;
    this.confirmedNotices.clear();
    this.reconnectSerial += 1;
  }
  /** 읽기 문이 알림 또는 재연결 때문에 닫혀 있는가(이 저장소가 디스크를 쓰지 않으면 늘 열려 있다고 본다). */
  diskDoorDown() { return this.pendingNotices.size > 0 || this.reconnectConfirmed < this.reconnectSerial; }
  /** 알림이 왔는데 읽을 필요가 없어 읽기를 건너뛴 자리(이미 그 version 을 가졌다 — 내 응답이 먼저 왔다)에서 부른다: 문이 닫혀 있으면 문을 열 읽기 한 번을 한다. */
  openDoor() { if (this.disk !== null && this.diskDoorDown()) void this.refresh(false); }
  /** 문을 열려면 증분 읽기로는 모자란가: 재연결이 있었거나, 기다리는 알림의 version 이 이미 캐시 version 이하(`since` 가 알림보다 작을 수 없다)다. */
  private doorNeedsFullRead(known: ExpressionVersion) {
    return this.reconnectConfirmed < this.reconnectSerial || [...this.pendingNotices.keys()].some((version) => compareExpressionVersions(version, known) <= 0);
  }
  /** 이 읽기가 알림을 확인했는가: 읽기가 시작하기 전에 기록된 알림 중, 목록이 그 version 까지 오고 그 version 을 **담은**(전체이거나 since < version) 것. */
  private confirmDoor(mark: { notices: number; reconnect: number }, list: ExpressionList, since: ExpressionVersion | null) {
    for (const [version, recordedAt] of [...this.pendingNotices]) {
      if (recordedAt > mark.notices || compareExpressionVersions(list.version, version) < 0) continue;
      if (!list.reset && (since === null || compareExpressionVersions(since, version) >= 0)) continue;
      this.pendingNotices.delete(version);
      this.confirmedNotices.add(version);
      if (this.confirmedNotices.size > CONFIRMED_NOTICE_MEMORY) this.confirmedNotices.delete(this.confirmedNotices.values().next().value!);
    }
    if (list.reset && mark.reconnect > this.reconnectConfirmed) this.reconnectConfirmed = mark.reconnect;
  }
  /**
   * 목록을 읽는다. **그림은 목록이 실제로 바뀐 만큼만 걷는다**(#5330): 앞 판은 읽기를 시작할 때마다 그림을 전부 걷어서(`clearImages`) 창 초점이 돌아올 때와
   * 30초마다 보이는 그림이 모두 다시 내려받아졌다(깜빡임). 지금은 답이 와서 목록을 바꿔 끼울 때 코어 `applyExpressionList` 가 돌려주는 `evictImageIds`
   * (지워지거나 그림이 바뀐 등록)가 있을 때만 걷는다. 숨김·삭제를 **즉시** 걷는 길은 그대로다: 실시간 변경 알림(`ExpressionsProvider`)·`mutate`·오프라인·
   * 오류가 각자 `clearImages` 를 부른다. 읽는 동안에도 `status` 는 `ready` 그대로라 이미 읽은 목록이 서 있다(스켈레톤은 맨 처음 읽을 때만).
   */
  async refresh(full = true) {
    this.disposed = false;
    const serial = ++this.refreshSerial;
    // 이 읽기가 시작하기 전에 기록된 알림·재연결만 이 읽기가 확인할 수 있다(읽기 문, M2.4-1 4번).
    const mark = { notices: this.noticeSerial, reconnect: this.reconnectSerial };
    try {
      const known = this.snapshot.cache.version;
      const incremental = !full && known !== null && !this.doorNeedsFullRead(known);
      const since = incremental ? `?since=${known}` : "";
      const value = await this.transport.json({ method: "GET", path: `${this.base}/expressions${since}` });
      if (serial !== this.refreshSerial) return;
      if (!matchesExpressionContract("List", value)) throw new Error("expression list");
      const next = applyExpressionList(this.snapshot.cache, value as ExpressionList);
      if (next.needsFullRefresh && !full) { await this.refresh(); return; }
      if (!next.applied && !next.needsFullRefresh) return;
      if (!next.applied) throw new Error("expression snapshot");
      this.snapshot.cache = next.cache;
      this.snapshot.status = READY;
      this.snapshot.failure = null;
      this.confirmDoor(mark, value as ExpressionList, incremental ? known : null);
      if (next.evictImageIds.length > 0) this.clearImages();
      // 목록이 적용될 때마다 디스크 색인을 목록과 대조해 active 가 아닌 키를 지운다(M2.4-2). 기준은 코어의 `evictImageIds` 가 아니라 **디스크 색인**이다.
      this.reconcileDisk();
    } catch (error) {
      // 오류 객체를 버리지 않는다(#5279 C): 화면이 이 실패가 연결 쪽인지(오프라인 / 서버에 닿지 못함)를 말하려면 객체가 있어야 한다.
      if (serial === this.refreshSerial) {
        this.snapshot.status = "error"; this.snapshot.failure = error; this.clearImages();
        // 목록 읽기가 401·403·404 로 끝났다(강제 퇴장·멤버 제거·로그인 끝): 그 보관 칸을 지운다. 읽기 실패 자체는 청소를 돌리지 않고 문만 닫아 둔다(`status` 가 `ready` 가 아니다).
        if (this.disk !== null && listReadRefused(error)) this.trackDisk(this.disk.compartment.destroy());
      }
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
    // 내 응답은 캐시 version 의 **바로 다음 version 일 때만** 델타로 얹는다(R1-L5, 폰 #5491 과 같은 규칙): 서버 카운터는 변경마다 +1 이라 사이에 낀 version 이 있으면
    // 그 사이의 남의 변경(숨김·삭제)을 이 한 응답이 싣지 않는다. 건너뛴 캐시는 그 등록을 `active` 로 남기고 다음 읽기도 그것을 다시 알리지 않는다 — 아니면 목록을 다시 읽는다.
    const adjacent = prior.version !== null && isNextExpressionVersion(prior.version, result.version);
    const next = adjacent ? applyExpressionList(prior, { workspaceId: this.workspaceId, version: result.version, baseVersion: prior.version, reset: false, addPolicy: prior.addPolicy, items: [result.expression] }) : null;
    // Remove all visible bytes before publishing a hide/delete, including pending reads.
    this.clearImages();
    if (next?.applied) { this.snapshot.cache = next.cache; this.emit(); this.reconcileDisk(); }
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
    const id = expressionIdOfImagePath(path);
    const idGeneration = id === null ? 0 : (this.revoked.get(id) ?? 0);
    // 메모리 캐시와, 읽기 문을 통과한 앱 소유 디스크 저장소(ADR-0218 D3 → §14): 총량은 `ImageCache` 가 바이트 예산 LRU 로 묶는다. 전체 걷기와 이 id 의 걷기 모두 받는 중 읽기를 버린다.
    return this.images.add(path, this.loadImage(path, () => generation !== this.generation || (id !== null && (this.revoked.get(id) ?? 0) !== idGeneration)));
  }
  /** 디스크 → 네트워크 순서로 그림 하나를 데이터 주소로 얻는다. `stale()` 은 받는 도중 걷혔는가(알림·비우기·그 id 의 걷기). */
  private async loadImage(path: string, stale: () => boolean): Promise<string> {
    const target = this.diskTarget(path);
    if (target !== null && this.diskDoorOpen()) {
      const src = await this.readFromDisk(target);
      if (stale()) throw new Error("evicted expression");
      if (src !== null && this.disk!.sessionUnchanged() && !this.disposed) return src;
    }
    const src = await this.transport.image(path);
    if (stale()) throw new Error("evicted expression");
    if (target !== null) this.writeToDisk(target, src, stale);
    return src;
  }
  /**
   * 읽기 문의 조건 3(M2.4-1): 주소가 가리키는 `(id, size, sha)` 가 **확인된 목록의 active 항목**의 `media.<size>.sha256` 과 같을 때만 디스크 대상이다.
   * 초안 미리보기 주소(`expression-drafts/…`)와 그 밖의 모양은 `null` 이라 디스크를 아예 보지 않는다(M2.3, MA12).
   */
  private diskTarget(path: string): ListedDiskTarget | null {
    if (this.disk === null || this.disposed) return null;
    return listedDiskTarget(this.snapshot.cache.items, path);
  }
  /** 읽기 문의 조건 1·2·4·5: `ready`, 온라인, 알림·재연결의 확인 읽기가 끝났다, 이 칸의 세션이 끝나지 않았다. */
  private diskDoorOpen(): boolean {
    return this.disk !== null && !this.disposed && this.snapshot.status === READY && !this.snapshot.offline && !this.diskDoorDown() && this.disk.sessionUnchanged();
  }
  /** 디스크의 그림 하나. 길이·MIME·sha256 이 목록과 다르면 그 항목을 지우고 `null`(네트워크로 간다). */
  private async readFromDisk(target: ListedDiskTarget): Promise<string | null> {
    const disk = this.disk!;
    let entry: DiskImage | null;
    try { entry = await disk.compartment.read(target.key); } catch { return null; }
    if (entry === null) return null;
    let intact = entry.mime === target.media.mime && entry.bytes.byteLength === target.media.bytes;
    if (intact) intact = (await sha256Hex(entry.bytes).catch(() => null)) === target.sha;
    if (!intact) { this.trackDisk(disk.compartment.remove([target.key])); return null; }
    try { return await bytesToDataUrl(entry); } catch { return null; }
  }
  /** 쓰기도 같은 문을 건다: 받는 도중 걷혔거나 목록에 active 로 없거나 문이 닫혀 있으면 늦게 온 바이트를 쓰지 않는다. */
  private diskWriteAllowed(target: ListedDiskTarget, stale: () => boolean): boolean {
    if (this.writesPaused || stale() || !this.diskDoorOpen()) return false;
    return isListedDiskTarget(this.snapshot.cache.items, target);
  }
  private writeToDisk(target: ListedDiskTarget, src: string, stale: () => boolean) {
    const disk = this.disk!;
    if (!this.diskWriteAllowed(target, stale)) return;
    this.trackDisk((async () => {
      const image = parseImageDataUrl(src);
      // 정확한 길이·MIME·sha256 이 목록과 같을 때만 둔다(M2.6). 다르면 그림은 그대로 그려지고 디스크에는 남지 않는다.
      if (image === null || image.mime !== target.media.mime || image.bytes.byteLength !== target.media.bytes) return;
      if ((await sha256Hex(image.bytes).catch(() => null)) !== target.sha) return;
      if (!this.diskWriteAllowed(target, stale)) return;
      try { await disk.compartment.write(target.key, image); } catch { this.writesPaused = true; return; }
      // 쓰는 사이 세션이 끝났거나(다른 탭의 로그아웃) 저장소가 놓였다면(계정·워크스페이스 전환) 되살아난 칸을 **칸째** 다시 지운다(R2-L3, 구현 검수 1회차 L1).
      // 쓰기는 이미 지워진 칸과 장부 줄을 다시 만들기 때문에 항목 하나만 지우면 그림 바이트는 없어도 워크스페이스·멤버 id 가 든 빈 칸 이름이 다음 시작까지 남는다.
      if (!disk.sessionUnchanged() || this.disposed) { await disk.compartment.destroy(); return; }
      this.writesSinceTrim += 1;
      if (this.writesSinceTrim === 1 || this.writesSinceTrim % TRIM_EVERY_WRITES === 0) await disk.compartment.trim();
    })());
  }
  /** 디스크 대조 청소(M2.4-2): 지금 목록에 active 로 없는 디스크 키를 모두 지운다. 색인을 읽을 수 없으면 청소를 돌리지 않는다. */
  private reconcileDisk() {
    const disk = this.disk;
    if (disk === null || this.disposed) return;
    this.reconcileChain = this.reconcileChain.then(async () => {
      const keys = await disk.compartment.keys();
      if (keys === null || this.disposed || !disk.sessionUnchanged()) return;
      // 활성 키는 색인을 읽은 **뒤**의 목록으로 센다: 그 사이 새로 등록돼 써진 그림을 지우지 않는다.
      const active = activeDiskKeys(this.snapshot.cache.items);
      const stale = keys.filter((key) => !active.has(key));
      if (stale.length > 0) await disk.compartment.remove(stale);
    }).catch(() => undefined);
    this.trackDisk(this.reconcileChain);
  }
  private trackDisk(task: Promise<unknown>) {
    const settled: Promise<void> = task.then(() => undefined, () => undefined).finally(() => { this.diskTasks.delete(settled); });
    this.diskTasks.add(settled);
  }
  /** 진행 중인 디스크 쓰기·청소가 끝나기를 기다린다(시험·진단용). */
  async settleDisk() { while (this.diskTasks.size > 0) await Promise.all([...this.diskTasks]); }
  /**
   * 이 그림을 메모리·디스크에서 지운다(그림이 디코드에 실패했다, M2.6): 칸이 쥔 `kept` 와 「그림 다시 불러오기」가 같은 바이트를 다시 쓰지 않도록 지우기가 **먼저**여야 한다.
   * 다음 `image()` 는 네트워크로 받는다.
   */
  discardImage(path: string) {
    this.images.removeWhere((key) => key === path || key === `${path}#loop`);
    const parsed = parseExpressionImagePath(path);
    if (parsed !== null && this.disk !== null) this.trackDisk(this.disk.compartment.remove([parsed.key]));
  }
  /**
   * 반응 칩이 그리는 움직이는 그림(#5504, owner 「계속 움직임」): `image(path)` 와 **같은 그림**에서 GIF 의 반복 횟수만 무한으로 바꾼 데이터 주소다(코어 `loopForeverDataUrl`).
   * 서버가 주는 그림·해시는 그대로이고 이 주소는 화면에만 쓴다. 같은 그림을 쓰는 모든 칩이 이 약속 하나를 나눠 쓰므로(한 주소) 엔진이 디코드를 한 번만 하고 장면도 함께 간다.
   * 원본과 같은 예산 LRU 에 들어가므로 비우기(`clearImages`)·밀려나기가 똑같이 적용된다.
   */
  loopedImage(path: string): Promise<string> {
    const key = `${path}#loop`;
    const hit = this.images.get(key);
    if (hit) return hit;
    return this.images.add(key, this.image(path).then(loopForeverDataUrl));
  }
}
