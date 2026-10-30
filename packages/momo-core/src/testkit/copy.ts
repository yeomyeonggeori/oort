/** String leaves of an existing copy module, addressed by dotted export keys. */
export type CopyKey<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends readonly unknown[] | ((...args: never[]) => unknown)
      ? never
      : T[K] extends object ? `${K}.${CopyKey<T[K]>}` : never;
}[keyof T & string];

/**
 * Bind an existing module, without copying its sentences into a test catalog.
 * `const copy = createCopy(SCHEDULED_COPY); copy('trigger.label')`
 * Call parameterized copy functions directly; only string leaves are keys.
 */
export function createCopy<T extends object>(catalog: T) {
  return (key: CopyKey<T>): string => {
    let value: unknown = catalog;
    for (const part of key.split('.')) {
      if (value === null || typeof value !== 'object' ||
          !Object.prototype.hasOwnProperty.call(value, part)) {
        throw new Error(`Missing copy key: ${key}`);
      }
      value = (value as Record<string, unknown>)[part];
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Empty or non-string copy: ${key}`);
    }
    return value;
  };
}
