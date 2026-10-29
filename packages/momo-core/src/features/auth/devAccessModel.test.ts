import { describe, expect, it } from "vitest";
import {
  buildCreateDevCredentialBody,
  DEV_READ_SCOPES,
  DEV_READ_WRITE_SCOPES,
  DEV_TOOLS,
  type DevAccessFailure,
  type DevAccessFailureKind,
  type DevAccessPolicy,
  type DevCredential,
  type DevTool,
} from "./devAccess";
import {
  commandTabsFor,
  DEV_CARD_LIMIT,
  DEV_CHANNEL_ONLY_LABEL,
  DEV_CHANNEL_RESTRICTION_COPY,
  DEV_COMMANDS_UNAVAILABLE_TEXT,
  DEV_DEFAULT_PRESET,
  DEV_EXPIRY_CHOICES,
  DEV_EXPIRY_DEFAULT_DAYS,
  DEV_EXPIRY_MAX_DAYS,
  DEV_LIST_SCOPE_LABELS,
  DEV_NOTICES,
  DEV_ONE_TIME_COPY,
  DEV_PRESETS,
  DEV_TOOL_CHOICES,
  defaultDevCredentialName,
  devAccessErrorText,
  devAccessGate,
  devCommandOptions,
  devCredentialRow,
  devExpiry,
  devExpiryChoiceLabel,
  devScopeDetail,
  devScopeKind,
  devScopeLabel,
  devScopeName,
  devToolLabel,
  isOwnDevCredential,
  OORT_CLI_VERIFIED,
  retryAfterPhrase,
  validateChannelSelection,
  validateDevName,
  validateExpiryDays,
  validatePassword,
  type DevAccessAction,
  type DevCommandContext,
  type DevCommandOption,
} from "./devAccessModel";

// #4663: the developer access model (ADR-0216 D2 to D10). Pure: nothing here touches the
// network, a clock or a DOM. People and ids are made up.

const WS = "019f9b10-0000-7000-8000-00000000a001";
const DOHYUN = "019f9b10-0000-7000-8000-00000000b001";
const SEOYEON = "019f9b10-0000-7000-8000-00000000b002";

/** The five scopes in the order the server stores them (`DevScope` order). */
const READ_WRITE_SERVER_ORDER = [
  "dev:identity",
  "dev:channels:read",
  "dev:messages:read",
  "dev:messages:write",
  "dev:inbox:read",
];

/** A local calendar time, so the expectations hold in any time zone. */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month, day, hour, minute).getTime();
}

const NOW = at(2026, 9, 28, 14, 30);
const DAY = 86_400_000;

const CARD: DevCredential = {
  id: "019f9b10-0000-7000-8000-00000000c001",
  memberId: DOHYUN,
  kind: "card",
  name: "이도현 노트북 Claude Code",
  tool: "claude_code",
  scopes: [...DEV_READ_SCOPES],
  channelRestricted: false,
  createdAtMs: NOW - 10 * DAY,
  lastUsedAtMs: NOW - 3 * DAY,
  expiresAtMs: NOW + 20 * DAY,
};

const SESSION: DevCredential = {
  id: "019f9b10-0000-7000-8000-00000000c002",
  memberId: SEOYEON,
  kind: "session",
  name: "oort CLI · macOS",
  scopes: [...DEV_READ_WRITE_SCOPES],
  channelRestricted: true,
  deviceName: "oort CLI · macOS",
  createdAtMs: NOW - 2 * DAY,
  expiresAtMs: NOW + 28 * DAY,
  lineageExpiresAtMs: NOW + 88 * DAY,
};

const ALL_ACTIONS: DevAccessAction[] = ["policy", "list", "create", "revoke"];
const ALL_FAILURES: DevAccessFailureKind[] = [
  "password_incorrect",
  "password_unavailable",
  "access_denied",
  "limit",
  "rate_limited",
  "busy",
  "invalid",
  "unauthorized",
  "forbidden",
  "not_found",
  "network",
  "unknown",
];

