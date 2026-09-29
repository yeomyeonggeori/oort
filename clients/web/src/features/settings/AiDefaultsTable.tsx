import { useEffect } from "react";
import { Lock } from "lucide-react";
import {
  AI_DEFAULT_ROWS,
  AI_DEFAULT_UNSET_LABEL,
  credentialKey,
  credentialName,
  credentialSource,
  modelLine,
  optionsFor,
  resolveRow,
  withChoice,
  type AiDefaultOption,
  type AiDefaultRow,
  type AiDefaultsInput,
  type AiDefaultsPrefs,
  type AiDefaultsTeamKey,
  type PersonalRowId,
} from "@momo/core/features/settings/aiDefaults";
import {
  linkUnresolvedSentence,
  TEAM_DEFAULTS_CHECK_FIRST,
  TEAM_DEFAULTS_APPLIED,
  TEAM_DEFAULTS_OFFLINE,
  teamChoiceText,
  teamModelNote,
  teamOptionKey,
  teamOptions,
  type ProviderDefaultAi,
  type TeamDefaultAiInput,
  type TeamDefaultRowId,
  type TeamLinkModels,
} from "@momo/core/features/settings/defaultAi";
import { cn } from "@/design/lib/cn";
import { HarnessLoginDialog } from "@/features/welcome/harnessLogin/HarnessLoginDialog";
import { Select } from "@/design/ui/select";
import { AiFoot } from "./aiAccountsParts";
import { readAiDefaults as readAiDefaultsNow, useAiDefaults, useMyAccounts, writeAiDefaults } from "./aiDefaultsStore";
import {
  chooseRemoteWorkAccount,
  remoteLoginClosed,
  remoteLoginConnected,
  syncRemoteWorkAccount,
  useRemoteWork,
  type RemoteWorkView,
} from "./remoteWorkStore";
import { readDesignParam } from "./aiMyAccountsModel";
import { REMOTE_WORK_APPLYING } from "@momo/core/features/settings/remoteWorkProfile";

// Reading this as: settings (AI 연결 · 기본 AI) for internal team users on web+Tauri,
// density 6/10, motion 1/10 (none added).

// =============================================================================
// 설정 › AI 연결 › 기본 AI (#2881 AA-8, 시안 §5 왼쪽 판, brief §4).
//
// 여섯 줄: 개인 셋(앱 명령·로컬 터미널·원격 작업)은 이 기기에 저장되는 선택 칸이고,
// 팀 셋(팀 에이전트·요약·가드레일)은 운영자 서버 설정이다. 선택지·폴백·저장은 코어
// `aiDefaults.ts`(개인)·`defaultAi.ts`(팀)가 판정한다. 이 파일은 그리기만 한다.
//
// 팀 에이전트·요약 줄은 운영자에게 선택 칸이다(#3042, `PUT /v1/provider/default-ai`).
// 고를 수 있는지는 서버 답이다: default-ai GET 이 200 이면 칸을 열고, 403 이면 점선
// 칸으로 읽기만 한다. 모델 선택지는 연결 확인의 `modelIds`뿐이다. 가드레일은 서버가
// `off`만 받아 읽기 전용이다.
// =============================================================================

/** 운영자, 팀 줄을 아직 읽는 중. 실패라고 말하지 않는다(design-review #3042 H1). */
const TEAM_FOOT_OPERATOR_LOADING = "팀 줄은 운영자 설정이에요.";
/** 운영자인데 팀 줄을 읽지 못했다(옛 서버 404·오류). 저장 칸이 없다는 사실만. */
const TEAM_FOOT_OPERATOR =
  "팀 줄은 운영자 설정이에요. 이 서버에서 팀 줄을 불러오지 못해 지금은 서버가 정한 값을 보여 줘요.";
const TEAM_FOOT_MEMBER = "팀 줄은 이 서버의 운영자만 바꿀 수 있어요.";
const PERSONAL_FOOT =
  "내 구독은 나만 보는 결과에만 쓰입니다. 팀 에이전트와 요약은 내 구독으로 넘어가지 않습니다.";

/**
 * 팀 줄의 서버 값(#3042). `ready` = default-ai GET 200(운영자), `hidden` = 403,
 * `error` = 그 밖(옛 서버 404 포함), `loading` = 아직 모름.
 */
export interface TeamDefaultsState {
  readonly status: "loading" | "ready" | "hidden" | "error";
  readonly value: ProviderDefaultAi | null;
  /** 방금 한 연결 확인이 알려 준 연결과 모델. 확인 전이면 빈 목록. */
  readonly links: readonly TeamLinkModels[];
  /** 저장이 날고 있는 줄과 그 값. */
  readonly pending: { rowId: TeamDefaultRowId; input: TeamDefaultAiInput | null } | null;
  readonly saveError: { rowId: TeamDefaultRowId; message: string } | null;
  /** 실시간 연결이 끊겼다: 팀 연결 절의 다른 쓰기처럼 칸을 잠그고 이유를 적는다. */
  readonly offline: boolean;
  readonly onChoose: (rowId: TeamDefaultRowId, input: TeamDefaultAiInput | null) => void;
}

