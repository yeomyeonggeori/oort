export type Surface = 'core' | 'web' | 'mobile';
export interface CopyCount { ko?: number; en?: number; cat?: number }
export interface Raise extends CopyCount { file: string; issue: number; reason: string }
export interface Ledger {
  version: number;
  policy?: string;
  anchorHead: string;
  anchor: Record<string, CopyCount>;
  lowered: Record<string, CopyCount>;
  raises: Raise[];
}
export const LEDGER_PATH: string;
export const LEDGER_VERSION: number;
export const ANCHOR_SEAL: string;
export const DIMENSIONS: readonly ['ko', 'en', 'cat'];
export const POLICY: string;
export const SURFACES: Readonly<Record<Surface, { roots: string[]; files: string[]; english: 'copy' | 'phrase'; exclude?: RegExp }>>;
export function isCopyName(name: string): boolean;
export function isProductSource(file: string): boolean;
export function surfaceOf(file: string): Surface | undefined;
export function extractDirectCopy(file: string, source: string, knownKeys?: string[], options?: { english?: 'copy' | 'phrase' }):
  { ko: number; en: number; cat: number; unknownKeys: string[] };
export function surfaceFiles(surface: Surface, root?: string): string[];
export function scanSurface(surface: Surface, options?: { root?: string; readSource?: (file: string) => string; files?: string[] }):
  { counts: Record<string, Required<CopyCount>>; unknownKeys: string[] };
export function anchorSeal(ledger: Ledger): string;
export function validateLedger(ledger: unknown, options?: { seal?: string }): string[];
export function ceilings(ledger: Ledger): Record<string, Required<CopyCount>>;
export function compareSurface(ledger: Ledger, surface: Surface, counts: Record<string, CopyCount>): { increases: string[]; decreases: string[] };
export function readLedger(path?: string): Ledger;
export function checkSurface(surface: Surface, options?: { root?: string; ledger?: unknown; seal?: string }): Record<string, Required<CopyCount>>;
export function shrinkLedger(ledger: Ledger, counts: Record<string, CopyCount>): { ledger: Ledger; refused: string[] };
export function raiseLedger(ledger: Ledger, file: string, actual: CopyCount | undefined, entry: { issue: number; reason: string }): Ledger;
export function landLedger(base: unknown, ours: unknown, counts: Record<string, CopyCount>):
  { ledger: Ledger; refused: string[]; notes: string[]; carried: number };
export function serializeLedger(ledger: Ledger): string;
