import { ApiError } from "../../lib/api";
import { attachDirection } from "../../lib/koreanParticle";
import { maskedBearer } from "./model";
import type {
  ProviderChain,
  ProviderChainEntry,
  ProviderChainEntryInput,
  ProviderChainProbe,
} from "./api";

// =============================================================================
// Pure logic behind 연결 순서 (ADR-0135 D1 / MOMO-627): the fallback-hop draft,
// its validation, and the machine-to-Korean mapping for the cascade probe.
//
// Nothing here touches React or the network, because two rules are easy to get
// wrong by hand and expensive to get wrong in production:
//
//   1. A hop's POSITION is its credential's identity. `PUT /v1/provider/link/chain`
//      keeps the stored bearer of a position when the body omits one, so
//      renumbering a stored row would silently pair its base URL with another
//      provider's key. Stored rows therefore keep the position the server gave
//      them, forever; only brand-new rows are assigned one.
//   2. The person never reads that number. Position is wire vocabulary
//      (design-taste-web §7); what a reader needs is attempt order, and after a
//      middle hop is deleted the two stop agreeing. Every label here is derived
//      from the ORDER of the list, never from `position`.
// =============================================================================

/** `ProviderLinkChainRoutes.maxChainEntries`: fallback hops, head excluded. */
export const MAX_FALLBACK_HOPS = 8;

/** Attempt order as a person counts it: the provider link is 1차. */
export function hopOrdinal(index: number): string {
  return `${index + 1}차`;
}

