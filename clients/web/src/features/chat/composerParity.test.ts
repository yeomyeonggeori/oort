import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PICKER_EMOJI } from "@/features/emoji/EmojiPickerDialog";
import { insertMention, mentionQueryAt } from "./composerAutocomplete";
import { insertMentionTriggerAtComposerSelection } from "./composerInsertion";

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const channel = source("./Composer.tsx");
const thread = source("../timeline/ThreadComposer.tsx");
const machine = source("./composerAutocomplete.ts");
const list = source("./ComposerAutocompleteList.tsx");
const actions = source("../timeline/MessageActions.tsx");
const picker = source("../emoji/EmojiPickerDialog.tsx");
const panel = source("../emoji/EmojiPickerPanel.tsx");
const row = source("../timeline/MessageRow.tsx");
const shell = source("./ChatShell.tsx");
const tokens = source("../../design/tokens.css");

function spacing(step: string): number {
  const match = tokens.match(
    new RegExp(`^\\s*--spacing-${step}:\\s*([\\d.]+)px;`, "m")
  );
  if (!match) throw new Error(`tokens.css에 --spacing-${step}가 없다`);
  return Number(match[1]);
}

describe("컴포저 공용 표면 (#1688)", () => {
  it("반응·채널·스레드가 한 이모지 피커를 쓴다", () => {
    expect(actions).not.toContain("PICKER_EMOJI");
    expect(actions).not.toContain("ReactionPickerDialog");
    expect(channel).toContain("<EmojiPickerDialog");
    expect(thread).toContain("<EmojiPickerDialog");
    expect(picker).toContain("purpose: keyof typeof COPY");
    expect(new Set(PICKER_EMOJI).size).toBe(32);
  });

  it("피커는 programmatic popover/sheet 한 패턴만 쓴다", () => {
    expect(picker).toContain("opener={opener}");
    expect(picker).toContain("<Popover open={open} onOpenChange={onOpenChange} modal>");
    expect(picker).toContain("<Dialog open={open} onOpenChange={onOpenChange}>");
    expect(picker).not.toMatch(/<DialogTrigger|import[^;]+DialogTrigger/);
    expect(picker).not.toMatch(/<PopoverTrigger|import[^;]+PopoverTrigger/);
    expect(channel).toContain("emoji.openPicker(event.currentTarget)");
    expect(thread).toContain("emoji.openPicker(event.currentTarget)");
    expect(picker).toContain("onOpenAutoFocus");
    expect(picker).toContain("autoFocusSearch={!isTouch}");
    expect(picker).toContain("onEscapeKeyDown={onEscapeKeyDown}");
    expect(panel).not.toContain("event.stopPropagation()");
    expect(row).toContain("triggerRef={actionTriggerRef}");
    expect(row).toContain("openReactionPicker(actionTriggerRef.current)");
    expect(row).toContain("<MessageHoverToolbar");
    expect(actions).toContain("useFrequentEmojis");
  });

  it("채널과 스레드가 같은 자동완성 목록·첨부 트레이를 쓴다", () => {
    for (const composer of [channel, thread]) {
      expect(composer).toContain("useComposerAutocomplete");
      expect(composer).toContain("<ComposerAutocompleteList");
      expect(composer).toContain("<AttachButton");
      expect(composer).toContain("<AttachmentTray");
      // 세 트리거의 후보 소스도 한 벌이다: 두 컴포저가 같은 채널 스토어를
      // 기계에 넘긴다. 한쪽만 넘기면 스레드에서 `#` 이 조용히 빈 목록이 된다.
      expect(composer).toMatch(
        /useComposerAutocomplete\([\s\S]*?channels,/
      );
    }
    // 그리고 그 스토어는 셸이 이미 들고 있던 것이다 — 새 서버 표면이 아니다.
    expect(shell).toContain("channels={channelsQuery.groups.channels}");
    expect(shell.match(/channels=\{channelsQuery\.groups\.channels\}/g)).toHaveLength(2);
  });

  it("채널과 스레드가 같은 선택 서식 트레이를 쓰고 초안 저장 경로를 우회하지 않는다 (#1902)", () => {
    for (const composer of [channel, thread]) {
      expect(composer).toContain("useComposerFormat");
      expect(composer).toContain("<ComposerFormatTray");
      expect(composer).toContain('data-composer-shell=""');
      expect(composer).toContain("selectionEpoch={format.selectionEpoch}");
      expect(composer).toContain("onValueChange: autocomplete.replaceValue");
      expect(composer).toContain("format.handleKeyDown(event)");
      expect(composer).toContain("format.dismiss()");
    }
    expect(channel).toContain('testIdPrefix="composer-format"');
    expect(thread).toContain('testIdPrefix="thread-composer-format"');
    expect(channel).toContain("writeDraft(workspaceId, channelId, next)");
    expect(channel).toMatch(
      /useComposerFormat\([\s\S]*?onValueChange: autocomplete\.replaceValue/
    );
    expect(thread).toMatch(
      /useComposerFormat\([\s\S]*?onValueChange: autocomplete\.replaceValue/
    );
  });

  it("채널과 스레드가 입력 다음에 @·첨부·이모지·보내기 한 벌을 둔다 (#1749)", () => {
    expect(channel).toMatch(
      /data-testid="composer-input"[\s\S]*?data-testid="composer-mention-trigger"[\s\S]*?<AttachButton[\s\S]*?data-testid="composer-emoji-trigger"[\s\S]*?data-testid="composer-send"/
    );
    expect(thread).toMatch(
      /data-testid="thread-composer-input"[\s\S]*?data-testid="thread-composer-mention-trigger"[\s\S]*?<AttachButton[\s\S]*?data-testid="thread-composer-emoji-trigger"[\s\S]*?data-testid="thread-composer-send"/
    );
    expect(channel.match(/data-testid="composer-mention-trigger"/g)).toHaveLength(
      1
    );
    expect(
      thread.match(/data-testid="thread-composer-mention-trigger"/g)
    ).toHaveLength(1);
  });

  it("[@]은 선택을 보존하고 선택 끝에서 기존 멘션 쿼리를 즉시 연다 (#1749)", () => {
    const inserted = insertMentionTriggerAtComposerSelection("배포 담당자 확인", {
      start: 3,
      end: 6,
    });
    expect(inserted).toEqual({ value: "배포 담당자 @ 확인", caret: 8 });
    expect(mentionQueryAt(inserted.value, inserted.caret)).toEqual({
      start: 7,
      text: "",
    });
    for (const composer of [channel, thread]) {
      expect(composer).toContain("autocomplete.insertTrigger");
    }
  });

  it.each([
    ["문장 끝", "배포 로그 확인해주세요", 12],
    ["한글 단어 뒤", "안녕하세요", 5],
    ["영문 단어 뒤", "deploy", 6],
    ["문장부호 뒤", "확인,", 3],
    ["[@] 연타", "@", 1],
  ])("[@] 클릭은 %s의 비공백 뒤에서도 목록 쿼리를 연다", (_name, value, caret) => {
    const inserted = insertMentionTriggerAtComposerSelection(value, {
      start: caret,
      end: caret,
    });
    expect(mentionQueryAt(inserted.value, inserted.caret)).toEqual({
      start: inserted.caret - 1,
      text: "",
    });
  });

  it("멘션은 현재 토큰만 바꾸고 삽입 뒤에 캐럿을 둔다", () => {
    const value = "배포 전에 @her 확인";
    const caret = "배포 전에 @her".length;
    const query = mentionQueryAt(value, caret);
    expect(query).not.toBeNull();
    expect(insertMention(value, caret, query!, "hermes")).toEqual({
      value: "배포 전에 @hermes  확인",
      caret: "배포 전에 @hermes ".length,
    });
  });

  it("그릇이 입력 포커스·빈 면적 클릭을 맡고 버튼은 자기 클릭을 지킨다 (#1749)", () => {
    for (const composer of [channel, thread]) {
      expect(composer).toContain("focus-visible-within:focus-ring");
      expect(composer).not.toContain("focus-within:focus-ring");
      expect(composer).not.toContain("focus:border");
      expect(composer).toContain('event.target.closest("button")');
      expect(composer).toContain(".current?.focus()");
    }
    const channelInputClass = channel.match(
      /<textarea[\s\S]*?data-testid="composer-input"[\s\S]*?className="([^"]*)"\s*\/>/
    )?.[1];
    const threadInputClass = thread.match(
      /<textarea[\s\S]*?data-testid="thread-composer-input"[\s\S]*?className="([^"]*)"\s*\/>/
    )?.[1];
    expect(channelInputClass).toBeDefined();
    expect(threadInputClass).toBeDefined();
    expect(channelInputClass).not.toContain("focus-visible:focus-ring");
    expect(threadInputClass).not.toContain("focus-visible:focus-ring");
    expect(channelInputClass).toContain("outline-none");
    expect(channelInputClass).toContain("focus-visible:outline-none");
    expect(threadInputClass).toContain("outline-none");
    expect(threadInputClass).toContain("focus-visible:outline-none");
    expect(thread).toContain('sending && "opacity-50"');
    expect(thread).toContain(
      'sending ? "disabled:opacity-100" : "disabled:opacity-50"'
    );
  });

  it("[@] 포인터 삽입은 키 입력 전용 작성 중 신호를 내보내지 않고 용어를 맞춘다", () => {
    expect(channel).toContain("onClick={autocomplete.insertTrigger}");
    expect(channel).not.toMatch(
      /onClick=\{\(\) => \{\s*autocomplete\.insertTrigger\(\);\s*typing\.onInput\(\)/
    );
    // 접근 이름은 이제 트리거 표의 데이터다(#1930). 목록은 그 표만 읽는다.
    expect(machine).toContain('listLabel: "멘션 선택"');
    expect(machine).not.toContain('listLabel: "멤버 언급"');
    expect(list).toContain("aria-label={composerTriggerSpec(kind).listLabel}");
  });
});

describe("컴포저 스페이싱 폴리시 (#1688)", () => {
  it("액션 행은 아이콘 글리프를 textarea 텍스트 기둥의 4px 리듬 안에 둔다", () => {
    expect(spacing("3") - spacing("1")).toBe(spacing("2"));
    expect(channel).toMatch(/<form[^>]+className="[^"]*\bp-3\b[^"]*"/s);
    expect(channel).toMatch(
      /data-testid="composer-input"[\s\S]*?className="[^"]*\bpx-3\b[^"]*\bpy-2\b[^"]*"/
    );
    expect(channel).toContain(
      'className="flex items-center justify-between gap-2 pb-2 pl-1 pr-2"'
    );
    expect(channel).toMatch(
      /data-testid="composer-actions"[\s\S]*?<ComposerHint[\s\S]*?<TypingLine/
    );
  });

  it("스레드도 같은 입력 인셋과 닫힌 간격 단계만 쓴다", () => {
    expect(thread).toContain('<div className="p-3">');
    expect(thread).toMatch(
      /data-testid="thread-composer-input"[\s\S]*?className="[^"]*\bpx-3\b[^"]*\bpy-2\b[^"]*"/
    );
    expect(spacing("3")).toBe(12);
    expect(spacing("6")).toBe(24);
  });
});
