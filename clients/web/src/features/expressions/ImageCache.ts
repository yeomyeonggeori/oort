/**
 * 인증된 그림을 **메모리에서만** 쥐는 칸(ADR-0218 D3 「인증된 앱 메모리 캐시만 허용」: 디스크·IndexedDB·Cache Storage 는 쓰지 않는다).
 *
 * #5468: 앞 판은 **96칸 FIFO** 였다. 큰 이모티콘 하나가 두 칸(thumb·large)을 쓰고 읽어도 순서가 안 바뀌어서, 한 채널의 큰 이모티콘이 48개를
 * 넘는 순간 다시 들어갈 때 처음부터 훑는 순서와 겹쳐 **전부 다시** 받았다(49개 → 98요청, 60개 → 120요청). 이제는 **바이트 예산 LRU** 다:
 * 쓴 지 가장 오래된 것부터 내보내고, 읽으면 가장 최근으로 올린다. 예산 안에서는 몇 칸이든 쥔다.
 *
 * 예산의 단위는 데이터 URL **글자 수**다. 데이터 URL 은 ASCII 라 엔진이 한 글자를 1바이트로 쥐므로(V8·JSC·SpiderMonkey 의 1바이트 문자열)
 * 글자 수가 곧 이 캐시가 붙들고 있는 메모리다. `ExpressionImage` 가 칸마다 쥐는 `kept` 는 **같은 문자열을 가리킬 뿐 복사하지 않으므로** 여기서
 * 다시 세지 않는다(두 번 세지 않는다). 칸이 쥔 문자열은 저장소가 내보낸 뒤에도 그 칸이 사라질 때까지 산다(화면에 걸린 만큼이라 위쪽이 있다).
 */
export interface ImageCacheLimits {
  /** 쥘 수 있는 데이터 URL 글자 수(= 바이트)의 합. 넘으면 가장 오래 안 쓴 것부터 내보낸다. */
  budgetBytes: number;
  /** 안전장치: 항목 수 상한. 바이트 예산이 정상 사용에서 먼저 걸리도록 크게 잡는다. */
  maxEntries: number;
}

/**
 * 96 MiB. 근거(#5455 웹 실측, 정지 32 + GIF 8 = 40개 표를 되풀이한 구성; 단위는 데이터 URL 글자 수):
 * 큰 이모티콘 하나의 thumb + large 는 평균 **379 KiB**(5455a 칸의 새 인코더) ~ **438 KiB**(지금 운영 인코더)라서, 서로 다른 큰 이모티콘 **200개**가 선 채널에
 * 다시 들어와도 요청이 0이려면 **74 ~ 86 MiB** 가 든다. 96 MiB 는 거기에 12 ~ 30% 여유이고, 같은 구성으로 225 ~ 260개(94 MiB)까지 0요청을 쟀다.
 * 전부 GIF 인 채널은 한 개가 793 ~ 835 KiB 라 123 ~ 118개까지다(그 너머는 오래 안 쓴 것부터 밀린다). 더 쥐려면 올릴 곳은 이 상수 하나다.
 */
export const IMAGE_CACHE_BUDGET_BYTES = 96 * 1024 * 1024;
/**
 * 4,096. 워크스페이스 한도(등록 1,000개, `EXPRESSION_LIMITS.workspace`) × variant 3(small·large·thumb) = 3,000 에 초안 미리보기를 얹어도 안 닿는 값이다.
 * 한 채널의 큰 이모티콘 200개는 400칸이므로, 이 상한이 낮으면 바이트가 아니라 칸 수에서 앞 판과 같은 절벽이 다시 생긴다.
 */
export const IMAGE_CACHE_MAX_ENTRIES = 4096;

interface Entry {
  promise: Promise<string>;
  /** 받기를 마친 뒤의 데이터 URL 글자 수. 받는 동안은 0이다(예산에 아직 들지 않는다). */
  bytes: number;
  settled: boolean;
}

export class ImageCache {
  /** Map 의 삽입 순서가 곧 최근 사용 순서다: 맨 앞이 가장 오래 안 쓴 것, 맨 뒤가 가장 최근이다. */
  private entries = new Map<string, Entry>();
  private held = 0;
  constructor(private readonly limits: ImageCacheLimits = { budgetBytes: IMAGE_CACHE_BUDGET_BYTES, maxEntries: IMAGE_CACHE_MAX_ENTRIES }) {}
  get size() { return this.entries.size; }
  /** 지금 쥐고 있는 데이터 URL 글자 수(받기를 마친 것만). */
  get bytes() { return this.held; }
  /** 순서를 바꾸지 않고 있는지만 본다. */
  has(key: string) { return this.entries.has(key); }
  stats() { return { entries: this.entries.size, bytes: this.held, budgetBytes: this.limits.budgetBytes, maxEntries: this.limits.maxEntries }; }
  /** 읽으면 가장 최근으로 올린다. `Map.set` 은 이미 있는 키의 자리를 바꾸지 않으므로 지우고 다시 넣어야 한다. */
  get(key: string): Promise<string> | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.promise;
  }
  /**
   * 받는 중인 읽기를 올리고, 같은 항목을 기다리는 모두가 쓸 약속을 돌려준다. 바이트는 **받은 뒤에** 센다(그전에는 크기를 모른다).
   * 그 사이 비워졌거나 밀려났거나 같은 키로 새 항목이 들어섰다면(자기 항목이 아니다) 센 쪽에 더하지 않는다.
   */
  add(key: string, load: Promise<string>): Promise<string> {
    const entry: Entry = { promise: load, bytes: 0, settled: false };
    entry.promise = load.then(
      (src) => { if (this.entries.get(key) === entry) this.settle(key, entry, src.length); return src; },
      (error: unknown) => { if (this.entries.get(key) === entry) this.entries.delete(key); throw error; },
    );
    this.entries.set(key, entry);
    this.trimCount();
    return entry.promise;
  }
  clear() { this.entries.clear(); this.held = 0; }
  /**
   * 조건에 맞는 키의 칸만 비운다(받는 중인 칸 포함 — 늦게 도착해도 예산에 들지 않는다). 숨김·삭제 상세가 그 표현의 그림만 걷을 때 쓴다(ADR-0218 §15).
   * 받는 중인 칸은 0바이트라 센 값은 받은 칸만 줄인다.
   */
  removeWhere(match: (key: string) => boolean) {
    for (const [key, entry] of [...this.entries]) {
      if (!match(key)) continue;
      this.entries.delete(key);
      if (entry.settled) this.held -= entry.bytes;
    }
  }
  private settle(key: string, entry: Entry, bytes: number) {
    entry.bytes = bytes;
    entry.settled = true;
    this.held += bytes;
    // 방금 받은 것은 곧 쓰일 것이라 가장 최근으로 둔다.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.trimBytes();
  }
  private trimBytes() {
    for (const [key, entry] of this.entries) {
      if (this.held <= this.limits.budgetBytes) return;
      // 받는 중인 것은 0바이트라 내보내도 예산이 줄지 않는다.
      if (!entry.settled) continue;
      this.entries.delete(key);
      this.held -= entry.bytes;
    }
  }
  private trimCount() {
    while (this.entries.size > this.limits.maxEntries) {
      const oldest = this.entries.entries().next();
      if (oldest.done) return;
      const [key, entry] = oldest.value;
      this.entries.delete(key);
      if (entry.settled) this.held -= entry.bytes;
    }
  }
}
