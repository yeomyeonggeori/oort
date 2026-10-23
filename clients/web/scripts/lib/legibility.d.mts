import type { Page } from "playwright";

export function luminance(rgb: readonly number[]): number;
export function contrastOf(a: readonly number[], b: readonly number[]): number;
export function parseRgb(text: string): number[];

export interface Foreground {
  kind: "text" | "icon";
  label: string;
  color: string;
  rect: [number, number, number, number];
}

export function collectForegrounds(page: Page, regionSelector: string): Promise<{ items: Foreground[]; viewportWidth: number }>;
export function dominantColors(helper: Page, png: Buffer, rects: number[][], viewportWidth: number): Promise<number[][]>;

export interface Measured {
  kind: "text" | "icon";
  label: string;
  color: string;
  bg: number[];
  ratio: number;
  min: number;
}

export function measureLegibility(
  page: Page,
  helper: Page,
  regionSelector: string,
  options?: { textMin?: number; iconMin?: number; screenshot?: Buffer }
): Promise<{ png: Buffer; measured: Measured[] }>;