describe("scope presets and labels", () => {
  it("offers read-only first and as the default, then read and send", () => {
    expect(DEV_PRESETS.map((preset) => preset.id)).toEqual(["read", "read_write"]);
    expect(DEV_DEFAULT_PRESET).toBe(DEV_PRESETS[0]?.id);
    expect(DEV_PRESETS.map((preset) => preset.label)).toEqual(["읽기만", "읽기 + 보내기"]);
  });

  it("describes the same scopes the create body sends for each preset", () => {
    const base = { name: "x", tool: "cli" as const, currentPassword: "p" };
    const read = DEV_PRESETS.find((preset) => preset.id === "read");
    const write = DEV_PRESETS.find((preset) => preset.id === "read_write");
    // Read-only sends no scopes, and the server then grants exactly the read set.
    expect(buildCreateDevCredentialBody({ ...base, preset: "read" }).scopes).toBeUndefined();
    expect(read?.scopes).toEqual(DEV_READ_SCOPES);
    expect(buildCreateDevCredentialBody({ ...base, preset: "read_write" }).scopes).toEqual(write?.scopes);
  });

  it("names a stored list by its set, whatever the order and repeats", () => {
    expect(devScopeLabel([...DEV_READ_SCOPES], false)).toBe("읽기만");
    expect(devScopeLabel([...DEV_READ_SCOPES].reverse(), false)).toBe("읽기만");
    expect(devScopeLabel([...DEV_READ_SCOPES, "dev:identity"], false)).toBe("읽기만");
    // The server stores `dev:messages:write` before `dev:inbox:read`, not in the order a client sends.
    expect(devScopeLabel(READ_WRITE_SERVER_ORDER, false)).toBe("읽기 + 보내기");
    expect(devScopeLabel([...DEV_READ_WRITE_SCOPES], false)).toBe("읽기 + 보내기");
    expect(devScopeKind(READ_WRITE_SERVER_ORDER)).toBe("read_write");
    expect(devScopeKind([...DEV_READ_SCOPES])).toBe("read");
  });

  it("adds the channel limit to the line", () => {
    expect(devScopeLabel([...DEV_READ_SCOPES], true)).toBe(`읽기만 · ${DEV_CHANNEL_ONLY_LABEL}`);
    expect(devScopeLabel(READ_WRITE_SERVER_ORDER, true)).toBe(`읽기 + 보내기 · ${DEV_CHANNEL_ONLY_LABEL}`);
  });

  it("says plainly when a list is neither preset, and never borrows a preset's name", () => {
    const custom = ["dev:identity", "dev:inbox:read"];
    expect(devScopeKind(custom)).toBe("custom");
    expect(devScopeLabel(custom, false)).not.toBe("읽기만");
    expect(devScopeLabel(custom, false)).not.toBe("읽기 + 보내기");
    // A preset plus a name this client cannot read is not that preset.
    expect(devScopeKind([...DEV_READ_SCOPES, "dev:future:admin"])).toBe("custom");
    // Read and send with one read scope missing is neither preset.
    expect(devScopeKind(DEV_READ_WRITE_SCOPES.filter((scope) => scope !== "dev:channels:read"))).toBe(
      "custom"
    );
    expect(devScopeKind([])).toBe("custom");
  });

  it("spells out every power of a custom list, and an unknown name as unknown", () => {
    const detail = devScopeDetail(["dev:identity", "dev:messages:write", "dev:future:admin"]);
    expect(detail).toContain(devScopeName("dev:identity"));
    expect(detail).toContain(devScopeName("dev:messages:write"));
    expect(detail).toContain(devScopeName("dev:future:admin"));
    expect(devScopeName("dev:future:admin")).not.toBe(devScopeName("dev:identity"));
    expect(new Set(["dev:identity", "dev:channels:read", "dev:messages:read", "dev:messages:write", "dev:inbox:read"].map(devScopeName)).size).toBe(5);
  });
});

describe("tools", () => {
  it("labels the four tools, and offers the first three", () => {
    expect(devToolLabel("claude_code")).toBe("Claude Code");
    expect(devToolLabel("codex")).toBe("Codex");
    expect(devToolLabel("cli")).toBe("직접 명령");
    expect(devToolLabel("other")).toBe("기타");
    expect(DEV_TOOL_CHOICES).toEqual(["claude_code", "codex", "cli"]);
    expect(DEV_TOOL_CHOICES).not.toContain("other");
  });

  it("starts the name field with the tool's own name, never an invented device name", () => {
    for (const tool of DEV_TOOLS) expect(defaultDevCredentialName(tool)).toBe(devToolLabel(tool));
  });
});

