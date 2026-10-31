export function isProductSource(file: string): boolean;
export function extractDirectCopy(file: string, source: string, knownKeys?: string[]): { count: number; unknownKeys: string[] };
export function compareCounts(baseline: Record<string, number>, actual: Record<string, number>): { increases: string[]; decreases: string[] };
export function checkSurface(surface: 'web' | 'mobile'): Record<string, number>;
