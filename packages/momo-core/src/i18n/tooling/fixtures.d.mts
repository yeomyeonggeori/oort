export function fixture(run: (
  root: string,
  write: (locale: string, source: string | Record<string, string>) => void,
) => void): void;
export function tamperGenerated(outputRoot: string): void;
