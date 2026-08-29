import { useEffect, useRef } from "react";
import { CLOUD_BODIES } from "./cloudBodies";
import { OortCloudMark } from "./OortCloudMarks";

// Ported from buzz desktop LandingBees.tsx (Apache-2.0): per-body
// incommensurate sine wander, pointer repel, 0.12 ease. Twinkle is CSS
// (HTML layer / compositor), not this rAF loop.

const REPEL_RADIUS = 180;
const REPEL_STRENGTH = 110;
const WANDER_X = 26;
const WANDER_Y = 20;
const EASE = 0.12;

export function OortCloudField() {
  const fieldRef = useRef<HTMLDivElement>(null);
  const bodyRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const offsets = useRef(CLOUD_BODIES.map(() => ({ x: 0, y: 0 })));

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;

    let raf = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const t = (now - start) / 1000;
      const rect = field.getBoundingClientRect();
      const p = pointer.current;
      bodyRefs.current.forEach((el, i) => {
        if (!el) return;
        const body = CLOUD_BODIES[i];
        const phase = i * 1.7;
        const wx =
          Math.sin(t * (0.7 + (i % 5) * 0.13) + phase) * WANDER_X +
          Math.sin(t * 1.9 + phase * 2.1) * 6;
        const wy =
          Math.cos(t * (0.6 + (i % 7) * 0.11) + phase) * WANDER_Y +
          Math.cos(t * 2.3 + phase * 1.3) * 5;
        let rx = 0;
        let ry = 0;
        if (p) {
          const cx = rect.left + (rect.width * body.left) / 100;
          const cy = rect.top + (rect.height * body.top) / 100;
          const ox = cx - p.x;
          const oy = cy - p.y;
          const dist = Math.hypot(ox, oy);
          if (dist < REPEL_RADIUS && dist > 0.01) {
            const push = ((REPEL_RADIUS - dist) / REPEL_RADIUS) * REPEL_STRENGTH;
            rx = (ox / dist) * push;
            ry = (oy / dist) * push;
          }
        }
        const target = { x: wx + rx, y: wy + ry };
        const cur = offsets.current[i];
        cur.x += (target.x - cur.x) * EASE;
        cur.y += (target.y - cur.y) * EASE;
        el.style.setProperty("--onboarding-wander-x", `${cur.x}px`);
        el.style.setProperty("--onboarding-wander-y", `${cur.y}px`);
      });
      raf = requestAnimationFrame(tick);
    };

    const onMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    const onLeave = () => {
      pointer.current = null;
    };

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!reduced.matches) {
      raf = requestAnimationFrame(tick);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseout", onLeave);
    }
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={fieldRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-testid="onboarding-cloud-field"
    >
      {CLOUD_BODIES.map((body, i) => (
        <span
          key={body.index}
          ref={(el) => {
            bodyRefs.current[i] = el;
          }}
          className="onboarding-cloud-body"
          data-onboarding-body={String(body.index)}
          data-onboarding-tone={body.tone}
        >
          <OortCloudMark kind={body.kind} />
        </span>
      ))}
    </div>
  );
}