export function AiDefaultsTable({
  teamKey,
  operator,
  browserTab,
  team,
}: {
  teamKey: AiDefaultsTeamKey;
  /** 서버가 운영자라고 답했나(200)·아니라고 답했나(403). 모르면 null. */
  operator: boolean | null;
  browserTab: boolean;
  /** 팀 줄의 서버 값. 없으면 팀 줄은 읽기 전용이다. */
  team?: TeamDefaultsState;
}) {
  const prefs = useAiDefaults();
  const accounts = useMyAccounts();
  const input: AiDefaultsInput = { accounts: accounts ?? [], teamKey, browserTab };
  const remote = useRemoteWork();
  // 저장된 원격 작업 계정이 이 맥에 있는지 맞춘다(#3157). 브라우저 탭에는 이 맥이 없다.
  const savedRemote = prefs.remoteWork;
  const savedRemoteKey = savedRemote?.kind === "profile" ? `${savedRemote.harness}/${savedRemote.label ?? ""}` : "";
  useEffect(() => {
    if (browserTab) return;
    void syncRemoteWorkAccount(readAiDefaultsNow());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserTab, savedRemoteKey]);
  return (
    <>
      {remote.login && (
        <HarnessLoginDialog
          harness={remote.login.harness}
          profile={remote.login.label}
          remote
          // design 캡처: PTY 없이 「기다리는 중」 상태로 세운다.
          fixture={readDesignParam("aiRemote") === "login" ? { status: { phase: "waiting" } } : null}
          onClose={remoteLoginClosed}
          onConnected={remoteLoginConnected}
          // 원격 작업 폴더의 로그인은 명령 복사로 대신하지 않는다(다른 폴더에 로그인된다).
          onFallbackStarted={remoteLoginClosed}
        />
      )}
      <ul className="flex min-w-0 flex-col" aria-label="기능마다 부를 AI" data-testid="ai-defaults-table">
        {AI_DEFAULT_ROWS.map((row, index) => (
          <DefaultRow
            key={row.id}
            row={row}
            last={index === AI_DEFAULT_ROWS.length - 1}
            prefs={prefs}
            input={input}
            accountsKnown={accounts !== null}
            team={team}
            remote={remote}
          />
        ))}
      </ul>
      <AiFoot>{PERSONAL_FOOT}</AiFoot>
      {operator !== null && (
        <AiFoot>
          <span data-testid="ai-defaults-team-foot" data-operator={operator ? "yes" : "no"}>
            {!operator
              ? TEAM_FOOT_MEMBER
              : team?.status === "ready"
                ? TEAM_DEFAULTS_APPLIED
                : team?.status === "error"
                  ? TEAM_FOOT_OPERATOR
                  : TEAM_FOOT_OPERATOR_LOADING}
          </span>
        </AiFoot>
      )}
    </>
  );
}