// ---- wire parsing (total, never throwing) -----------------------------------
//
// This route does not exist on the server yet, so a 200 is not proof of the
// ADR-0135 D1 body: a proxy, a dev catch-all or a later schema can answer
// something else entirely. Reading `entries` straight off such a body threw
// inside render and unmounted the WHOLE 설정 route (measured against
// gate:shell, whose `**/v1/**` catch-all answers `{channels:[],members:[],…}`).
// A panel that cannot read the answer says so; it does not take the settings
// screen down with it.

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function num(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseChainEntry(raw: unknown): ProviderChainEntry | null {
  const source = record(raw);
  if (source === null) return null;
  const position = num(source, "position");
  const baseUrl = str(source, "baseUrl");
  if (position === undefined || !Number.isInteger(position)) return null;
  if (baseUrl === undefined) return null;
  const entry: ProviderChainEntry = {
    position,
    source: str(source, "source") ?? "",
    mode: str(source, "mode") ?? "",
    baseUrl,
    // The label is what every row prints, so a body without one falls back to
    // the address rather than rendering an anonymous row.
    endpointLabel: str(source, "endpointLabel") ?? baseUrl,
    enabled: source["enabled"] !== false,
    bearerConfigured: source["bearerConfigured"] === true,
  };
  const last4 = str(source, "bearerLast4");
  if (last4 !== undefined) entry.bearerLast4 = last4;
  const updatedAtMs = num(source, "updatedAtMs");
  if (updatedAtMs !== undefined) entry.updatedAtMs = updatedAtMs;
  const updatedBy = str(source, "updatedBy");
  if (updatedBy !== undefined) entry.updatedBy = updatedBy;
  return entry;
}

/**
 * The chain body, or null when this answer is not one.
 *
 * `entries` is the field that decides: it must be present and an array.
 *
 * An entry that does not parse is recorded, not merely skipped, and this is the
 * rule the whole panel hangs off. Saving is `PUT` with the FULL list, so a hop
 * that never reached the draft is a hop the next 연결 순서 저장 deletes from the
 * server together with the ciphertext stored at its position. Silently dropping
 * one therefore turns an unreadable field into destroyed configuration, one
 * click later, with nothing on screen having said so. `unreadable` carries the
 * response-order index of every such entry so the panel can refuse to write.
 *
 * `fallbackCount` is ALWAYS recomputed from the rows that parsed, never taken
 * from the body. The server's number counts hops this client may not be able to
 * show, and a summary that says "예비 provider 4개" over three rendered rows is
 * a false claim about the screen the reader is looking at. `attemptableCount`
 * is left ABSENT when the body omits it: zero is not a neutral placeholder, it
 * is the claim "no provider would be tried right now".
 */
export function parseProviderChain(raw: unknown): ProviderChain | null {
  const source = record(raw);
  if (source === null) return null;
  const rawEntries = source["entries"];
  if (!Array.isArray(rawEntries)) return null;
  const entries: ProviderChainEntry[] = [];
  const unreadable: number[] = [];
  rawEntries.forEach((item, index) => {
    const entry = parseChainEntry(item);
    if (entry === null) unreadable.push(index + 1);
    else entries.push(entry);
  });
  const attemptable = num(source, "attemptableCount");
  return {
    schema: str(source, "schema") ?? "",
    entries,
    fallbackCount: entries.filter((entry) => entry.position >= 1).length,
    ...(attemptable === undefined ? {} : { attemptableCount: attemptable }),
    ...(unreadable.length === 0 ? {} : { unreadable }),
  };
}

/**
 * Why this chain may not be written, or null when it may.
 *
 * Names the rows by their place in the server's own answer, because that is the
 * only handle a person has on a row this client could not render: there is no
 * address to point at, which is precisely the problem.
 */
export function chainUnreadableCopy(chain: ProviderChain): string | null {
  const unreadable = chain.unreadable;
  if (unreadable === undefined || unreadable.length === 0) return null;
  const where = unreadable.map((index) => `${index}번째`).join(", ");
  return `이 서버가 보낸 연결 순서에서 ${where} 항목을 읽지 못했습니다. 지금 저장하면 그 항목이 서버에서 지워지므로 저장을 막았습니다. 아래 목록은 읽은 항목만 보여 줍니다. 서버 버전을 확인한 뒤 다시 열어보세요.`;
}

/** Probe hops off the `/test` body. Empty when the server sent none. */
export function parseProbeEntries(raw: unknown): ProviderChainProbe[] {
  if (!Array.isArray(raw)) return [];
  const entries: ProviderChainProbe[] = [];
  for (const item of raw) {
    const source = record(item);
    if (source === null) continue;
    const position = num(source, "position");
    if (position === undefined) continue;
    const entry: ProviderChainProbe = {
      position,
      source: str(source, "source") ?? "",
      mode: str(source, "mode") ?? "",
      endpointLabel: str(source, "endpointLabel") ?? "",
      enabled: source["enabled"] !== false,
      ok: source["ok"] === true,
      disposition: str(source, "disposition") ?? "",
    };
    const reason = str(source, "reason");
    if (reason !== undefined) entry.reason = reason;
    entries.push(entry);
  }
  return entries;
}

/** Copy for a 200 whose body this panel cannot read. */
export const CHAIN_UNREADABLE =
  "이 서버가 보낸 연결 순서 응답을 읽지 못했습니다. 서버 버전을 확인한 뒤 다시 시도하세요.";

// ---- the draft --------------------------------------------------------------

/** One editable fallback hop. `bearer` is write-only and starts empty. */
export interface ChainDraftRow {
  /** Stable React key. Not sent, and not derived from position. */
  key: string;
  /**
   * The server position this row occupies. Assigned once (on load for a stored
   * row, on add for a new one) and never rewritten: see rule 1 above.
   */
  position: number;
  baseUrl: string;
  /** Empty means "keep the key stored at this position". */
  bearer: string;
  mode: string;
  enabled: boolean;
  /** The server holds a key for this position. */
  bearerConfigured: boolean;
  /**
   * Masked tail of the stored key. Independent of `bearerConfigured`: the DTO
   * declares it optional, so a stored key with no tail is a reachable state and
   * the hint has to survive it.
   */
  bearerLast4?: string;
  /** The server has never stored this row, so a key is required to save it. */
  isNew: boolean;
}

/** Fallback hops only: position 0 is the singleton and is not editable here. */
export function fallbackEntries(chain: ProviderChain): ProviderChainEntry[] {
  return chain.entries
    .filter((entry) => entry.position >= 1)
    .sort((a, b) => a.position - b.position);
}

/** The head of the cascade as the server projected it, or null. */
export function headEntry(chain: ProviderChain): ProviderChainEntry | null {
  return chain.entries.find((entry) => entry.position === 0) ?? null;
}

export function draftFromChain(chain: ProviderChain): ChainDraftRow[] {
  return fallbackEntries(chain).map((entry) => ({
    key: `hop-${entry.position}`,
    position: entry.position,
    baseUrl: entry.baseUrl,
    bearer: "",
    mode: entry.mode,
    enabled: entry.enabled,
    bearerConfigured: entry.bearerConfigured,
    ...(entry.bearerLast4 !== undefined
      ? { bearerLast4: entry.bearerLast4 }
      : {}),
    isNew: false,
  }));
}

/**
 * What the key field of one hop says under it.
 *
 * Three different facts, because there are three different states and the panel
 * used to print the first sentence for all of them: `maskedBearer(undefined)`
 * answers "저장된 키 없음", so a stored hop whose DTO carried no tail rendered
 * "저장된 키 저장된 키 없음. 비워 두면 그대로 둡니다.", a sentence that says
 * both things at once and instructs the reader to keep a key it just said does
 * not exist.
 */
export function bearerHint(row: ChainDraftRow): string {
  if (row.isNew) {
    return "입력한 값은 저장 즉시 암호화되며 화면으로 다시 돌아오지 않습니다.";
  }
  if (!row.bearerConfigured) {
    return "이 provider에는 저장된 키가 없습니다. 키를 입력해야 실제로 시도됩니다.";
  }
  if (row.bearerLast4 === undefined) {
    return "키가 저장되어 있습니다. 비워 두면 그대로 둡니다.";
  }
  return `저장된 키 ${maskedBearer(row.bearerLast4)}. 비워 두면 그대로 둡니다.`;
}

/**
 * What the head row can truthfully claim about itself.
 *
 * `ProviderCascade.attemptable` is `enabled && isUsable`, so a head with no key
 * is NOT tried, and "가장 먼저 시도합니다." next to a 키 없음 chip announced an
 * attempt the cascade will not make. `isUsable` only needs a key when the mode
 * actually calls out to a provider, so a mock head keeps the plain sentence: a
 * bundled mock answers turns without one, and telling a self-host default it is
 * inert would be the same kind of false claim in the other direction.
 */
export function headClaim(entry: ProviderChainEntry): string {
  if (!entry.enabled) {
    return "꺼져 있어 시도하지 않습니다. 이 항목은 위의 provider 연결에서 바꿉니다.";
  }
  if (entry.mode === "external-hermes" && !entry.bearerConfigured) {
    return "키가 없어 지금은 시도하지 않습니다. 위의 provider 연결에서 키를 저장하면 가장 먼저 시도합니다.";
  }
  return "가장 먼저 시도합니다. 이 항목은 위의 provider 연결에서 바꿉니다.";
}

/**
 * The position a new hop takes: one past the highest in the draft.
 *
 * Never "length + 1". Delete the first of two hops and the survivor still sits
 * at position 2; handing a new row that same number would make the PUT replace
 * the survivor's row instead of adding one.
 */
export function nextPosition(rows: readonly ChainDraftRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.position), 0) + 1;
}

