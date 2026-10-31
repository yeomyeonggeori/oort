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
  const [replay, setReplay] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; src: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // 그려진 <img>의 key. load는 보임보다 먼저 올 수 있고, 동작 줄이기에서는 보임이 바뀌어도 그림 주소(key)가 같아
  // <img>가 다시 만들어지지 않으므로 load가 다시 오지 않는다. 그래서 load는 기록만 하고 신호는 아래 효과가 낸다.
  // 신호를 받는 쪽이 없으면(본문·격자·반응의 그림) load 처리기도 달지 않는다: 줄마다 다시 그리는 비용이 늘지 않는다.
  const [painted, setPainted] = useState<string | null>(null);
  const told = useRef<string | null>(null);
  const variant = still || reduce || !visible || stopped ? "thumb" : size === "large" ? "large" : "small";
  const path = store ? expressionImagePath(store.base, item, variant) : null;
  const key = `${path}:${epoch}:${replay}`;
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
    store.image(path).then((src) => { if (live) setLoaded({ key, src }); }, () => { if (live) setFailed(key); });
    return () => { live = false; };
  }, [store, path, key, offline]);
  useEffect(() => {
    if (!animated || loaded?.key !== key) return;
    // GIF output is encoded for four total plays as well. This deadline switches
    // to the static thumb even on decoders with different loop metadata semantics.
    const timer = window.setTimeout(() => setStopped(true), (item.media?.[variant].durationMs ?? 0) * 4);
    return () => window.clearTimeout(timer);
  }, [animated, loaded, key, item.media, variant]);
  const available = !offline && loaded?.key === key && failed !== key;
  // 사람이 승인 전에 **본** 그림이라는 신호(#4846): 실제로 그려졌고(load) 화면에 있을 때(visible) 한 번만, 둘의 순서와
  // 무관하게 낸다. 안 보이는 그림이나 깨진 그림(error)으로는 풀리지 않는다. 한 key에 한 번(`told`)이라 보임이 흔들려도,
  // 같은 그림이 다시 load돼도 신호는 더 오지 않는다.
  const seen = available && painted === key && !still && visible && (variant === "large" || reduce);
  useEffect(() => {
    if (!seen || told.current === key) return;
    told.current = key;
    onReady?.();
  }, [seen, key, onReady]);
  const image = available ? <img key={key} src={loaded.src} alt={expressionAltText(item as Expression)} className="expression-image" data-size={size}
    onLoad={onReady && !still ? () => setPainted(key) : undefined} onError={() => setFailed(key)} /> : <span>{`:${item.name}:`}</span>;
  return <span ref={root} className="inline-block align-middle" data-expression-name={item.name}>
    {stopped && !still && !reduce && size !== "reaction" ? (
      <button type="button" onClick={() => { setStopped(false); setReplay((value) => value + 1); }} aria-label={`${item.displayName} 다시 재생`} className="rounded-sm press focus-visible:focus-ring">{image}</button>
    ) : image}
    {size === "large" && failed === key && !offline && <button type="button" onClick={() => { setFailed(null); setReplay((value) => value + 1); }} className="ml-2 text-meta text-signal-text underline press focus-visible:focus-ring">그림 다시 불러오기</button>}
  </span>;
}
