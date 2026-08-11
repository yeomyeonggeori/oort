const EXACT_GATE_SCRIPT = "npm run build && node gates/gate-shell-layout.mjs";

/**
 * `gate:shell` may only enter the preview through the package script that
 * rebuilds the current checkout first. An existing dist is not evidence: it
 * may have been produced by a different source tree, as #1314 demonstrated.
 */
export function assertExactSourceGateInvocation({ script, lifecycleEvent }) {
  if (script !== EXACT_GATE_SCRIPT) {
    throw new Error(
      `gate:shell must build the exact source before preview (expected: ${EXACT_GATE_SCRIPT})`
    );
  }
  if (lifecycleEvent !== "gate:shell") {
    throw new Error(
      "gate:shell refuses a potentially stale dist. Run `npm run gate:shell` from clients/web."
    );
  }
}

/**
 * Read the focus contract from the CSS source of truth instead of copying its
 * value into the Playwright gate. The visual rule is relational: the outline
 * is inset by exactly its own width. A positive/outset offset is therefore a
 * contract error even if a fixture and a stale bundle happen to agree on it.
 */
export function parseInsetFocusRingContract(css) {
  const block = css.match(/@utility\s+focus-ring\s*\{(?<body>[^}]*)\}/s)?.groups?.body;
  if (!block) throw new Error("focus-ring utility is missing from tokens.css");

  const width = Number(block.match(/outline:\s*(?<value>\d+(?:\.\d+)?)px\s+solid\b/)?.groups?.value);
  const offset = Number(block.match(/outline-offset:\s*(?<value>-?\d+(?:\.\d+)?)px\s*;/)?.groups?.value);
  if (!Number.isFinite(width) || !Number.isFinite(offset) || width <= 0) {
    throw new Error("focus-ring utility must declare a positive px outline and px offset");
  }
  if (offset !== -width) {
    throw new Error(
      `focus-ring must be inset by its width (outline ${width}px, offset ${offset}px)`
    );
  }

  return {
    outlineWidth: `${width}px`,
    outlineOffset: `${offset}px`,
  };
}

export function matchesInsetFocusRing(measurement, contract) {
  return (
    measurement?.outlineWidth === contract.outlineWidth &&
    measurement?.outlineOffset === contract.outlineOffset
  );
}