describe("expiry", () => {
  it("defaults to 30 days and tops out at 90, with choices inside that range", () => {
    expect(DEV_EXPIRY_DEFAULT_DAYS).toBe(30);
    expect(DEV_EXPIRY_MAX_DAYS).toBe(90);
    expect(DEV_EXPIRY_CHOICES).toContain(30);
    expect(DEV_EXPIRY_CHOICES.every((days) => days >= 1 && days <= 90)).toBe(true);
    expect(devExpiryChoiceLabel(30)).toBe("30일");
  });

  it.each<[string | number, number]>([
    ["30", 30],
    [" 7 ", 7],
    ["1", 1],
    ["90", 90],
    [45, 45],
    ["007", 7],
  ])("accepts %j as %i days", (raw, days) => {
    expect(validateExpiryDays(raw)).toEqual({ ok: true, value: days });
  });

  it.each<[string | number]>([[""], ["   "], ["abc"], ["1.5"], ["-3"], ["+5"], ["0"], [0], [1.5], [-1], [Number.NaN], [Infinity], ["9e1"]])(
    "refuses %j with a sentence",
    (raw) => {
      const result = validateExpiryDays(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
    }
  );

  it("tells a value over the maximum apart from a value that is not a number", () => {
    const over = validateExpiryDays("91");
    const word = validateExpiryDays("abc");
    expect(over.ok).toBe(false);
    expect(word.ok).toBe(false);
    if (!over.ok && !word.ok) {
      expect(over.message).toContain("90");
      expect(over.message).not.toBe(word.message);
    }
    expect(validateExpiryDays(100_000).ok).toBe(false);
  });

  it("says 오늘 until midnight, then counts local calendar days", () => {
    expect(devExpiry(at(2026, 9, 28, 23, 59), NOW)).toEqual({ label: "오늘", expired: false });
    expect(devExpiry(NOW + 1, NOW)).toEqual({ label: "오늘", expired: false });
    // About ten hours away, but tomorrow on the calendar.
    expect(devExpiry(at(2026, 9, 29, 0, 30), NOW)).toEqual({ label: "1일 뒤", expired: false });
    expect(devExpiry(at(2026, 10, 27, 14, 30), NOW)).toEqual({ label: "30일 뒤", expired: false });
    expect(devExpiry(at(2027, 0, 26, 9, 0), NOW)).toEqual({ label: "90일 뒤", expired: false });
  });

  it("says honestly that a time has passed", () => {
    const now = devExpiry(NOW, NOW);
    const earlier = devExpiry(NOW - 3 * DAY, NOW);
    expect(now.expired).toBe(true);
    expect(earlier.expired).toBe(true);
    expect(earlier.label).toBe(now.label);
    expect(["오늘", "1일 뒤"]).not.toContain(earlier.label);
  });
});

describe("field validation", () => {
  it("trims a name and accepts 1 to 80 characters, counting characters not code units", () => {
    expect(validateDevName("  달무리 서버 점검  ")).toEqual({ ok: true, value: "달무리 서버 점검" });
    expect(validateDevName("가".repeat(80)).ok).toBe(true);
    expect(validateDevName("😀".repeat(80)).ok).toBe(true);
    expect(validateDevName("가".repeat(81)).ok).toBe(false);
    expect(validateDevName("😀".repeat(81)).ok).toBe(false);
    expect(validateDevName("  ".concat("가".repeat(80), "  ")).ok).toBe(true);
  });

  it("refuses an empty name, a control character and a token envelope, each with its own sentence", () => {
    const empty = validateDevName("   ");
    const long = validateDevName("가".repeat(81));
    const control = validateDevName("이도현\t노트북");
    const envelope = validateDevName(`copy of momo_dev_v1.${WS}.x`);
    const refreshEnvelope = validateDevName(`momo_devr_v1.${WS}.x`);
    const upper = validateDevName("MOMO_DEV_V1.abc");
    for (const result of [empty, long, control, envelope, refreshEnvelope, upper]) {
      expect(result.ok).toBe(false);
    }
    const messages = [empty, long, control, envelope].map((result) => (result.ok ? "" : result.message));
    expect(new Set(messages).size).toBe(4);
    expect(messages.every((message) => message.length > 0)).toBe(true);
    expect(validateDevName("a\nb").ok).toBe(false);
    expect(validateDevName("이름\n").ok).toBe(true);
    expect(validateDevName("momo_dev 공부").ok).toBe(true);
  });

  it("takes 1 to 50 channels, a repeat counted once", () => {
    const ids = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `019f9b10-0000-7000-8000-${String(index).padStart(12, "0")}`);
    expect(validateChannelSelection([]).ok).toBe(false);
    expect(validateChannelSelection(ids(1)).ok).toBe(true);
    expect(validateChannelSelection(ids(50)).ok).toBe(true);
    const tooMany = validateChannelSelection(ids(51));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.message).toContain("50");
    const repeated = validateChannelSelection([...ids(49), ...ids(49).map((id) => id.toUpperCase()), ...ids(1)]);
    expect(repeated).toEqual({ ok: true, value: ids(49) });
    const none = validateChannelSelection([]);
    if (!none.ok && !tooMany.ok) expect(none.message).not.toBe(tooMany.message);
  });

  it("takes a password of 1 to 1024 characters exactly as typed", () => {
    expect(validatePassword("").ok).toBe(false);
    expect(validatePassword(" ")).toEqual({ ok: true, value: " " });
    expect(validatePassword("  padded  ")).toEqual({ ok: true, value: "  padded  " });
    expect(validatePassword("a".repeat(1024)).ok).toBe(true);
    expect(validatePassword("😀".repeat(1024)).ok).toBe(true);
    expect(validatePassword("a".repeat(1025)).ok).toBe(false);
    expect(validatePassword("😀".repeat(1025)).ok).toBe(false);
    const empty = validatePassword("");
    const long = validatePassword("a".repeat(1025));
    if (!empty.ok && !long.ok) expect(empty.message).not.toBe(long.message);
  });
});

