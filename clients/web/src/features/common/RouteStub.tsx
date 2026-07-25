import type { ReactNode } from "react";

/**
 * A global surface that has its route, its keyboard path and its place in the
 * sidebar, but not yet its data. The copy states what lands here rather than
 * apologising or faking an empty result we never fetched.
 */
export function RouteStub({
  title,
  headline,
  points,
  testId,
}: {
  title: string;
  headline: string;
  points: ReactNode[];
  testId: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid={testId}>
      <header className="border-b border-line px-4 py-2">
        <h1 className="text-body font-semibold">{title}</h1>
      </header>
      <div className="flex flex-col gap-3 px-4 py-6">
        <p className="text-body text-ink">{headline}</p>
        <ul className="flex flex-col gap-2">
          {points.map((point, index) => (
            <li key={index} className="text-body text-ink-muted">
              {point}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
