/**
 * Spike #1120 — minimal approval-gate extension.
 *
 * The point is not the extension; it is the *transport*. This is the smallest
 * thing that makes prime-agent emit an `extension_ui_request` on stdout and
 * block until the host answers on stdin — i.e. the exact shape an oort approval
 * card would have to fill (ADR-0125 D6-A host selector, ADR-0154 D5-⑴).
 *
 * Gate: every `ipython` tool call (the harness's only model-facing tool) must
 * be approved. Denial returns `{ block: true }`, which is the harness-side
 * equivalent of our "reject" decision.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("oort-gate", "oort approval gate armed");
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "ipython") return undefined;

		const code = String((event.input as { code?: string }).code ?? "");
		const preview = code.length > 300 ? `${code.slice(0, 300)}…` : code;

		if (!ctx.hasUI) {
			return { block: true, reason: "oort gate: no host UI to approve against" };
		}

		const choice = await ctx.ui.select(`Run ipython cell?\n${preview}`, ["Approve", "Reject"]);
		if (choice !== "Approve") {
			ctx.ui.notify("oort gate: cell rejected", "warning");
			return { block: true, reason: "oort gate: rejected by host" };
		}
		ctx.ui.notify("oort gate: cell approved", "info");
		return undefined;
	});
}
