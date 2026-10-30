/** Keep renderer ownership in the client; core only tracks mounts for cleanup. */
export function createMount<Args extends unknown[], Mounted>(
  render: (...args: Args) => Mounted,
  unmount: (mounted: Mounted) => void,
) {
  const mounted: Mounted[] = [];
  return {
    mount(...args: Args): Mounted {
      const result = render(...args);
      mounted.push(result);
      return result;
    },
    cleanup(): void {
      while (mounted.length > 0) unmount(mounted.pop()!);
    },
  };
}

/** Real timers only. Fake-clock suites should advance their clock explicitly. */
export function createFlush(act: (work: () => Promise<void>) => Promise<unknown>) {
  return async function flush(rounds = 1): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }
  };
}
