import { Lock } from "lucide-react";
import {
  AI_DEFAULTS_NOT_APPLIED,
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
import { cn } from "@/design/lib/cn";
import { Select } from "@/design/ui/select";
import { AiFoot } from "./aiAccountsParts";
import { useAiDefaults, useMyAccounts, writeAiDefaults } from "./aiDefaultsStore";

// Reading this as: settings (AI 연결 · 기본 AI) for internal team users on web+Tauri,
// density 6/10, motion 1/10 (none added).

// =============================================================================
// 설정 › AI 연결 › 기본 AI (#2881 AA-8, 시안 §5 왼쪽 판, brief §4).
//
// 여섯 줄: 개인 셋(앱 명령·로컬 터미널·원격 작업)은 이 기기에 저장되는 선택 칸이고,
// 팀 셋(팀 에이전트·요약·가드레일)은 운영자 서버 설정이라 점선 칸으로 읽기만 한다.
// 선택지·폴백·저장은 코어 `aiDefaults.ts`가 판정한다. 이 파일은 그리기만 한다.
//
// 운영자 판정은 팀 연결 절과 같은 서버 응답이다(provider link GET: 운영자면 200, 아니면
// 403). 팀 행 값을 서버에 저장하는 경로는 아직 없어서 운영자에게도 읽기 전용이고,
// 그 사실을 표 밑 한 줄이 말한다.
// =============================================================================

const TEAM_FOOT_OPERATOR =
  "팀 줄은 운영자 설정이에요. 서버에 저장하는 칸이 아직 없어 지금은 서버가 정한 값을 보여 줘요.";
const TEAM_FOOT_MEMBER = "팀 줄은 이 서버의 운영자만 바꿀 수 있어요.";
const PERSONAL_FOOT =
  "내 구독은 나만 보는 결과에만 쓰입니다. 팀 에이전트와 요약은 내 구독으로 넘어가지 않습니다.";

export function AiDefaultsTable({
  teamKey,
  operator,
  browserTab,
}: {
  teamKey: AiDefaultsTeamKey;
  /** 서버가 운영자라고 답했나(200)·아니라고 답했나(403). 모르면 null. */
  operator: boolean | null;
  browserTab: boolean;
}) {
  const prefs = useAiDefaults();
  const accounts = useMyAccounts();
  const input: AiDefaultsInput = { accounts: accounts ?? [], teamKey, browserTab };
  return (
    <>
      <ul className="flex min-w-0 flex-col" aria-label="기능마다 부를 AI" data-testid="ai-defaults-table">
        {AI_DEFAULT_ROWS.map((row, index) => (
          <DefaultRow
            key={row.id}
            row={row}
            last={index === AI_DEFAULT_ROWS.length - 1}
            prefs={prefs}
            input={input}
            accountsKnown={accounts !== null}
          />
        ))}
      </ul>
      <AiFoot>{PERSONAL_FOOT}</AiFoot>
      <AiFoot>
        <span data-testid="ai-defaults-not-applied">{AI_DEFAULTS_NOT_APPLIED}</span>
      </AiFoot>
      {operator !== null && (
        <AiFoot>
          <span data-testid="ai-defaults-team-foot" data-operator={operator ? "yes" : "no"}>
            {operator ? TEAM_FOOT_OPERATOR : TEAM_FOOT_MEMBER}
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
}: {
  row: AiDefaultRow;
  last: boolean;
  prefs: AiDefaultsPrefs;
  input: AiDefaultsInput;
  accountsKnown: boolean;
}) {
  const titleId = `ai-default-${row.id}-title`;
  const resolved = resolveRow(row.id, prefs, input);
  const personal = row.audience === "me";
  const lines: { key: string; text: string; tone: "muted" | "warn" }[] = [];
  // 칸 밑 줄(모델·안내·폴백)은 선택 칸의 설명이다: 낭독기가 칸에서 경고를 듣는다.
  const lineId = (key: string) => `ai-default-${row.id}-${key}`;
  const describedBy = ["model", "note", "fallback"].map(lineId).join(" ");

  let choice;
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
          onChange={(event) => {
            const next = event.target.value;
            const picked = options.find((option) => option.key === next)?.ref ?? null;
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
          >
            {line.text}
          </span>
        ))}
      </div>
      <span data-slot="who" className="flex h-control items-center text-meta">
        {personal ? (
          <span className="text-agent">내 설정</span>
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