export function addDraftRow(
  rows: readonly ChainDraftRow[],
  mode = "external-hermes"
): ChainDraftRow[] {
  const position = nextPosition(rows);
  return [
    ...rows,
    {
      key: `new-${position}`,
      position,
      baseUrl: "",
      bearer: "",
      mode,
      enabled: true,
      bearerConfigured: false,
      isNew: true,
    },
  ];
}

export function removeDraftRow(
  rows: readonly ChainDraftRow[],
  key: string
): ChainDraftRow[] {
  return rows.filter((row) => row.key !== key);
}

export function patchDraftRow(
  rows: readonly ChainDraftRow[],
  key: string,
  patch: Partial<Pick<ChainDraftRow, "baseUrl" | "bearer" | "mode" | "enabled">>
): ChainDraftRow[] {
  return rows.map((row) => (row.key === key ? { ...row, ...patch } : row));
}

// ---- validation (mirrors the server, so a save is never a guaranteed 400) ----

/**
 * What is wrong with one row, and WHICH control it is wrong about.
 *
 * The field is carried, not inferred, because one row owns two inputs and a
 * message that lands on the wrong one is worse than no message: "새 provider는
 * 키를 입력해야 저장됩니다." printed under 주소 tells a person to fix the field
 * they already filled in correctly.
 */
