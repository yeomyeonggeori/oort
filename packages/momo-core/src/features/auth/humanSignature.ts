import type { PlainMessageKey } from "../../i18n/keys";

// =============================================================================
// Who may instruct from where, and device-signature refusals in sentences
// (ADR-0146 개정 2026-09-28 D-4 · D-10 · D-11; #3029 E9, #3023 E3 인계).
//
// Pure: no network. The flag comes from `fetchHumanControlSignatureRequired`
// (`deviceKeys.ts`), the surface from the client (Tauri shell or not).
// =============================================================================

/**
 * Where an allow or an instruction can be sent from (ADR-0146 개정 D-4).
 *
 * - `here`: this surface sends it as today.
 * - `app`: an ordinary browser on a server that requires a signature. The
 *   browser never signs (D-4), so the allow button and the instruction box say
 *   「폰이나 데스크탑 앱에서 보내 주세요」 instead. Reject and stop stay here.
 *
 * The desktop shell's webview is never `app`: it has the signing commands, and
 * wiring the cards to them is E8 (#3028). An unknown flag is `here` (D-11).
 * The permission card and the reply box read this ONE value.
 */
export type InstructFrom = "here" | "app";

export function instructFrom(input: {
  desktopShell: boolean;
  signatureRequired: boolean | null;
}): InstructFrom {
  if (input.desktopShell) return "here";
  return input.signatureRequired === true ? "app" : "here";
}

/** ADR-0146 개정 D-4 원문(문장은 사전에 있다). */
export const INSTRUCT_IN_APP_KEY = "auth.humanSignatureInApp.instruct" satisfies PlainMessageKey;
/** 브라우저의 허락 카드와 지시 칸이 그 문장을 넣어 말하는 한 줄씩(이어 붙이지 않고 문장째 키다). */
export const ALLOW_IN_APP_KEY = "auth.humanSignatureInApp.allow" satisfies PlainMessageKey;
export const REPLY_IN_APP_KEY = "auth.humanSignatureInApp.reply" satisfies PlainMessageKey;

// ---- device-signature refusals, in sentences (#3023 E3 → #3029) -------------

/** The named refusals of a signed allow or instruction (E3 golden). */
export const HUMAN_SIGNATURE_REFUSAL = {
  required: "device_signature_required",
  invalid: "device_signature_invalid",
  expired: "device_signature_expired",
  nonceReplayed: "device_nonce_replayed",
  keyRevoked: "device_key_revoked",
  keyNotEndorsed: "device_key_not_endorsed",
  instanceUnconfigured: "instance_id_unconfigured",
} as const;

/** What the person does next. The sentence says it; the tag lets a surface add a button. */
export type HumanSignatureFix =
  | "use_app"
  | "resend"
  | "check_clock"
  | "check_progress"
  | "register_again"
  | "approve_on_mac"
  | "ask_admin";

/**
 * No `closed` here on purpose: a signature refusal never closes the request.
 * The allow was refused, the request is still open, and a reject (which is
 * never signed) still goes through, so a card keeps its buttons.
 */
export interface HumanSignatureRefusal {
  fix: HumanSignatureFix;
  /** 해요체 한 문장의 키. 화면이 그릴 때 지금 언어로 푼다. */
  key: PlainMessageKey;
}

/**
 * A device-signature refusal as one 해요체 sentence with its next action, or
 * `null` when the error is not one. Reads `code` only (the server's message may
 * be reworded) and never shows the code itself.
 */
export function humanSignatureRefusal(error: unknown): HumanSignatureRefusal | null {
  const code =
    typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
  switch (code) {
    case HUMAN_SIGNATURE_REFUSAL.required:
      return { fix: "use_app", key: "auth.signatureRefusal.required" };
    case HUMAN_SIGNATURE_REFUSAL.invalid:
      return { fix: "resend", key: "auth.signatureRefusal.invalid" };
    case HUMAN_SIGNATURE_REFUSAL.expired:
      return { fix: "check_clock", key: "auth.signatureRefusal.expired" };
    case HUMAN_SIGNATURE_REFUSAL.nonceReplayed:
      return { fix: "check_progress", key: "auth.signatureRefusal.nonceReplayed" };
    case HUMAN_SIGNATURE_REFUSAL.keyRevoked:
      return { fix: "register_again", key: "auth.signatureRefusal.keyRevoked" };
    case HUMAN_SIGNATURE_REFUSAL.keyNotEndorsed:
      return { fix: "approve_on_mac", key: "auth.signatureRefusal.keyNotEndorsed" };
    case HUMAN_SIGNATURE_REFUSAL.instanceUnconfigured:
      return { fix: "ask_admin", key: "auth.signatureRefusal.instanceUnconfigured" };
    default:
      return null;
  }
}