describe("list rows", () => {
  it("shows a card with what it carries and nothing it does not", () => {
    const row = devCredentialRow(CARD, { now: NOW });
    expect(row).toMatchObject({
      id: CARD.id,
      kind: "card",
      kindLabel: "카드 토큰",
      name: "이도현 노트북 Claude Code",
      toolLabel: "Claude Code",
      scopeLabel: "읽기만",
      channelRestricted: false,
      lastUsedLabel: "3일 전",
      neverUsed: false,
      expiryLabel: "20일 뒤",
      expired: false,
      memberId: DOHYUN,
    });
    // A card has no device name, and none is made up.
    expect("deviceName" in row).toBe(false);
    expect("scopeDetail" in row).toBe(false);
    expect("memberName" in row).toBe(false);
  });

  it("shows a login session with its device, no tool and the channel limit", () => {
    const row = devCredentialRow(SESSION, { now: NOW, memberName: "박서연" });
    expect(row.kind).toBe("session");
    expect(row.kindLabel).toBe("로그인 세션");
    expect(row.deviceName).toBe("oort CLI · macOS");
    expect("toolLabel" in row).toBe(false);
    expect(row.scopeLabel).toBe(`읽기 + 보내기 · ${DEV_CHANNEL_ONLY_LABEL}`);
    expect(row.memberName).toBe("박서연");
  });

  it("says a token that was never used has not been used", () => {
    const { lastUsedAtMs: _never, ...unused } = CARD;
    const row = devCredentialRow(unused, { now: NOW });
    expect(row.neverUsed).toBe(true);
    expect(row.lastUsedLabel).toBe("아직 안 썼어요");
    // A use a moment ago is not the same statement.
    const justNow = devCredentialRow({ ...CARD, lastUsedAtMs: NOW - 1000 }, { now: NOW });
    expect(justNow.neverUsed).toBe(false);
    expect(justNow.lastUsedLabel).toBe("방금");
  });

  it("spells out a custom scope list on the row, and only then", () => {
    const custom = devCredentialRow({ ...CARD, scopes: ["dev:identity", "dev:messages:write"] }, { now: NOW });
    expect(custom.scopeDetail).toContain(devScopeName("dev:messages:write"));
    expect(devCredentialRow(CARD, { now: NOW }).scopeDetail).toBeUndefined();
  });

  it("marks a row whose time has passed", () => {
    const row = devCredentialRow({ ...CARD, expiresAtMs: NOW - 1 }, { now: NOW });
    expect(row.expired).toBe(true);
    expect(row.expiryLabel).toBe(devExpiry(NOW - 1, NOW).label);
  });

  it("recognises the caller's own row whatever the letter case of the id", () => {
    expect(isOwnDevCredential(CARD, DOHYUN)).toBe(true);
    expect(isOwnDevCredential(CARD, DOHYUN.toUpperCase())).toBe(true);
    expect(isOwnDevCredential(CARD, SEOYEON)).toBe(false);
    expect(isOwnDevCredential(SESSION, "")).toBe(false);
  });

  it("names the two list views", () => {
    expect(DEV_LIST_SCOPE_LABELS.mine).not.toBe(DEV_LIST_SCOPE_LABELS.all);
  });
});

describe("the policy gate", () => {
  const cases: Array<[string, DevAccessPolicy, "open" | "needs_admin" | "off"]> = [
    ["admins, admitted", { policy: "admins", canCreate: true, canManageAll: true }, "open"],
    ["admins, a member", { policy: "admins", canCreate: false, canManageAll: false }, "needs_admin"],
    ["members, admitted", { policy: "members", canCreate: true, canManageAll: false }, "open"],
    ["members, a guest", { policy: "members", canCreate: false, canManageAll: false }, "needs_admin"],
    ["off, nobody", { policy: "off", canCreate: false, canManageAll: true }, "off"],
    ["off for a member", { policy: "off", canCreate: false, canManageAll: false }, "off"],
    ["canCreate decides first", { policy: "off", canCreate: true, canManageAll: true }, "open"],
  ];

  it.each(cases)("%s", (_name, policy, state) => {
    const gate = devAccessGate(policy);
    expect(gate.state).toBe(state);
    expect(gate.text.length).toBeGreaterThan(0);
  });

  it("says a switch that is off is off, and a refusal an administrator can lift needs one", () => {
    const off = devAccessGate({ policy: "off", canCreate: false, canManageAll: false });
    const needsAdmin = devAccessGate({ policy: "admins", canCreate: false, canManageAll: false });
    expect(off.text).toContain("꺼져");
    expect(needsAdmin.text).toContain("관리자가 켜 줘야 해요");
    expect(off.text).not.toBe(needsAdmin.text);
  });
});