export interface DraftRowError {
  field: "baseUrl" | "bearer";
  /**
   * What is wrong. Only ever shown once the person has HAD a turn at the field:
   * after it loses focus, or after they asked to save. A row that was created
   * one keystroke ago has not failed at anything, and painting it red on
   * creation uses the error state as a placeholder (SKILL §5: an error says what
   * happened, and nothing has happened yet).
   */
  message: string;
  /**
   * The same fact as a next action, for before that turn. It goes in the block
   * hint, never on the untouched control, so an empty new row still explains
   * why 연결 순서 저장 is unavailable without accusing the reader of an error.
   */
  next: string;
}

/**
 * What is wrong with one row, or null.
 *
 * The base URL rule is the singleton form's rule verbatim, and the key rule is
 * the server's: `bearer is required for new chain position N`. A stored row
 * with an empty key field is NOT an error, it is the documented way to keep a
 * key the API can never show anyone again.
 */
export function draftRowError(row: ChainDraftRow): DraftRowError | null {
  const url = row.baseUrl.trim();
  if (url === "") {
    return {
      field: "baseUrl",
      message: "provider 주소를 입력하세요.",
      next: "주소를 입력하면",
    };
  }
  if (!/^https?:\/\/.+/.test(url)) {
    return {
      field: "baseUrl",
      message: "주소는 http:// 또는 https:// 로 시작해야 합니다.",
      next: "주소를 http:// 또는 https:// 로 시작하게 고치면",
    };
  }
  if (row.isNew && row.bearer.trim() === "") {
    return {
      field: "bearer",
      message: "새 provider는 키를 입력해야 저장됩니다.",
      next: "키를 입력하면",
    };
  }
  return null;
}

/** Row key to error. Empty when the draft is savable. */
export function draftErrors(
  rows: readonly ChainDraftRow[]
): ReadonlyMap<string, DraftRowError> {
  const errors = new Map<string, DraftRowError>();
  for (const row of rows) {
    const error = draftRowError(row);
    if (error !== null) errors.set(row.key, error);
  }
  return errors;
}

/**
 * Why 연결 순서 저장 is unavailable, said forwards, or null when it is available.
 *
 * The block used to print "위에 표시된 항목을 고쳐야 저장할 수 있습니다." while
 * nothing was displayed above it, because the row errors only appear once the
 * person has touched the field. This names the row instead, by attempt order,
 * and says the one thing left to do.
 */
export function draftBlockedHint(
  rows: readonly ChainDraftRow[],
  errors: ReadonlyMap<string, DraftRowError>
): string | null {
  if (errors.size === 0) return null;
  const index = rows.findIndex((row) => errors.has(row.key));
  const error = index < 0 ? undefined : errors.get(rows[index].key);
  if (error === undefined) return null;
  const first = `${hopOrdinal(index + 1)} provider ${error.next} 저장할 수 있습니다.`;
  if (errors.size === 1) return first;
  return `${first} 채워야 할 항목은 모두 ${errors.size}개입니다.`;
}

/**
 * The PUT body. `bearer` is omitted rather than sent empty when the operator
 * left it alone: an empty string is a value the server would reject, and the
 * absent key is what means "keep the stored one".
 */
export function draftToInput(
  rows: readonly ChainDraftRow[]
): ProviderChainEntryInput[] {
  return rows.map((row) => {
    const bearer = row.bearer.trim();
    return {
      position: row.position,
      baseUrl: row.baseUrl.trim(),
      mode: row.mode,
      enabled: row.enabled,
      ...(bearer === "" ? {} : { bearer }),
    };
  });
}

/** True when the draft differs from what the server last returned. */
export function draftIsDirty(
  rows: readonly ChainDraftRow[],
  chain: ProviderChain
): boolean {
  const stored = fallbackEntries(chain);
  if (stored.length !== rows.length) return true;
  return rows.some((row, index) => {
    const entry = stored[index];
    if (entry === undefined) return true;
    return (
      row.position !== entry.position ||
      row.baseUrl.trim() !== entry.baseUrl ||
      row.mode !== entry.mode ||
      row.enabled !== entry.enabled ||
      row.bearer.trim() !== ""
    );
  });
}

// ---- copy -------------------------------------------------------------------

