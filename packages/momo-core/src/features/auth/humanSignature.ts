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

/** ADR-0146 개정 D-4 원문. */
export const INSTRUCT_IN_APP_LINE = "폰이나 데스크탑 앱에서 보내 주세요";

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
  text: string;
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
      return {
        fix: "use_app",
        text: "이 서버는 허락과 지시에 기기 서명을 받아요. 폰이나 데스크탑 앱에서 보내 주세요.",
      };
    case HUMAN_SIGNATURE_REFUSAL.invalid:
      return {
        fix: "resend",
        text: "기기 서명이 이 요청과 맞지 않아 서버가 받지 않았어요. 앱을 최신으로 올린 뒤 다시 보내 주세요.",
      };
    case HUMAN_SIGNATURE_REFUSAL.expired:
      return {
        fix: "check_clock",
        text: "서명한 시각이 서버 시각과 5분 넘게 어긋나 받지 않았어요. 기기 시계를 자동 맞춤으로 바꾼 뒤 다시 보내 주세요.",
      };
    case HUMAN_SIGNATURE_REFUSAL.nonceReplayed:
      return {
        fix: "check_progress",
        text: "같은 서명이 이미 한 번 쓰였어요. 먼저 보낸 것이 닿았을 수 있으니 진행을 확인하고, 필요하면 다시 눌러 새로 서명해 주세요.",
      };
    case HUMAN_SIGNATURE_REFUSAL.keyRevoked:
      return {
        fix: "register_again",
        text: "이 기기의 서명 키가 해제되어 보낼 수 없어요. 설정 › 기기 › 지시 서명에서 이 기기를 다시 등록해 주세요.",
      };
    case HUMAN_SIGNATURE_REFUSAL.keyNotEndorsed:
      return {
        fix: "approve_on_mac",
        text: "이 기기는 아직 지시 승인을 받지 않았어요. 호스트가 있는 맥의 oort 앱에서 설정 › 기기 › 지시 서명으로 이 기기를 승인해 주세요.",
      };
    case HUMAN_SIGNATURE_REFUSAL.instanceUnconfigured:
      return {
        fix: "ask_admin",
        text: "서버에 인스턴스 id가 설정되지 않아 서명을 확인할 수 없어요. 서버 관리자에게 알려 주세요.",
      };
    default:
      return null;
  }
}