describe("fixed notices", () => {
  it("states the facts the screens must carry", () => {
    expect(DEV_NOTICES.passwordChangeEndsAll).toContain("비밀번호를 바꾸면 모든 연결이 끊겨요");
    expect(DEV_NOTICES.logoutKeepsConnections).toContain("로그아웃해도 연결은 끊기지 않아요");
    expect(DEV_NOTICES.toolIsOnlyALabel).toContain("고른 값");
    expect(DEV_NOTICES.fixedAfterIssue).toContain("바꿀 수 없어요");
    expect(DEV_NOTICES.fixedAfterIssue).toContain("새로 만들고");
    expect(DEV_NOTICES.cardLimit).toContain(`${DEV_CARD_LIMIT}개`);
    expect(DEV_CARD_LIMIT).toBe(20);
    expect(DEV_NOTICES.revokeWarning).toContain("되돌릴 수 없어요");
  });

  it("warns that the one-time screen cannot be opened again, and names the confirm button", () => {
    expect(DEV_ONE_TIME_COPY.warning).toContain("다시 볼 수 없어요");
    expect(DEV_ONE_TIME_COPY.confirmLabel).toBe("저장했어요");
  });

  it("describes the channel limit as laid over the presets", () => {
    expect(DEV_CHANNEL_RESTRICTION_COPY.label.length).toBeGreaterThan(0);
    expect(DEV_CHANNEL_RESTRICTION_COPY.help).toContain("채널");
  });
});

describe("failure sentences", () => {
  function text(kind: DevAccessFailureKind, action: DevAccessAction, retryAfterSeconds?: number): string {
    const failure: DevAccessFailure = retryAfterSeconds === undefined ? { kind } : { kind, retryAfterSeconds };
    return devAccessErrorText(failure, action);
  }

  it("says something for every kind in every place", () => {
    for (const kind of ALL_FAILURES) {
      for (const action of ALL_ACTIONS) expect(text(kind, action).length, `${kind}/${action}`).toBeGreaterThan(0);
    }
  });

  it("gives every kind its own sentence when making a token, so retrying is never advised for what retrying cannot fix", () => {
    const sentences = ALL_FAILURES.map((kind) => text(kind, "create"));
    expect(new Set(sentences).size).toBe(ALL_FAILURES.length);
  });

  it("names the wait the server asked for", () => {
    expect(text("rate_limited", "create", 30)).toContain("30초");
    expect(text("busy", "create", 30)).toContain("30초");
    expect(text("rate_limited", "create", 120)).toContain("2분");
    expect(text("rate_limited", "create", 3600)).toContain("1시간");
    expect(text("rate_limited", "create")).not.toMatch(/\d/);
    expect(text("busy", "revoke")).not.toMatch(/\d/);
    expect(text("rate_limited", "create", 0)).toBe(text("rate_limited", "create"));
  });

  it("states the card limit with the number", () => {
    expect(text("limit", "create")).toContain(`${DEV_CARD_LIMIT}개`);
  });

  it("does not invite a blind second try after a create whose answer was lost", () => {
    for (const kind of ["network", "unknown"] as const) {
      expect(text(kind, "create")).not.toBe(text(kind, "list"));
      expect(text(kind, "create")).toContain("목록을 확인");
      expect(text(kind, "list")).not.toContain("목록을 확인");
    }
  });

  it("tells a missing route apart from a missing credential", () => {
    expect(text("not_found", "revoke")).not.toBe(text("not_found", "policy"));
    expect(text("not_found", "policy")).toBe(text("not_found", "list"));
  });

  it("rounds a wait up so it never promises less than the server asked", () => {
    expect(retryAfterPhrase(undefined)).toBe("잠시 뒤");
    expect(retryAfterPhrase(0)).toBe("잠시 뒤");
    expect(retryAfterPhrase(1)).toBe("1초 뒤");
    expect(retryAfterPhrase(59)).toBe("59초 뒤");
    expect(retryAfterPhrase(60)).toBe("1분 뒤");
    expect(retryAfterPhrase(61)).toBe("2분 뒤");
    expect(retryAfterPhrase(3599)).toBe("1시간 뒤");
    expect(retryAfterPhrase(3600)).toBe("1시간 뒤");
    expect(retryAfterPhrase(3601)).toBe("2시간 뒤");
  });
});

// ---- command snippets ----------------------------------------------------------------------------

const CONTEXT: DevCommandContext = { serverOrigin: "https://oort.example.com", workspaceId: WS };
const ALL_TOOLS: readonly DevTool[] = DEV_TOOLS;

/**
 * What must never appear in a snippet: a token-shaped value, a `Bearer` followed by anything
 * but a reference to the environment variable (or the printf placeholder fed by one), or a
 * header flag that would put a value on a command line.
 */