/**
 * 404 is the live case while the engine ticket lands: this server was built
 * before `/v1/provider/link/chain` existed. Saying so, plus the next step, is a
 * useful sentence where a status code is not, and it must never be shown as an
 * empty chain (which would claim the operator has no fallback configured).
 */
export function chainErrorCopy(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404) {
    return "이 서버는 아직 프로바이더 연결 순서를 제공하지 않습니다. 지금은 위의 provider 하나만 쓰입니다. 서버를 업데이트한 뒤 다시 열어보세요.";
  }
  return null;
}

/**
 * The unsaved-changes line, which has to name the reason it cannot be acted on.
 *
 * Offline is the case that contradicted itself: `canSave` is false while the
 * rail is down, so "연결 순서 저장을 눌러야 적용됩니다." instructed a person to
 * press a button that does nothing. The route banner does say why, but it sits
 * at the top of a panel this block is at the FOOT of, so by the time the hint
 * is read the explanation has scrolled off screen.
 */
export function chainDirtyHint(offline: boolean): string {
  return offline
    ? "아직 저장되지 않았습니다. 지금은 서버에 연결되어 있지 않아 저장할 수 없고, 연결이 돌아오면 연결 순서 저장을 누르세요."
    : "아직 저장되지 않았습니다. 연결 순서 저장을 눌러야 적용됩니다.";
}

/** Save failures the operator can act on, from the server's own 400 rules. */
export function chainSaveMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return "이 서버는 아직 프로바이더 연결 순서를 저장할 수 없습니다. 서버를 업데이트한 뒤 다시 시도하세요.";
    }
    if (error.status === 400) {
      return `서버가 이 연결 순서를 받지 않았습니다. 서버가 보고한 사유: ${error.message}`;
    }
    if (error.status === 403) {
      return "provider 연결은 이 서버의 운영자만 바꿀 수 있습니다.";
    }
  }
  return "연결 순서를 저장하지 못했습니다. 잠시 뒤에 다시 시도하세요.";
}

/**
 * What the chain does right now, in one line.
 *
 * Every number here has to be one the rows below it support. `fallbackCount` is
 * recomputed from those rows by the parser for that reason, and a chain with an
 * unreadable entry gets NO count at all: both counts would then describe hops
 * the reader cannot see, and the panel is already saying it could not read them.
 *
 * `attemptableCount` is the server's own number (enabled AND usable), so a
 * chain whose second hop is parked or half-written says how many providers a
 * turn would really try instead of counting rows on screen.
 *
 * The two numbers count DIFFERENT things and the sentence has to admit it:
 * `fallbackCount` excludes position 0 (`entries.count - 1`) and
 * `attemptableCount` includes it (`ProviderCascade.attemptable` filters the
 * whole plan). Saying "예비 2개, 시도되는 경로 2개" next to a row chipped 꺼둠
 * reads as "both fallbacks are live", which is the opposite of what happened.
 *
 * A body that omits the attemptable count gets the first sentence only. The
 * clause is dropped, never filled with a zero: this parser exists because a
 * non-contract 200 is possible, and inventing "시도되는 경로는 0개" out of a
 * missing key would be exactly the false claim it was written to prevent.
 */
export function chainSummary(chain: ProviderChain): string {
  if (chain.unreadable !== undefined && chain.unreadable.length > 0) {
    return "이 서버가 보낸 항목 중 일부를 읽지 못해, 예비 provider가 몇 개인지 말할 수 없습니다.";
  }
  const fallbacks = chain.fallbackCount;
  if (fallbacks === 0) {
    return "예비 provider가 없습니다. 첫 provider가 응답하지 않으면 그 실행은 실패합니다.";
  }
  const attemptable = chain.attemptableCount;
  if (attemptable === undefined) {
    return `예비 provider ${fallbacks}개를 두었습니다.`;
  }
  return `예비 provider ${fallbacks}개. 첫 provider까지 합쳐 지금 실제로 시도되는 경로는 ${attemptable}개입니다.`;
}

// ---- probe results ----------------------------------------------------------

export type ProbeTone = "ok" | "warn" | "danger" | "muted";

export interface ProbeRow {
  /** Attempt-order label, derived from list order (never from `position`). */
  ordinal: string;
  endpointLabel: string;
  tone: ProbeTone;
  /** Short status word for the chip. */
  label: string;
  /** What a real turn would do with this outcome, in a full sentence. */
  detail: string;
}

