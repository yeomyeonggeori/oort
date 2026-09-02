import type { CloudBodyKind } from "./cloudBodies";

// icon-system-exception(ADR-0172): Lucide has no comet / irregular asteroid /
// 4-point sparkle as a single-stroke unfilled line-art set. These three
// glyphs are S0 Oort-cloud scatter only, not functional icons.

/**
 * Line-art Oort-cloud bodies (comet, asteroid, 4-point star). currentColor,
 * one stroke weight, no fill. Path geometry is local; the product mark is
 * OortMark and is not modified here.
 */
export function OortCloudMark({ kind }: { kind: CloudBodyKind }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="block h-full w-full"
      aria-hidden="true"
    >
      {kind === "comet" ? (
        <>
          <circle cx="16.5" cy="7.5" r="3.2" />
          <path d="M13.8 10.2 4.5 19.5" />
          <path d="M14.6 11.8 7 20" />
        </>
      ) : kind === "asteroid" ? (
        <path d="M8.2 4.4 16.8 5.6 20.4 12.2 15.6 20.1 6.4 18.6 3.8 10.8Z" />
      ) : (
        <path d="M12 2.5 13.1 10.9 21.5 12 13.1 13.1 12 21.5 10.9 13.1 2.5 12 10.9 10.9Z" />
      )}
    </svg>
  );
}
