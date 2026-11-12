export function fixture(run: (
  root: string,
  write: (locale: string, source: string | Record<string, string>) => void,
) => void): void;
export function tamperGenerated(outputRoot: string): void;
export function productFeatures(locale: string): string[] | undefined;
export function writeFeature(root: string, locale: string, feature: string, source: string | Record<string, string>): void;
export function removeLocale(root: string, locale: string): boolean;