/**
 * `ProviderLinkRoutes.probeHop`'s answer for a hop whose mode is not
 * `external-hermes`. It is NOT a failure and it is not the operator's problem:
 * the probe declined to call anything, because there is no external provider to
 * call. It arrives as `disposition: propagate` only because a mock mode is a
 * configuration fact rather than an outage, and reading that as "여기서 멈춤"
 * turns the self-host default into a red row that claims a broken instance.
 */
const MOCK_MODE_REASON = "not_external_provider";

/** Switched on and pointing at a real provider, so the probe actually called it. */
function wasProbed(entry: ProviderChainProbe): boolean {
  return (
    entry.enabled &&
    entry.disposition !== "skipped" &&
    entry.reason !== MOCK_MODE_REASON
  );
}

/** Switched on, but in a mock mode, so nothing was called and nothing is known. */
function isMockMode(entry: ProviderChainProbe): boolean {
  return (
    entry.enabled &&
    entry.disposition !== "skipped" &&
    entry.reason === MOCK_MODE_REASON
  );
}

/**
 * `disposition` to plain Korean.
 *
 * The cases are not shades of failure, they are different answers, and only one
 * of them is the operator's problem right now:
 *   ok         the turn would be served here;
 *   fall_over  a provider-side outage: the cascade moves on, as designed;
 *   propagate  a caller/config error: nothing downstream will fix it;
 *   skipped    the operator parked this hop themselves;
 *   목 모드      nothing was called, so nothing was measured (see above).
 *
 * The reason sentence leads, and the consequence follows it. The old order put
 * a fixed "응답하지 않아" in front of every fall_over, which contradicted itself
 * the moment the reason was 429 or 503: the provider DID answer, it answered
 * with a refusal ("응답하지 않아 다음 provider로 넘어갑니다. provider가 503으로
 * 답했습니다." was on screen).
 */
function dispositionCopy(entry: ProviderChainProbe): {
  tone: ProbeTone;
  label: string;
  detail: string;
} {
  if (entry.disposition === "ok") {
    return {
      tone: "ok",
      label: "응답함",
      detail: "이 provider가 지금 실행을 처리합니다.",
    };
  }
  if (entry.disposition === "skipped") {
    return {
      tone: "muted",
      label: "꺼둠",
      detail: "꺼져 있어 시도하지 않습니다.",
    };
  }
  if (entry.reason === MOCK_MODE_REASON) {
    return {
      tone: "muted",
      label: "목 모드",
      // States what the probe did, and stops. Whether the mock answers a real
      // turn is a different question this check never asked.
      detail:
        "모드가 목으로 되어 있어 이번 확인에서는 실제 provider를 부르지 않았습니다.",
    };
  }
  const reason = probeReasonCopy(entry.reason);
  if (entry.disposition === "fall_over") {
    return {
      tone: "warn",
      label: "다음으로 넘어감",
      detail: `${reason} 다음 provider로 넘어갑니다.`,
    };
  }
  return {
    tone: "danger",
    label: "여기서 멈춤",
    detail: `${reason} 다음 provider로 넘겨도 같은 이유로 실패하므로 여기서 멈춥니다.`,
  };
}

/**
 * The probe's machine reason in plain Korean.
 *
 * `provider_status_<code>` is generated by the classifier, so it is matched by
 * shape. Anything unmapped is named as the server's own report rather than
 * printed bare, the same rule `providerTestMessage` follows.
 *
 * The status code takes its particle from how the number is SPOKEN, not from a
 * fixed 로. "provider가 503로 답했습니다." was on screen, and it is wrong for
 * every code closing on 0, 3 or 6 (영/삼/육), which is the set an operator meets
 * most: 500, 503, 400, 403, 406. See lib/koreanParticle.directionParticle.
 */
