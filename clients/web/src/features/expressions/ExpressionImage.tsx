import { expressionImagePath } from "./media";
import { useEffect, useRef, useState } from "react";
import { expressionAltText } from "@momo/core/features/expressions/message";
import type { Expression, ExpressionDraft } from "@momo/core/features/expressions/types";
import { useExpressions } from "./context";

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

/** All images enter through the authenticated transport, including draft previews. */
export function ExpressionImage({ item, size = "inline", still = false, onReady }: {
  item: Expression | ExpressionDraft;
  size?: "large" | "medium" | "inline" | "reaction";
  still?: boolean;
  onReady?: () => void;
}) {
  const { store, epoch, offline } = useExpressions();
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
  const [failed, setFailed] = useState<string | null>(null);
  // 그려진 <img>의 key. load는 보임보다 먼저 올 수 있고, 동작 줄이기에서는 보임이 바뀌어도 그림 주소(key)가 같아
  // <img>가 다시 만들어지지 않으므로 load가 다시 오지 않는다. 그래서 load는 기록만 하고 신호는 아래 효과가 낸다.
  // 신호를 받는 쪽이 없으면(본문·격자·반응의 그림) load 처리기도 달지 않는다: 줄마다 다시 그리는 비용이 늘지 않는다.
  const [painted, setPainted] = useState<string | null>(null);
  const told = useRef<string | null>(null);
  // 이 칸이 이미 받은 바이트(같은 문자열을 가리킬 뿐 복사하지 않는다). 다시 재생·멈춤·보임 전환이 저장소의 96칸 캐시가 밀려나도 요청을 내지 않게 한다.
  const kept = useRef<{ epoch: number; bytes: Map<string, string> }>({ epoch: 0, bytes: new Map() });
  const fullVariant = size === "large" ? "large" : "small";
  const variant = still || reduce || !visible || stopped ? "thumb" : fullVariant;
  const path = store ? expressionImagePath(store.base, item, variant) : null;
  const key = `${path}:${epoch}:${replay}:${attempt}`;
  // 같은 자리에 다른 표현이 오는 경우(본문 편집으로 같은 순서의 토큰이 바뀐다)에 앞 표현의 그림을 대신 걸어 두지 않으려고 걸린 그림에 주인(그림 주소에서 쿼리를 뺀 앞부분: 표현 id·초안 id 가 든다)을 적는다.
  const owner = path?.split("?")[0] ?? "";
  const animated = variant !== "thumb" && item.media?.[variant].mime === "image/gif";
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
    const held = bytes.get(path);
    const source = held !== undefined ? Promise.resolve(held) : store.image(path).then((src) => { bytes.set(path, src); return src; });
    source.then((src) => decoded(animated ? replayUrl(src, replay) : src)).then(
      (src) => { if (live) setShown({ key, epoch, owner, src }); },
      () => { if (live) setFailed(key); },
    );
    return () => { live = false; };
  }, [store, path, key, offline, epoch, owner, animated, replay]);
  // 걸린 그림이 지금 보여도 되는 그림인가: 이 표현의 것이고, 같은 세대의 것이고, 오프라인이 아니고, 이 표현에 아직 그림이 있고, 깨지지 않았다.
  const current = shown && shown.owner === owner && shown.epoch === epoch && !offline && path !== null && failed !== shown.key ? shown : null;
  // 걸린 그림이 지금 바라는 그림(key)이기도 한가. 아니면 바라는 그림을 준비하는 동안 앞 그림이 대신 걸려 있는 것이다.
  const available = current !== null && current.key === key;
  const playing = animated && available;
  useEffect(() => {
    if (!playing) return;
    // GIF output is encoded for four total plays as well. This deadline switches
    // to the static thumb even on decoders with different loop metadata semantics.
    const timer = window.setTimeout(() => setStopped(true), (item.media?.[variant].durationMs ?? 0) * 4);
    return () => window.clearTimeout(timer);
  }, [playing, key, item.media, variant]);
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
  // 아직 못 받았을 뿐 깨지지 않았다면 글자 자리표시 대신 같은 크기의 빈 칸을 세운다(받는 동안 글자 폭만큼 줄이 뛰지 않게). 깨졌거나 오프라인이면 글자다.
  const own = item.media?.[variant];
  const loading = !offline && path !== null && failed !== key && failed !== shown?.key && own !== undefined;
  const reserved = slot ?? (own ? { width: own.width, height: own.height } : null);
  const image = current ? <img src={current.src} alt={expressionAltText(item as Expression)} className="expression-image" data-size={size} width={slot?.width} height={slot?.height}
    onLoad={onReady && !still ? () => setPainted(current.key) : undefined} onError={() => setFailed(current.key)} />
    : loading && reserved ? <canvas aria-hidden="true" className="expression-image" data-size={size} width={reserved.width} height={reserved.height} /> : <span>{`:${item.name}:`}</span>;
  return <span ref={root} className="relative inline-block align-middle" data-expression-name={item.name}>
    {image}
    {/* 멈춘 그림 위에 덮는 단추: <img> 를 단추 안으로 옮기면 노드가 새로 만들어져 깜빡이므로, 그림은 그대로 두고 단추만 얹는다. */}
    {stopped && !still && !reduce && size !== "reaction" && (
      <button type="button" onClick={() => { setStopped(false); setReplay((value) => value + 1); }} aria-label={`${item.displayName} 다시 재생`} className="absolute inset-0 rounded-sm focus-visible:focus-ring" />
    )}
    {size === "large" && failed === key && !offline && <button type="button" onClick={() => { setFailed(null); setAttempt((value) => value + 1); }} className="ml-2 text-meta text-signal-text underline press focus-visible:focus-ring">그림 다시 불러오기</button>}
  </span>;
}