function DefaultRow({
  row,
  last,
  prefs,
  input,
  accountsKnown,
  team,
  remote,
}: {
  row: AiDefaultRow;
  last: boolean;
  prefs: AiDefaultsPrefs;
  input: AiDefaultsInput;
  accountsKnown: boolean;
  team: TeamDefaultsState | undefined;
  remote: RemoteWorkView;
}) {
  const titleId = `ai-default-${row.id}-title`;
  const resolved = resolveRow(row.id, prefs, input);
  const personal = row.audience === "me";
  const lines: { key: string; text: string; tone: "muted" | "warn" }[] = [];
  // 칸 밑 줄(모델·안내·폴백)은 선택 칸의 설명이다: 낭독기가 칸에서 경고를 듣는다.
  const lineId = (key: string) => `ai-default-${row.id}-${key}`;
  const describedBy = ["model", "note", "fallback", "saved", "error"].map(lineId).join(" ");

  let choice;
  // 운영자에게 열린 팀 줄: 「운영자」 표지에 자물쇠를 달지 않는다(잠김이 아니다).
  let teamEditable = false;
  if (personal) {
    const id = row.id as PersonalRowId;
    const saved = prefs[id] ?? null;
    if (id !== "appCommand" && input.browserTab) {
      choice = <ReadOnlyBox>데스크탑 앱에서 고를 수 있어요</ReadOnlyBox>;
    } else if (id !== "appCommand" && !accountsKnown) {
      choice = <ReadOnlyBox>이 맥의 계정을 확인하고 있어요</ReadOnlyBox>;
    } else if (id === "appCommand" && input.teamKey.status !== "present") {
      // 팀 키가 있다고 읽은 때만 고르는 칸이다. 그 밖에는 이유를 적은 읽기 전용 칸.
      choice = (
        <ReadOnlyBox>{resolved.state === "blocked" ? "쓸 수 있는 자격이 없어요" : resolved.using}</ReadOnlyBox>
      );
    } else {
      const options = optionsFor(id, input);
      // 저장한 계정이 목록에서 사라졌으면 그 값을 선택지로 남겨 둔다: 칸이 다른 값을
      // 가리키는 척하지 않게(폴백 문장이 바로 밑에서 이유를 말한다).
      const orphan =
        saved && !options.some((option) => option.key === credentialKey(saved))
          ? {
              key: credentialKey(saved),
              name: credentialName(saved, input.teamKey),
              source: credentialSource(saved),
              unavailable: "목록에 없음",
            }
          : null;
      const value = saved ? credentialKey(saved) : id === "appCommand" ? "teamKey" : "";
      // WebKit(Tauri)은 네이티브 선택 칸에 말줄임을 그리지 않는다: 잘린 값도 끝까지
      // 읽히게 고른 글자 전체를 title로 둔다(#3010 design-review M2).
      const current = [...options, ...(orphan ? [orphan] : [])].find((option) => option.key === value);
      const fullText = current ? optionText(current) : id === "appCommand" ? undefined : AI_DEFAULT_UNSET_LABEL[id];
      choice = (
        <Select
          aria-labelledby={titleId}
          aria-describedby={describedBy}
          value={value}
          title={fullText}
          className="h-control rounded-md text-meta"
          // 이 맥에 넘기는 동안(로그인 창 포함)은 두 번째 고름이 끼지 않게 잠근다.
          disabled={id === "remoteWork" && remote.applying}
          onChange={(event) => {
            const next = event.target.value;
            const picked = options.find((option) => option.key === next)?.ref ?? null;
            if (id === "remoteWork") {
              // 이 맥의 workd가 받은 뒤에만 저장한다(거부되면 칸은 이전 값 그대로).
              void chooseRemoteWorkAccount(picked);
              return;
            }
            // 앱 명령의 기본값은 팀 키다: 같은 값을 따로 적어 두지 않는다.
            const store = id === "appCommand" && picked?.kind === "teamKey" ? null : picked;
            writeAiDefaults(withChoice(prefs, id, store));
          }}
          data-testid={`ai-default-${row.id}-select`}
        >
          {id !== "appCommand" && <option value="">{AI_DEFAULT_UNSET_LABEL[id]}</option>}
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {optionText(option)}
            </option>
          ))}
          {orphan && <option value={orphan.key}>{optionText(orphan)}</option>}
          {id === "appCommand" && (
            <option value="profile-pending" disabled>
              내 구독 · 준비 중
            </option>
          )}
        </Select>
      );
      if (id !== "appCommand" && saved && resolved.state === "ok") {
        lines.push({ key: "model", text: modelLine(saved, input.teamKey), tone: "muted" });
      }
      if (id === "appCommand" && resolved.state === "ok") {
        lines.push({ key: "model", text: modelLine({ kind: "teamKey" }, input.teamKey), tone: "muted" });
      }
      if (id === "remoteWork") {
        if (remote.applying) lines.push({ key: "saved", text: REMOTE_WORK_APPLYING, tone: "muted" });
        else if (remote.note) {
          lines.push({ key: remote.note.tone === "warn" ? "error" : "saved", text: remote.note.text, tone: remote.note.tone });
        }
      }
    }
  } else if (
    (row.id === "teamAgent" || row.id === "summary") &&
    team?.status === "ready" &&
    team.value !== null &&
    input.teamKey.status === "present"
  ) {
    // 운영자(서버 200)에게 팀 줄은 서버에 저장되는 선택 칸이다(#3042).
    const id = row.id;
    const saved = team.value[id];
    const pending = team.pending?.rowId === id ? team.pending.input : undefined;
    const selected: TeamDefaultAiInput | null =
      pending !== undefined ? pending : saved ? { linkPosition: saved.linkPosition, modelId: saved.modelId } : null;
    const canPick = team.links.length > 0;
    if (!canPick) {
      // 확인 전에는 고를 모델을 모른다. 지어낸 목록 대신 저장된 값과 할 일을 말한다.
      // 저장된 연결이 바뀌었으면 그 문장(밑)이 할 일까지 순서대로 말한다.
      choice = <ReadOnlyBox>{teamChoiceText(id, saved)}</ReadOnlyBox>;
      if (team.offline) {
        // 확인 버튼도 잠긴 동안에는 「연결 확인을 하면」을 말하지 않는다.
        lines.push({ key: "note", text: TEAM_DEFAULTS_OFFLINE, tone: "muted" });
      } else if (!saved || saved.linkResolved) {
        lines.push({ key: "model", text: TEAM_DEFAULTS_CHECK_FIRST, tone: "muted" });
      }
    } else {
      teamEditable = true;
      const busy = pending !== undefined;
      const options = teamOptions(id, saved, team.links);
      const value = teamOptionKey(selected);
      const current = options.find((option) => option.key === value);
      choice = (
        <Select
          aria-labelledby={titleId}
          aria-describedby={describedBy}
          value={value}
          title={current?.text}
          className="h-control rounded-md text-meta"
          // 오프라인이면 잠근다(팀 연결 절의 확인·끊기와 같다). 저장이 날고 있는 동안은
          // 초점을 뺏지 않게 aria-disabled 로만 막는다: 두 번째 고름이 첫 저장과 경합하지 않게.
          disabled={team.offline}
          aria-disabled={busy || undefined}
          onChange={(event) => {
            if (busy) return;
            const picked = options.find((option) => option.key === event.target.value);
            if (picked) team.onChoose(id, picked.input);
          }}
          data-testid={`ai-default-${row.id}-select`}
        >
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.text}
            </option>
          ))}
        </Select>
      );
      const note = teamModelNote(selected, team.links);
      if (note) lines.push({ key: "model", text: note, tone: "muted" });
    }
    if (pending !== undefined) {
      lines.push({ key: "saved", text: "저장하고 있어요", tone: "muted" });
    }
    if (saved && !saved.linkResolved && pending === undefined) {
      lines.push({ key: "saved", text: linkUnresolvedSentence(saved, canPick), tone: "warn" });
    }
    if (canPick && team.offline) {
      lines.push({ key: "note", text: TEAM_DEFAULTS_OFFLINE, tone: "muted" });
    }
    if (team.saveError?.rowId === id) {
      lines.push({ key: "error", text: team.saveError.message, tone: "warn" });
    }
  } else {
    choice = <ReadOnlyBox>{resolved.using}</ReadOnlyBox>;
    if (row.id === "summary" && input.teamKey.status === "present" && resolved.state === "ok") {
      lines.push({ key: "model", text: modelLine({ kind: "teamKey" }, input.teamKey), tone: "muted" });
    }
  }
  if (resolved.state === "ok" && resolved.note) {
    lines.push({ key: "note", text: resolved.note, tone: "muted" });
  }
  if (resolved.state !== "ok") {
    lines.push({ key: "fallback", text: resolved.sentence, tone: "warn" });
  }

  return (
    <li
      className={cn("ai-default-row px-2 py-2", !last && "border-b border-line")}
      data-testid={`ai-default-${row.id}`}
      data-audience={row.audience}
      data-state={resolved.state}
    >
      <div data-slot="feature" className="flex min-w-0 flex-col">
        <span id={titleId} className="break-keep text-body font-semibold text-ink">
          {row.title}
        </span>
        <span className="break-keep text-meta text-ink-muted">{row.hint}</span>
      </div>
      <div data-slot="choice" className="flex min-w-0 flex-col gap-1">
        {choice}
        {lines.map((line) => (
          <span
            key={line.key}
            id={lineId(line.key)}
            className={cn(
              "break-keep text-timestamp",
              line.tone === "warn" ? "text-warn" : "text-ink-muted"
            )}
            data-testid={`ai-default-${row.id}-${line.key}`}
            role={line.key === "error" ? "alert" : undefined}
          >
            {line.text}
          </span>
        ))}
      </div>
      <span data-slot="who" className="flex h-control items-center text-meta">
        {personal ? (
          <span className="text-agent">내 설정</span>
        ) : teamEditable ? (
          <span className="text-ink-muted">운영자</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-ink-muted">
            <Lock className="size-3 shrink-0" aria-hidden="true" />
            운영자
          </span>
        )}
      </span>
    </li>
  );
}

function optionText(option: Pick<AiDefaultOption, "name" | "source" | "unavailable">): string {
  const base = option.source ? `${option.name} · ${option.source}` : option.name;
  return option.unavailable ? `${base} (${option.unavailable})` : base;
}

/** 시안 `.sel-box.ro`: 고를 수 없는 칸은 점선 테두리로 값만 보인다. */
function ReadOnlyBox({ children }: { children: string }) {
  return (
    // 잘린 값도 끝까지 읽을 수 있게 전체 글자를 title로 둔다(서버 주소는 길다).
    <span
      title={children}
      className="flex h-control min-w-0 items-center rounded-md border border-dashed border-line px-3 text-meta text-ink-muted"
    >
      <span className="truncate">{children}</span>
    </span>
  );
}
