// =============================================================================
// 컴포저 `/` 명령 (#2942 GC-1). 후보와 해석은 여기 한 곳이다.
//
// 슬래시 목록의 줄은 **레지스트리의 `client` 명령**에서만 나온다
// (`slashCommands()`). 목록에 줄을 하나 더 세우는 일은 레지스트리 항목에
// `slash`를 붙이는 일이고, 이 파일도 컴포저도 다시 열지 않는다.
//
// 규칙(brief §3.1, 결재 Q2):
//   - 메시지 **맨 앞**의 `/`에서만 연다. 문장 중간의 `/`(경로, `and/or`)는 본문이다.
//     그 앵커는 컴포저 파서가 지고, 이 파일은 `/` 뒤의 글자만 받는다.
//   - 정본 `/연결`, 별칭 `/connect`·`/ai`. 인자 `claude`·`codex`·`팀키`.
//   - 알 수 없는 `/무엇`은 **평문**이다. 막지 않는다 — 후보가 없으면 목록이 서지
//     않고, 전송은 그대로 메시지다(`parseSlashCommand`가 null).
//   - 슬래시로 연 명령은 **전송되지 않는다**. 이 파일이 명령을 알아본 본문은
//     컴포저가 보내지 않고 실행한다.
//
// 폰(GC-4)도 이 파일을 쓴다. 그래서 순수 TS이고 렌더 이름(아이콘)만 건넨다.
// =============================================================================

import {
  slashCommands,
  type Command,
  type CommandIcon,
  type LocalCardArgs,
  type SlashArg,
  type SlashSpec,
} from "./registry";

/** 슬래시 목록 한 줄. */
export interface SlashCandidate {
  /** 목록 key. `ai.connect` · `ai.connect:claude`. */
  readonly id: string;
  readonly commandId: string;
  /** 줄 이름. `/연결` · `/연결 claude`. */
  readonly label: string;
  /** 줄 아래 흐린 설명. */
  readonly hint: string;
  readonly icon: CommandIcon;
  /** 실행할 때 명령에 싣는 의도. */
  readonly args: LocalCardArgs;
  /**
   * `label` 앞에서부터 사람이 **이미 친** 글자 수(`/` 포함). 목록이 그 앞머리를
   * 강조한다(시안 ① `<u>/연</u>결`).
   */
  readonly matched: number;
}

/** 슬래시 목록의 줄 상한. 다른 트리거와 같은 자다. */
export const SLASH_CANDIDATE_LIMIT = 6;

const fold = (text: string) => text.toLocaleLowerCase("ko-KR");

function names(spec: SlashSpec): readonly string[] {
  return [spec.name, ...spec.aliases];
}

function argNames(arg: SlashArg): readonly string[] {
  return [arg.value, ...arg.aliases];
}

function row(
  command: Command,
  name: string,
  arg: SlashArg | null,
  matched: number
): SlashCandidate {
  const spec = command.slash as SlashSpec;
  const label = arg === null ? `/${name}` : `/${name} ${arg.value}`;
  return {
    id: arg === null ? command.id : `${command.id}:${arg.value}`,
    commandId: command.id,
    label,
    hint: arg === null ? spec.hint : arg.hint,
    icon: arg === null ? command.icon : arg.icon,
    args: arg === null ? {} : arg.args,
    matched: Math.min(matched, label.length),
  };
}

/**
 * `/` 뒤의 글자(`query`)에 맞는 줄.
 *
 * - 공백이 없으면 이름의 **앞머리**로 고른다. `/연` → `/연결`과 그 인자 줄들.
 *   별칭으로 맞으면 줄 이름도 그 별칭이다(`/con` → `/connect`): 사람이 친 글자와
 *   화면의 이름이 달라 보이면 그 줄이 왜 거기 있는지 알 수 없다.
 * - 공백이 하나 있으면 앞은 이름과 **정확히** 같아야 하고, 뒤는 인자의 앞머리다.
 * - 그 밖(공백 둘 이상, 줄바꿈)은 명령이 아니다.
 */
export function slashCandidates(
  query: string,
  commands: readonly Command[] = slashCommands(),
  limit = SLASH_CANDIDATE_LIMIT
): SlashCandidate[] {
  if (/\n/.test(query)) return [];
  const parts = query.split(" ");
  if (parts.length > 2) return [];
  const [head, tail] = parts;
  const needle = fold(head);
  const out: SlashCandidate[] = [];

  for (const command of commands) {
    const spec = command.slash;
    if (spec === undefined) continue;
    if (tail === undefined) {
      const name = names(spec).find((candidate) => fold(candidate).startsWith(needle));
      if (name === undefined) continue;
      const typed = 1 + head.length;
      out.push(row(command, name, null, typed));
      for (const arg of spec.args) out.push(row(command, name, arg, typed));
      continue;
    }
    const name = names(spec).find((candidate) => fold(candidate) === needle);
    if (name === undefined) continue;
    const argNeedle = fold(tail);
    const typed = 1 + head.length + 1 + tail.length;
    if (argNeedle === "") out.push(row(command, name, null, typed));
    for (const arg of spec.args) {
      if (argNames(arg).some((candidate) => fold(candidate).startsWith(argNeedle))) {
        out.push(row(command, name, arg, typed));
      }
    }
  }
  return out.slice(0, limit);
}

/** 본문 전체가 명령 하나로 읽히면 그 명령과 인자. */
export interface ParsedSlashCommand {
  readonly command: Command;
  readonly args: LocalCardArgs;
}

/**
 * 보내려는 본문이 **정확히** 알려진 명령인가.
 *
 * 목록을 Esc로 닫고 ↵를 눌러도 `/연결`은 메시지가 되지 않아야 한다(명령은
 * 전송되지 않는다). 그래서 전송 직전에 이 함수가 한 번 더 묻는다. 기준은 좁다:
 * 이름(또는 별칭) 하나, 그리고 알려진 인자 하나까지. `/연결 해 주세요`처럼
 * 모르는 말이 붙으면 평문이다.
 */
export function parseSlashCommand(
  body: string,
  commands: readonly Command[] = slashCommands()
): ParsedSlashCommand | null {
  const text = body.trim();
  if (!text.startsWith("/") || /\n/.test(text)) return null;
  const parts = text.slice(1).split(/\s+/);
  if (parts.length > 2 || parts[0] === "") return null;
  const [head, tail] = parts;
  for (const command of commands) {
    const spec = command.slash;
    if (spec === undefined) continue;
    if (!names(spec).some((name) => fold(name) === fold(head))) continue;
    if (tail === undefined) return { command, args: {} };
    const arg = spec.args.find((candidate) =>
      argNames(candidate).some((name) => fold(name) === fold(tail))
    );
    return arg === undefined ? null : { command, args: arg.args };
  }
  return null;
}

/** id로 슬래시 명령을 찾는다. 목록 줄을 실행할 때 쓴다. */
export function slashCommandById(
  id: string,
  commands: readonly Command[] = slashCommands()
): Command | null {
  return commands.find((command) => command.id === id) ?? null;
}
