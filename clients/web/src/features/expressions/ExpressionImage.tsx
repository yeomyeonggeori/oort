import { expressionImagePath } from "./media";
import { useEffect, useRef, useState } from "react";
import { expressionAltText } from "@momo/core/features/expressions/message";
import type { Expression, ExpressionDraft } from "@momo/core/features/expressions/types";
import { useExpressions } from "./context";
import { ExpressionImageInterruptedError } from "./ExpressionStore";

function useReduceMotion() {
  const [reduce, setReduce] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const change = () => setReduce(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduce;
}

const GIF_DATA_PREFIX = "data:image/gif;base64,";
/**
 * 같은 바이트를 처음부터 다시 돌리려면 브라우저가 「다른 그림」으로 보게 해야 한다. 같은 주소는 엔진(Chromium·WebKit 둘 다)이 한 그림으로 묶어
 * 재생 시계를 같이 쓴다: 같은 그림이 다른 곳에서 돌고 있으면 새 `<img>`도 그 중간 장면에서 시작한다. 데이터 주소의 미디어 형식 매개변수
 * (`data:image/gif;replay=N;base64,...`)는 바이트도 요청도 바꾸지 않고 주소만 바꾼다. 요청은 없고(데이터 주소), CSP 의 `img-src data:` 안이다.
 */
function replayUrl(src: string, replay: number) {
  return replay > 0 && src.startsWith(GIF_DATA_PREFIX) ? `data:image/gif;replay=${replay};base64,${src.slice(GIF_DATA_PREFIX.length)}` : src;
}
/** 화면 밖에서 먼저 디코드한다. 이 약속이 끝난 뒤에만 보이는 그림을 바꿔 끼우므로 바꾸는 순간에 빈 장면이 없다. 디코드 API 가 없는 환경은 바로 통과한다. */
async function decoded(src: string) {
  const probe = new Image();
  probe.src = src;
  await probe.decode?.();
  return src;
}
/** 칸을 메타데이터의 가로·세로로 미리 잡는다(CSS 의 최대 크기와 같은 한계 안에서 확대 없이 맞춘다). */
const BOX_LIMIT = { large: 200, medium: 64 } as const;
function slotBox(width: number, height: number, limit: number) {
  const scale = Math.min(1, limit / width, limit / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
/**
 * 그림 받기 실패가 **지나가는 것**인가(#5575): 오프라인 · 저장소가 받는 도중 걷음(세대 교체) · 응답 없음(`fetch`의 TypeError) · 시간 초과 ·
 * 서버가 잠시 못 답함(408·429·5xx). 이런 실패에 칸을 `:이름:` 글자로 바꾸면 그림 줄(최대 200px)이 글자 한 줄이 되고, 다시 받는 순간 되돌아오며
 * 목록 높이가 위아래로 뛴다(데스크탑 WebKit 에서 목록이 수백 px 밀리고 「최신 메시지로 이동」이 섰다). 그 밖의 실패(숨김·틀린 sha 의 404, 권한,
 * 형식이 다름, 디코드 실패)는 다시 받아도 같으므로 글자로 둔다.
 */
function transientImageFailure(error: unknown): boolean {
  if (error instanceof ExpressionImageInterruptedError || error instanceof TypeError) return true;
  // 요청 시간 초과(`binaryRequest` 의 AbortController) · 시간 제한. 디코드 실패(EncodingError)는 지나가는 것이 아니다.
  if (error instanceof DOMException) return error.code === DOMException.ABORT_ERR || error.code === DOMException.TIMEOUT_ERR;
  const status = (error as { status?: unknown } | null)?.status;
  return Number.isFinite(status) && (status === 408 || status === 429 || (status as number) >= 500);
}
/** 지나가는 실패 뒤 다시 받기까지 기다리는 시간: 1.5초부터 두 배씩, 30초에서 멈춘다(연결이 오래 끊겨도 요청이 쌓이지 않는다). */
const RETRY_FIRST_MS = 1_500;
const RETRY_MAX_MS = 30_000;
/**
 * 스스로 다시 받는 횟수의 끝(#5575 M2). 1.5 · 3 · 6초 뒤 세 번 다시 받아도 지나가는 실패가 이어지면 더 기다리지 않고 칸 안에 실패를 말한다
 * (이름 + 큰 칸이면 「그림 다시 불러오기」). 끝이 없으면 서버가 같은 그림에 계속 500을 내는 **영구** 실패도 영원히 빈 칸이었다.
 */
const RETRY_LIMIT = 3;
/**
 * 빈 칸이 이만큼 이어지면 칸 안에 이름을 세운다(#5575 M1). 첫 자동 재시도(1.5초)가 한 번 돌고 그 받기가 끝날 시간까지 기다린 값이라, 재연결마다
 * 그림을 전부 걷고 다시 받는 보통의 흔들림(`resync` → 다시 받기, 게이트의 오프라인 흔들림 1.3초)에서는 이름이 깜빡이지 않고, 정말로 끊긴 동안에는
 * 3초 안에 「여기 무슨 이모티콘이 있었는지」가 보인다. 칸의 크기는 그대로다(글자는 칸 위에 얹는다).
 */
const LABEL_DELAY_MS = 2 * RETRY_FIRST_MS;
/**
 * 이름 글자가 읽히는 칸과 그 글자의 맞춤. 큰 칸(200×150, 동작 줄이기 thumb 128×96)은 한 줄로 자르고, 고르개·미리 보기 칸(64×48)은 두 줄까지 아무 데서나
 * 끊는다(이름은 띄어쓰기 없는 낱말이다). 여기 없는 칸, 곧 글 사이(20×15)와 반응 칩(20×20)은 글자 두세 개도 안 들어가 이름이 「:b…」로 잘리므로 같은 칸에
 * 정지 자리표시(옅은 그릇 + 테두리, `expressions.css`)만 세우고 이름은 `title` 에 둔다. 낭독 이름(`aria-label`)은 어느 칸이든 칸(canvas)이 늘 그대로 진다.
 */
const LABEL_FIT: Partial<Record<string, string>> = { large: "min-w-0 truncate", medium: "line-clamp-2 break-all" };

/** All images enter through the authenticated transport, including draft previews. */
export function ExpressionImage({ item, size = "inline", still = false, onReady }: {
  item: Expression | ExpressionDraft;
  size?: "large" | "medium" | "inline" | "reaction";
  still?: boolean;
  onReady?: () => void;
}) {
  const { store, epoch: storeEpoch, revoked, offline } = useExpressions();
  // 이 표현의 그림이 걷히면(숨김·삭제 상세가 그 id 만 걷는다) 이 칸만 새 세대가 된다 — 다른 표현의 칸은 그대로라 다시 그려지지 않는다(ADR-0218 §15).
  // 둘 다 오르기만 하는 수라 합이 같으면 둘 다 그대로다.
  const revokedId = (item as Partial<Expression>).id; // 초안 미리보기에는 `id` 가 없다
  const epoch = storeEpoch + (revokedId === undefined ? 0 : (revoked.get(revokedId) ?? 0));
  const reduce = useReduceMotion();
  const root = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [stopped, setStopped] = useState(false);
  // 누른 횟수(다시 재생)와 다시 불러온 횟수(실패 뒤)는 따로 센다: 둘 다 새 그림 요청이 아니라 같은 바이트의 새 장면·새 시도다.
  const [replay, setReplay] = useState(0);
  const [attempt, setAttempt] = useState(0);
  // 지금 화면에 걸린 그림. 다음 그림이 준비(디코드)될 때까지 이 그림이 그대로 보이고, 준비되면 같은 <img> 에서 src 만 바뀐다.
  // (옛 판은 key 를 바꿔 <img> 를 새로 만들었고, 그 사이에 글자 자리표시가 서서 칸이 비거나 높이가 바뀌었다. 이 판은 <img> 를 만들지 않는다.)
  const [shown, setShown] = useState<{ key: string; epoch: number; owner: string; src: string } | null>(null);
  // 받기에 실패한 그림의 key 와, 그 실패가 지나가는 것인지(`transientImageFailure`). 지나가는 실패는 같은 크기의 빈 칸으로 기다렸다 다시 받는다.
  // `exhausted` 는 지나가는 실패가 다시 받기 `RETRY_LIMIT` 번 뒤에도 이어진 것이다: 더 기다리지 않고 칸 안에 실패를 말한다(M2).
  const [failed, setFailed] = useState<{ key: string; transient: boolean; exhausted: boolean } | null>(null);
  const retries = useRef(0);
  // 그려진 <img>의 key. load는 보임보다 먼저 올 수 있고, 동작 줄이기에서는 보임이 바뀌어도 그림 주소(key)가 같아
  // <img>가 다시 만들어지지 않으므로 load가 다시 오지 않는다. 그래서 load는 기록만 하고 신호는 아래 효과가 낸다.
  // 신호를 받는 쪽이 없으면(본문·격자·반응의 그림) load 처리기도 달지 않는다: 줄마다 다시 그리는 비용이 늘지 않는다.
  const [painted, setPainted] = useState<string | null>(null);
  const told = useRef<string | null>(null);
  // 이 칸이 이미 받은 바이트(같은 문자열을 가리킬 뿐 복사하지 않는다). 다시 재생·멈춤·보임 전환이 저장소의 96칸 캐시가 밀려나도 요청을 내지 않게 한다.
  const kept = useRef<{ epoch: number; bytes: Map<string, string> }>({ epoch: 0, bytes: new Map() });
  const fullVariant = size === "large" ? "large" : "small";
  // 반응 칩의 움직이는 그림은 4번 돌고 멈추지 않고 계속 돈다(owner 2026-11-07, ADR-0218 증보 §13). 서버 GIF 의 반복 횟수는 4번이라(NETSCAPE 3) 타이머만 빼서는 마지막 장면에서 멈추므로
  // 반응 칩은 같은 그림의 반복 횟수만 무한으로 바꾼 주소를 그린다(`store.loopedImage`). 동작 줄이기·화면 밖은 아래 `variant` 가 그대로 정지 thumb 이다.
  const endless = size === "reaction";
  const variant = still || reduce || !visible || stopped ? "thumb" : fullVariant;
  const path = store ? expressionImagePath(store.base, item, variant) : null;
  const key = `${path}:${epoch}:${replay}:${attempt}`;
  // 같은 자리에 다른 표현이 오는 경우(본문 편집으로 같은 순서의 토큰이 바뀐다)에 앞 표현의 그림을 대신 걸어 두지 않으려고 걸린 그림에 주인(그림 주소에서 쿼리를 뺀 앞부분: 표현 id·초안 id 가 든다)을 적는다.
  const owner = path?.split("?")[0] ?? "";
  const animated = variant !== "thumb" && item.media?.[variant].mime === "image/gif";
  // 이 칸이 쥐는 열쇠: 반응 칩의 움직이는 그림은 반복 횟수가 바뀐 주소라 같은 길의 원본과 섞이지 않게 따로 쥔다.
  const heldKey = animated && endless ? `${path}#loop` : path;
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!store || !path || offline) return;
    let live = true;
    // 세대가 바뀌면(저장소가 그림을 걷었다) 가진 바이트도 버린다: 걷은 그림을 이 칸이 다시 내보이지 않는다.
    if (kept.current.epoch !== epoch) kept.current = { epoch, bytes: new Map() };
    const bytes = kept.current.bytes;
    const held = bytes.get(heldKey!);
    const source = held !== undefined ? Promise.resolve(held) : (animated && endless ? store.loopedImage(path) : store.image(path)).then((src) => { bytes.set(heldKey!, src); return src; });
    source.then((src) => decoded(animated ? replayUrl(src, replay) : src).catch((error: unknown) => {
      // 디코드에 실패한 그림은 이 칸의 `kept`·메모리·디스크에서 **먼저** 지운다(ADR-0218 §14 M2.6): 안 그러면 「그림 다시 불러오기」가 같은 바이트를 다시 쓴다.
      bytes.delete(heldKey!);
      store.discardImage(path);
      throw error;
    })).then(
      (src) => {
        if (!live) return;
        retries.current = 0;
        setShown({ key, epoch, owner, src });
        setFailed((prior) => prior?.key === key ? null : prior);
      },
      (error: unknown) => {
        if (!live) return;
        const transient = transientImageFailure(error);
        // 다시 받기를 다 쓴 칸은 그대로 실패로 남는다: 연결이 돌아오거나(`offline` 바뀜) 세대·보임이 바뀌어 위 효과가 다시 받은 한 번이 또 실패해도
        // 새로 세 번을 기다리지 않는다. 횟수는 받기에 성공하거나 사람이 「그림 다시 불러오기」를 눌러야 0으로 돌아간다.
        setFailed({ key, transient, exhausted: transient && retries.current >= RETRY_LIMIT });
      },
    );
    return () => { live = false; };
  }, [store, path, key, offline, epoch, owner, animated, endless, replay, heldKey]);
  // 지나가는 실패(연결 끊김 · 서버 재시작 · 세대 교체 경합): 빈 칸으로 기다렸다가 같은 그림을 다시 받는다. 오프라인 동안은 기다리지 않는다 —
  // 돌아오면 위 효과가 `offline` 바뀜으로 다시 받는다. 다시 받기를 다 쓴 실패(`exhausted`)는 더 기다리지 않는다.
  useEffect(() => {
    if (failed === null || !failed.transient || failed.exhausted || failed.key !== key || offline) return;
    const timer = window.setTimeout(() => {
      retries.current += 1;
      setAttempt((value) => value + 1);
    }, Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** retries.current));
    return () => window.clearTimeout(timer);
  }, [failed, key, offline]);
  // 정말로 깨진 그림의 key(지나가는 실패는 깨진 것이 아니다).
  const broken = failed !== null && !failed.transient ? failed.key : null;
  // 걸린 그림이 지금 보여도 되는 그림인가: 이 표현의 것이고, 같은 세대의 것이고, 오프라인이 아니고, 이 표현에 아직 그림이 있고, 깨지지 않았다.
  const current = shown && shown.owner === owner && shown.epoch === epoch && !offline && path !== null && broken !== shown.key ? shown : null;
  // 걸린 그림이 지금 바라는 그림(key)이기도 한가. 아니면 바라는 그림을 준비하는 동안 앞 그림이 대신 걸려 있는 것이다.
  const available = current !== null && current.key === key;
  const playing = animated && available;
  useEffect(() => {
    if (!playing || endless) return;
    // GIF output is encoded for four total plays as well. This deadline switches
    // to the static thumb even on decoders with different loop metadata semantics.
    const timer = window.setTimeout(() => setStopped(true), (item.media?.[variant].durationMs ?? 0) * 4);
    return () => window.clearTimeout(timer);
  }, [playing, endless, key, item.media, variant]);
  // 사람이 승인 전에 **본** 그림이라는 신호(#4846): 실제로 그려졌고(load) 화면에 있을 때(visible) 한 번만, 둘의 순서와
  // 무관하게 낸다. 안 보이는 그림이나 깨진 그림(error)으로는 풀리지 않는다. 한 key에 한 번(`told`)이라 보임이 흔들려도,
  // 같은 그림이 다시 load돼도 신호는 더 오지 않는다.
  const seen = available && painted === key && !still && visible && (variant === "large" || reduce);
  useEffect(() => {
    if (!seen || told.current === key) return;
    told.current = key;
    onReady?.();
  }, [seen, key, onReady]);
  // 정지 그림(thumb)과 움직이는 그림이 한 칸을 같은 크기로 쓰게 한다: thumb 은 긴 변이 128 이하라 큰 칸(200)의 움직이는 그림보다 작게 그려져
  // 멈추고 다시 돌 때마다 줄 높이가 뛰었다. 동작 줄이기·정지(still) 는 thumb 만 그리므로 바꿔 끼울 일이 없어 그대로 둔다.
  const full = item.media?.[fullVariant];
  const limit = (BOX_LIMIT as Record<string, number | undefined>)[size];
  const slot = !still && !reduce && limit !== undefined && full ? slotBox(full.width, full.height, limit) : null;
  // 그림을 지금 못 그리는 이유가 지나가는 것(받는 중 · 오프라인 · 세대 교체 · 지나가는 실패)이면 글자 자리표시 대신 같은 크기의 빈 칸을 세운다
  // (#5575: 그림 줄이 글자 한 줄로 줄었다 되돌아오며 목록이 뛰었다). 오프라인에서도 그림이 아니라 정지 자리표시다(ADR-0218 「offline에서는
  // 문자열/정지 자리표시만」). 글자는 이 표현에 그림이 없거나(숨김·삭제는 목록에서 빠져 본문이 글자로 그린다) 그림이 정말로 깨졌을 때만이다.
  const own = item.media?.[variant];
  const placeholder = path !== null && own !== undefined && broken !== key && broken !== shown?.key;
  const reserved = slot ?? (own ? { width: own.width, height: own.height } : null);
  const alt = expressionAltText(item as Expression);
  // 같은 크기의 빈 칸이 서 있는가(받는 중 · 오프라인 · 세대 교체 · 지나가는 실패 · 다시 받기를 다 쓴 실패).
  const waiting = current === null && placeholder && reserved !== null;
  // 빈 칸이 `LABEL_DELAY_MS` 넘게 이어졌는가(M1). 짧은 상태는 투명한 빈 칸 그대로다: 재연결마다 모든 칸이 회색으로 깜빡이지 않는다.
  const [lingering, setLingering] = useState(false);
  useEffect(() => {
    if (!waiting) { setLingering(false); return undefined; }
    const timer = window.setTimeout(() => setLingering(true), LABEL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);
  // 다시 받기를 다 쓴 실패는 늦추지 않고 바로 말한다(M2).
  const exhausted = waiting && failed !== null && failed.exhausted && failed.key === key;
  const labelled = waiting && (lingering || exhausted);
  // 이름 글자가 읽히는 칸이면 `:이름:` 을 칸 위에 얹는다(`LABEL_FIT`). 작은 칸은 정지 자리표시와 `title` 뿐이다.
  const labelFit = LABEL_FIT[size];
  const label = labelled && labelFit !== undefined ? (
    <span aria-hidden="true" data-expression-label="" className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden px-1 text-center text-meta text-ink-muted">
      <span className={labelFit}>{`:${item.name}:`}</span>
    </span>
  ) : null;
  // 큰 칸의 「그림 다시 불러오기」: 정말로 깨진 그림(글자 옆)과 다시 받기를 다 쓴 실패(같은 크기 칸 옆). 오프라인에는 누를 수 없으니 세우지 않는다.
  const offerRetry = size === "large" && !offline && (broken === key || exhausted);
  const image = current ? <img src={current.src} alt={alt} className="expression-image" data-size={size} width={slot?.width} height={slot?.height}
    onLoad={onReady && !still ? () => setPainted(current.key) : undefined}
    onError={() => {
      // 그려지다 깨진 그림도 같다: 지우기가 먼저다(위 효과의 주석).
      if (store && path && heldKey) { kept.current.bytes.delete(heldKey); store.discardImage(path); }
      setFailed({ key: current.key, transient: false, exhausted: false });
    }} />
    : placeholder && reserved ? <canvas role="img" aria-label={alt} className="expression-image" data-size={size} data-expression-placeholder="" width={reserved.width} height={reserved.height} /> : <span>{`:${item.name}:`}</span>;
  return <span ref={root} className="relative inline-block align-middle" data-expression-name={item.name}
    data-expression-lingering={labelled ? "" : undefined} data-expression-failed={exhausted ? "" : undefined}
    title={labelled && labelFit === undefined ? `:${item.name}:` : undefined}>
    {/* 이름 글자는 칸 위에 얹는다(절대 위치). 칸 옆에 단추가 서면 바깥 상자가 단추만큼 넓어지므로, 그때는 칸과 글자를 칸 크기의 상자로 한 번 감싼다. */}
    {label !== null && offerRetry ? <span className="relative inline-block align-middle">{image}{label}</span> : <>{image}{label}</>}
    {/* 멈춘 그림 위에 덮는 단추: <img> 를 단추 안으로 옮기면 노드가 새로 만들어져 깜빡이므로, 그림은 그대로 두고 단추만 얹는다. */}
    {stopped && !still && !reduce && !endless && (
      <button type="button" onClick={() => { setStopped(false); setReplay((value) => value + 1); }} aria-label={`${item.displayName} 다시 재생`} className="absolute inset-0 rounded-sm press focus-visible:focus-ring" />
    )}
    {offerRetry && <button type="button" onClick={() => { retries.current = 0; setFailed(null); setAttempt((value) => value + 1); }} className="ml-2 text-meta text-signal-text underline press focus-visible:focus-ring">그림 다시 불러오기</button>}
  </span>;
}
