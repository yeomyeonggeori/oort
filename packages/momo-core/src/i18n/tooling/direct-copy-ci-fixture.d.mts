export interface LedgerStepRun { status: number | null; out: string; mergeBase: string }
export function readRepoFile(file: string): string;
export function workflowLedgerStep(workflow?: string): { env: Record<string, string>; script: string; if: string | undefined };
export function runLedgerStepScenario(options?: { workflow?: string }):
  { runs: {
    afterRaise: LedgerStepRun; afterReanchor: LedgerStepRun; notMerge: LedgerStepRun; unraisedCopy: LedgerStepRun;
    reanchorUnlabelled: LedgerStepRun; reanchorLabelled: LedgerStepRun;
  }; u2: string; u3: string };
export function withTempTree<T>(files: Record<string, string>, fn: (root: string) => T): T;
export const ANCHOR_SCENARIO_FILES: Readonly<{ committedKey: string; workingKey: string; subfolderKey: string }>;
export function runAnchorScenario():
  { status: number | null; anchor: Record<string, { ko?: number; en?: number; cat?: number }> | undefined; commit: string; err: string };