function secretShapeViolations(step: string): string[] {
  const found: string[] = [];
  if (/momo_devr?_v1\./.test(step)) found.push("token envelope");
  for (const match of step.matchAll(/Bearer\s+(\S*)/g)) {
    const value = match[1] ?? "";
    if (!/^(?:\$\{OORT_TOKEN\}|\$OORT_TOKEN(?![A-Za-z0-9_])|%s(?![A-Za-z0-9]))/.test(value)) {
      found.push(`Bearer followed by ${value}`);
    }
  }
  if (/Bearer\s+%s/.test(step) && !/"\$OORT_TOKEN"|"\$\(oort token\)"/.test(step)) {
    found.push("placeholder not fed by the environment");
  }
  if (/(?:^|\s)(?:--header|-H)(?=\s|=|$)/.test(step)) found.push("header flag");
  return found;
}

function everyStep(options: DevCommandOption[]): string[] {
  return options.flatMap((option) => option.steps.map((step) => step.text));
}

function codeSteps(option: DevCommandOption): string[] {
  return option.steps.filter((step) => step.kind === "code").map((step) => step.text);
}

describe("command snippets", () => {
  it("lists the ways in for a tool, best first, with the CLI ways written but not shown yet", () => {
    for (const tool of ["claude_code", "codex"] as const) {
      const options = devCommandOptions(tool, CONTEXT);
      expect(options.map((option) => option.id)).toEqual(["stdio", "helper", "env"]);
      expect(options.map((option) => option.rank)).toEqual([1, 2, 3]);
      expect(options.every((option) => option.steps.length > 0 && option.title.length > 0)).toBe(true);
    }
    for (const tool of ["cli", "other"] as const) {
      const options = devCommandOptions(tool, CONTEXT);
      expect(options.map((option) => option.id)).toEqual(["helper", "env"]);
      expect(options.map((option) => option.rank)).toEqual([2, 3]);
    }
  });

  it("turns the two CLI ways on and off with one constant, and the environment way is always on", () => {
    for (const tool of ALL_TOOLS) {
      const options = devCommandOptions(tool, CONTEXT);
      for (const option of options) {
        expect(option.available).toBe(option.id === "env" ? true : OORT_CLI_VERIFIED);
      }
    }
  });

  // This test pins the screen to the environment way while OORT_CLI_VERIFIED is false. Whoever
  // turns the constant on after #4662 checks the real clients must change it deliberately.
  it("shows only the available option, so a way that is not available never reaches the screen", () => {
    expect(OORT_CLI_VERIFIED).toBe(false);
    for (const tool of ALL_TOOLS) {
      const all = devCommandOptions(tool, CONTEXT);
      const shown = commandTabsFor(tool, CONTEXT);
      expect(all.some((option) => !option.available)).toBe(true);
      expect(shown.every((option) => option.available)).toBe(true);
      expect(shown.map((option) => option.id)).toEqual(["env"]);
      for (const hidden of all.filter((option) => !option.available)) {
        expect(shown.map((option) => option.id)).not.toContain(hidden.id);
      }
    }
  });

  it("starts the environment way by reading the value in, never by writing it into a command", () => {
    for (const tool of ALL_TOOLS) {
      const env = commandTabsFor(tool, CONTEXT)[0];
      const first = env?.steps.find((step) => step.kind === "code");
      expect(first?.text).toBe("read -rs OORT_TOKEN && export OORT_TOKEN");
    }
  });

  it("points Claude Code at the people's MCP address with a reference to the variable", () => {
    const env = commandTabsFor("claude_code", CONTEXT)[0];
    const file = env?.steps.find((step) => step.kind === "code" && step.label === ".mcp.json");
    expect(file).toBeDefined();
    const parsed = JSON.parse(file?.text ?? "null") as {
      mcpServers: { oort: { type: string; url: string; headers: { Authorization: string } } };
    };
    expect(parsed.mcpServers.oort.type).toBe("http");
    expect(parsed.mcpServers.oort.url).toBe("https://oort.example.com/v1/mcp/me");
    // The text `${OORT_TOKEN}` is a reference the tool expands, not a template of ours.
    expect(parsed.mcpServers.oort.headers.Authorization).toBe("Bearer ${OORT_TOKEN}");
  });

  it("points Codex at the same address and names the variable to read", () => {
    const env = commandTabsFor("codex", CONTEXT)[0];
    const file = env?.steps.find((step) => step.kind === "code" && step.label?.endsWith("config.toml"));
    expect(file?.text.split("\n")).toEqual([
      "[mcp_servers.oort]",
      'url = "https://oort.example.com/v1/mcp/me"',
      'bearer_token_env_var = "OORT_TOKEN"',
    ]);
  });

  it("asks the server who the token is, without the value ever being an argument", () => {
    const cli = commandTabsFor("cli", CONTEXT)[0];
    const command = cli?.steps.filter((step) => step.kind === "code")[1];
    expect(command?.text).toBe(
      `printf 'header = "Authorization: Bearer %s"\\n' "$OORT_TOKEN" | curl -sS -K - "https://oort.example.com/v1/workspaces/${WS}/dev-access/self"`
    );
  });

  it("tidies the server address and keeps every address absolute", () => {
    for (const origin of [
      "https://oort.example.com/",
      "https://oort.example.com///",
      "  https://oort.example.com  ",
    ]) {
      const text = everyStep(devCommandOptions("claude_code", { serverOrigin: origin, workspaceId: WS })).join("\n");
      expect(text).toContain("https://oort.example.com/v1/mcp/me");
      expect(text).not.toContain("com//v1");
    }
    const local = everyStep(devCommandOptions("cli", { serverOrigin: "http://127.0.0.1:18000/", workspaceId: WS }));
    expect(local.join("\n")).toContain(`http://127.0.0.1:18000/v1/workspaces/${WS}/dev-access/self`);
  });

  it.each([
    ["an empty address, which a same-origin web build can hand over", ""],
    ["a relative address", "/"],
    ["a scheme that is not http or https", "ftp://oort.example.com"],
    ["an address with a space", "https://oort.example.com/a b"],
    ["an address with a quote", 'https://oort.example.com/"x'],
    ["an address that would expand in a shell", "https://oort.example.com/$(id)"],
    ["an address with a backtick", "https://oort.example.com/`id`"],
  ])("writes nothing for %s", (_name, serverOrigin) => {
    for (const tool of ALL_TOOLS) {
      expect(devCommandOptions(tool, { serverOrigin, workspaceId: WS })).toEqual([]);
      expect(commandTabsFor(tool, { serverOrigin, workspaceId: WS })).toEqual([]);
    }
    expect(DEV_COMMANDS_UNAVAILABLE_TEXT.length).toBeGreaterThan(0);
  });

  it.each([["an empty id", ""], ["a path in place of an id", "../x"], ["an id with a space", "a b"], ["an id with a quote", 'a"b']])(
    "writes nothing for %s",
    (_name, workspaceId) => {
      expect(devCommandOptions("cli", { serverOrigin: CONTEXT.serverOrigin, workspaceId })).toEqual([]);
    }
  );

  it("never holds a secret-shaped value or a header flag in any step of any option for any tool", () => {
    const origins = ["https://oort.example.com", "https://oort.example.com/", "http://127.0.0.1:18000"];
    let checked = 0;
    for (const tool of ALL_TOOLS) {
      for (const serverOrigin of origins) {
        for (const text of everyStep(devCommandOptions(tool, { serverOrigin, workspaceId: WS }))) {
          expect(secretShapeViolations(text), `${tool} ${text}`).toEqual([]);
          checked += 1;
        }
      }
    }
    // Guards against a loop that checks nothing.
    expect(checked).toBeGreaterThan(40);
  });

  it("keeps the check itself honest: it flags a token, a bare Bearer value and a header flag", () => {
    const fake = `momo_dev_v1.${WS}.${"EXAMPLE".repeat(6)}0`;
    expect(secretShapeViolations(`curl -H "Authorization: Bearer ${fake}" https://x`)).toEqual(
      expect.arrayContaining(["token envelope", "header flag"])
    );
    expect(secretShapeViolations('curl --header "Authorization: Bearer abc123" https://x')).toEqual(
      expect.arrayContaining(["header flag"])
    );
    expect(secretShapeViolations('{ "Authorization": "Bearer <값>" }').length).toBeGreaterThan(0);
    expect(secretShapeViolations('{ "Authorization": "Bearer abc123" }').length).toBeGreaterThan(0);
    expect(secretShapeViolations("printf 'Bearer %s\\n' literalvalue").length).toBeGreaterThan(0);
    expect(secretShapeViolations('curl -H "Authorization: Bearer $OORT_TOKEN" https://x')).toContain("header flag");
    expect(secretShapeViolations('{ "Authorization": "Bearer ${OORT_TOKEN}" }')).toEqual([]);
    expect(
      secretShapeViolations(`printf 'header = "Authorization: Bearer %s"\\n' "$OORT_TOKEN" | curl -sS -K - https://x`)
    ).toEqual([]);
  });

  it("writes the CLI ways that are not shown yet as carefully as the one that is", () => {
    for (const option of devCommandOptions("claude_code", CONTEXT).filter((entry) => !entry.available)) {
      const code = codeSteps(option).join("\n");
      expect(code.length).toBeGreaterThan(0);
      expect(secretShapeViolations(code)).toEqual([]);
    }
    const helper = devCommandOptions("claude_code", CONTEXT).find((option) => option.id === "helper");
    const file = helper?.steps.find((step) => step.label === ".mcp.json");
    const parsed = JSON.parse(file?.text ?? "null") as { mcpServers: { oort: Record<string, string> } };
    expect(parsed.mcpServers.oort["headersHelper"]).toBe("oort token --headers");
    expect(parsed.mcpServers.oort["headers"]).toBeUndefined();
  });
});

