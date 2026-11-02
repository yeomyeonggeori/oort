import type { Page } from "playwright";

/** 툴바가 이웃으로 세는 칸의 선택자(행 + 시스템 줄). */
export const HOVER_TOOLBAR_NEIGHBOR_SELECTOR: string;

export interface HoverToolbarOverlap {
  seq: string | null;
  neighbor: "self" | "prev" | "next" | null;
  kind: "row" | "system-line" | null;
  chars: number;
  area: number;
  sample: string;
  fromTop: number;
  straddle: string;
  looked: Array<{ where: "self" | "prev" | "next"; kind: "row" | "system-line"; seq: string | null }>;
}

export function measureHoverToolbarOverlap(page: Page): Promise<HoverToolbarOverlap[]>;
export function assertHoverToolbarClearsBodyText(page: Page, where: string): Promise<void>;