export function probeReasonCopy(reason: string | undefined): string {
  if (reason === undefined || reason === "") return "";
  if (reason === "hop_disabled") return "";
  if (reason === "not_external_provider") {
    return "모드가 목으로 되어 있어 실제 provider를 부르지 않습니다.";
  }
  if (reason === "provider_not_configured") {
    return "주소나 키가 비어 있습니다.";
  }
  // 401/403 from `ProviderCascadeClassifier`, and the single most common
  // operator mistake on this panel: a key that was pasted wrong or has been
  // rotated away. It was falling through to the machine label.
  if (reason === "provider_auth_failed") {
    return "provider가 저장된 키를 받아들이지 않았습니다.";
  }
  if (reason === "provider_unreachable") {
    return "주소에 닿지 못했습니다.";
  }
  if (reason === "provider_rate_limited") {
    return "요청 한도를 넘었습니다.";
  }
  if (reason === "probe_not_run") {
    return "확인이 끝나지 않았습니다.";
  }
  const status = /^provider_status_(\d{3})$/.exec(reason);
  if (status) return `provider가 ${attachDirection(status[1])} 답했습니다.`;
  return `서버가 보고한 사유: ${reason}`;
}

/** One row per probed hop, in attempt order. */
export function probeRows(entries: readonly ProviderChainProbe[]): ProbeRow[] {
  return entries.map((entry, index) => {
    const copy = dispositionCopy(entry);
    return {
      ordinal: hopOrdinal(index),
      endpointLabel: entry.endpointLabel,
      tone: copy.tone,
      label: copy.label,
      detail: copy.detail.trim(),
    };
  });
}

/** The headline over the probe rows, with the tone it has to be drawn in. */
export interface ProbeSummary {
  tone: ProbeTone;
  text: string;
}

/**
 * The headline over the probe rows.
 *
 * `cascadeOk` is the server's own answer to "can this instance serve a turn at
 * all", so the serving case states that and not a count the client re-derived.
 * A chain whose head failed but whose second hop answered is a WORKING
 * instance, and saying otherwise would send an operator to fix a provider that
 * is doing exactly what the cascade is for.
 *
 * The counts are over hops that were ACTUALLY CALLED, which is neither
 * `entries.length` nor `cascadeOk`. Two kinds of row were never called and must
 * not be counted as evidence of anything:
 *
 *   * a parked hop, which the operator switched off themselves;
 *   * a hop in a mock mode, which `probeHop` declines to call outright.
 *
 * The second one is the reason this function was rewritten. A default self-host
 * instance runs `local-mock`, so its only hop answers `not_external_provider`,
 * and "확인한 provider 1개 중 응답한 곳이 없습니다. 지금은 실행이 실패합니다."
 * was a false statement about an instance whose turns succeed (the mock answers
 * them). Nothing was checked there, so nothing is asserted: the headline says
 * the check found no real provider to call, and stops.
 */
export function cascadeProbeSummary(
  cascadeOk: boolean,
  entries: readonly ProviderChainProbe[]
): ProbeSummary {
  const probed = entries.filter(wasProbed);
  const answered = probed.filter((entry) => entry.ok).length;
  const first = entries.findIndex((entry) => entry.ok);
  // `cascadeOk` is the server's own `entries.contains { $0.ok }`, so the two
  // agree on a healthy server. They are still read independently: naming a hop
  // this client cannot find would print "0차", and a flag without a matching
  // row is the one case where the rows are the more trustworthy answer.
  if (cascadeOk && first >= 0) {
    return {
      tone: "ok",
      text: `${hopOrdinal(first)} provider가 응답했습니다. 확인한 ${probed.length}개 중 ${answered}개가 응답합니다.`,
    };
  }
  const mocked = entries.filter(isMockMode).length;
  if (probed.length === 0) {
    return mocked > 0
      ? {
          tone: "muted",
          text: "확인할 수 있는 실제 provider가 없습니다. 모드가 목으로 되어 있어 이번 확인은 어디에도 요청하지 않았습니다.",
        }
      : {
          tone: "warn",
          text: "켜져 있는 provider가 없습니다. 하나 이상 켜야 실행할 수 있습니다.",
        };
  }
  if (mocked > 0) {
    return {
      tone: "warn",
      text: `확인한 provider ${probed.length}개 중 응답한 곳이 없습니다. 목 모드 provider는 이번 확인에서 부르지 않았습니다.`,
    };
  }
  return {
    tone: "warn",
    text: `확인한 provider ${probed.length}개 중 응답한 곳이 없습니다. 지금은 실행이 실패합니다.`,
  };
}