// ---- copy hygiene ---------------------------------------------------------------------------------

/** 합쇼체 (-습니다, -ㅂ니다 and their questions): the register of these sentences is 해요. */
function hasHapshoche(text: string): boolean {
  for (const match of text.matchAll(/([가-힣])니[다까](?![가-힣])/g)) {
    const syllable = match[1] ?? "";
    if (syllable === "습") return true;
    if ((syllable.charCodeAt(0) - 0xac00) % 28 === 17) return true;
  }
  return false;
}

function copyViolations(text: string): string[] {
  const found: string[] = [];
  if (/—|–/.test(text)) found.push("dash");
  if (/원활한|손쉽게|매끄러운|seamless|effortless/i.test(text)) found.push("filler word");
  if (hasHapshoche(text)) found.push("합쇼체");
  if (/[A-Za-z] (은|는|이|가|을|를|과|와|의|로|으로|에|에서|도|만)(?=$|[^가-힣])/.test(text)) {
    found.push("spaced particle after a latin word");
  }
  return found;
}

describe("copy hygiene of the sentences built at run time", () => {
  function sentences(): string[] {
    const out: string[] = [];
    for (const preset of DEV_PRESETS) out.push(preset.label, preset.description);
    out.push(...Object.values(DEV_CHANNEL_RESTRICTION_COPY), ...Object.values(DEV_NOTICES));
    out.push(...Object.values(DEV_ONE_TIME_COPY), ...Object.values(DEV_LIST_SCOPE_LABELS));
    out.push(DEV_COMMANDS_UNAVAILABLE_TEXT, DEV_CHANNEL_ONLY_LABEL);
    for (const tool of DEV_TOOLS) out.push(devToolLabel(tool));
    for (const kind of ALL_FAILURES) {
      for (const action of ALL_ACTIONS) {
        for (const retryAfterSeconds of [undefined, 1, 45, 61, 7200]) {
          const failure: DevAccessFailure = retryAfterSeconds === undefined ? { kind } : { kind, retryAfterSeconds };
          out.push(devAccessErrorText(failure, action));
        }
      }
    }
    for (const policy of ["admins", "members", "off"] as const) {
      for (const canCreate of [true, false]) {
        out.push(devAccessGate({ policy, canCreate, canManageAll: false }).text);
      }
    }
    const bad: Array<{ message: string } | { value: unknown }> = [
      validateDevName(""),
      validateDevName("가".repeat(81)),
      validateDevName("a\tb"),
      validateDevName("momo_dev_v1.x"),
      validateChannelSelection([]),
      validateChannelSelection(Array.from({ length: 51 }, (_, index) => `c${index}`)),
      validatePassword(""),
      validatePassword("a".repeat(1025)),
      validateExpiryDays(""),
      validateExpiryDays("x"),
      validateExpiryDays("91"),
    ];
    for (const result of bad) if ("message" in result) out.push(result.message);
    for (const label of [devExpiry(NOW - 1, NOW).label, devExpiry(NOW, NOW - 1).label, devExpiry(NOW + 5 * DAY, NOW).label]) {
      out.push(label);
    }
    for (const credential of [CARD, SESSION, { ...CARD, scopes: ["dev:identity", "dev:future:admin"] }]) {
      const row = devCredentialRow(credential, { now: NOW });
      out.push(row.kindLabel, row.scopeLabel, row.lastUsedLabel, row.expiryLabel, row.scopeDetail ?? "");
    }
    for (const tool of ALL_TOOLS) {
      for (const option of devCommandOptions(tool, CONTEXT)) {
        out.push(option.title, ...option.steps.filter((step) => step.kind === "prose").map((step) => step.text));
      }
    }
    return out.filter((entry) => entry !== "");
  }

  it("holds no dash, filler word, 합쇼체 or spaced particle in anything a screen can print", () => {
    const all = sentences();
    expect(all.length).toBeGreaterThan(150);
    for (const text of all) expect(copyViolations(text), text).toEqual([]);
  });

  it("keeps the check itself honest", () => {
    expect(copyViolations("이렇게 — 쓰면 안 돼요")).toContain("dash");
    expect(copyViolations("원활한 연결이에요")).toContain("filler word");
    expect(copyViolations("연결합니다")).toContain("합쇼체");
    expect(copyViolations("연결했습니다")).toContain("합쇼체");
    expect(copyViolations("Claude Code 는 도구예요")).toContain("spaced particle after a latin word");
    expect(copyViolations("Claude Code는 도구예요")).toEqual([]);
    expect(copyViolations("연결이 끊겨요")).toEqual([]);
  });
});
