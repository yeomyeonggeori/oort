export const CAPTURE_LOCALE: string;
export function withCaptureLocale<T extends object>(options?: T, locale?: string): T & { locale: string };
