export interface LedgerStepRun { status: number | null; out: string; mergeBase: string }
export function readRepoFile(file: string): string;
export function workflowLedgerStep(workflow?: string): { env: Record<string, string>; script: string };
export function runLedgerStepScenario(options?: { workflow?: string }):
  { runs: {
    afterRaise: LedgerStepRun; afterReanchor: LedgerStepRun; notMerge: LedgerStepRun; unraisedCopy: LedgerStepRun;
    reanchorUnlabelled: LedgerStepRun; reanchorLabelled: LedgerStepRun;
  }; u2: string; u3: string };
