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
// #5324: 그릇·도구 줄·보내기 알약은 두 입력창이 한 부품(`ComposerCard.tsx`)에서 받는다.
const card = source("./ComposerCard.tsx");
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
    // 이모지 단추는 한 부품(`ComposerTools`)이 그리고, 눌린 단추(`event.currentTarget`)를 두 입력창이 피커의 열림 자리로 받는다.
    expect(card).toContain("onOpenEmoji(event.currentTarget)");
    expect(channel).toContain("emoji.openPicker(opener)");
    expect(thread).toContain("emoji.openPicker(opener)");
    expect(picker).toContain("onOpenAutoFocus");
    expect(picker).toContain("autoFocusSearch={!isTouch}");
    expect(picker).toContain("onEscapeKeyDown={onEscapeKeyDown}");
    expect(picker).toContain("event.stopPropagation()");
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
      expect(composer).toContain("<ComposerTools");
      expect(composer).toContain("<AttachmentTray");
      // 세 트리거의 후보 소스도 한 벌이다: 두 컴포저가 같은 채널 스토어를
      // 기계에 넘긴다. 한쪽만 넘기면 스레드에서 `#` 이 조용히 빈 목록이 된다.
      expect(composer).toMatch(
        /useComposerAutocomplete\([\s\S]*?channels,/
      );
    }
    // 「+」 첨부 단추는 도구 줄 한 부품이 그린다.
    expect(card).toContain("<AttachButton");
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

  it("채널과 스레드가 같은 링크 미리보기 훅·카드 줄을 쓰고 ✕를 보낼 때 싣는다 (#5016)", () => {
    for (const composer of [channel, thread]) {
      expect(composer).toContain("useComposerLinkPreview(");
      expect(composer).toContain("<ComposerLinkPreview");
      // Esc 순서(멘션 목록 → 카드 → 인용)를 코어 규칙에 묻는 키 상태와, 켠 때만 가는 요청 필드.
      expect(composer).toContain("previewOpen: linkPreview.cards.length > 0");
      expect(composer).toContain("suppressUnfurl: true");
    }
    // 채널 입력창과 스레드 패널은 한 화면에 함께 서므로 시험 열쇠가 겹치지 않는다.
    expect(thread).toContain('testId="thread-composer-link-preview"');
    expect(thread).toContain("threadRootId: rootId");
  });

  it("채널과 스레드가 입력 다음에 +·@·이모지·서식·보내기 한 벌을 **같은 부품으로** 둔다 (#1749, #5324)", () => {
    for (const composer of [channel, thread]) {
      // 두 입력창이 같은 카드·도구 줄·보내기 알약을 쓴다 — 스레드가 자기 그릇과 손으로 만든 보내기 단추를 따로 그리던 것이 #5324 의 결함이었다.
      expect(composer).toContain("<ComposerCard");
      expect(composer).toContain("<ComposerTools");
      expect(composer).toContain("<ComposerSend");
      expect(composer).toContain("COMPOSER_TEXTAREA_CLASS");
      // 글 칸 다음에 도구 줄이 오는 순서는 카드 부품이 쥔다(`children` 다음에 도구 줄).
    }
    expect(channel).toContain('testIdPrefix="composer"');
    expect(thread).toContain('testIdPrefix="thread-composer"');
    // 한 줄의 순서: 도구(+ @ 이모지 서식) → 가운데 슬롯 → 보내기. 열쇠는 접두어 하나에서 나온다.
    expect(card).toMatch(
      /\{children\}[\s\S]*?\$\{testIdPrefix\}-actions[\s\S]*?\{tools\}[\s\S]*?\{meta\}[\s\S]*?\{send\}/
    );
    expect(card).toMatch(
      /<AttachButton[\s\S]*?\$\{testIdPrefix\}-mention-trigger[\s\S]*?\$\{testIdPrefix\}-emoji-trigger[\s\S]*?<ComposerFormatButton[\s\S]*?\$\{testIdPrefix\}-format-trigger/
    );
    expect(card).toMatch(/\$\{testIdPrefix\}-send/);
    // 서식 단추를 채널 입력창 혼자 갖고 있던 때의 열쇠는 이제 두 입력창에 같은 규칙으로 선다.
    expect(card.match(/\$\{testIdPrefix\}-mention-trigger/g)).toHaveLength(1);
    // 보내기는 `Button size="icon"` 알약 하나다(손으로 만든 `<button>` 이 아니다).
    expect(card).toMatch(/<Button\s+type=\{type\}\s+size="icon"/);
    expect(thread).not.toContain('data-testid="thread-composer-send"');
    expect(thread).not.toMatch(/<button\b[^>]*size-icon-button/);
  });

  it("스레드 입력창은 「대화에도 보내기」를 그리지도 보내지도 않는다 (#5324)", () => {
    expect(thread).not.toContain("alsoInChannel");
    expect(thread).not.toContain("also-in-channel");
    expect(thread).not.toContain('type="checkbox"');
    expect(channel).not.toContain("alsoInChannel");
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
      // 두 입력창은 같은 그릇 부품을 쓴다 — 포커스 링·빈 면적 클릭·표식이 한 곳에 있다(#5324).
      expect(composer).toContain("<ComposerCard");
      expect(composer).not.toContain("focus-within:focus-ring");
      expect(composer).not.toContain("focus:border");
    }
    expect(card).toContain("focus-visible-within:focus-ring");
    expect(card).not.toContain("focus-within:focus-ring");
    expect(card).not.toContain("focus:border");
    // 버튼과 첨부 카드(#5200: 초점을 받고 Backspace/Delete 로 빼는 자기 컨트롤)는 자기 클릭을 지킨다.
    // 그릇이 캐럿을 글 칸으로 돌려주면 방금 카드에 둔 초점이 튕겨 나간다.
    expect(card).toContain('event.target.closest("button, [data-attachment-card]")');
    expect(card).toContain("inputRef.current?.focus()");
    // 카드에 키보드 초점이 있으면 그릇의 링을 접는 규칙(tokens.css)이 이 표식으로 두 그릇을 잡는다(#5200).
    expect(card).toContain('data-composer-frame=""');
    expect(tokens).toMatch(
      /^\[data-composer-frame\]:has\(\[data-attachment-card\]:focus-visible\)\s*\{\s*outline:\s*none;/m
    );
    // 글 칸의 옷은 한 상수(`COMPOSER_TEXTAREA_CLASS`)다 — 두 입력창이 같은 인셋·글자·안내 문구 색을 쓴다(#5324).
    expect(channel).toMatch(/<textarea[\s\S]*?data-testid="composer-input"[\s\S]*?className=\{COMPOSER_TEXTAREA_CLASS\}/);
    expect(thread).toMatch(/<textarea[\s\S]*?data-testid="thread-composer-input"[\s\S]*?className=\{COMPOSER_TEXTAREA_CLASS\}/);
    const textareaClass = card.match(/COMPOSER_TEXTAREA_CLASS =\s*"([^"]*)"/)?.[1];
    expect(textareaClass).toBeDefined();
    expect(textareaClass).not.toContain("focus-visible:focus-ring");
    expect(textareaClass).toContain("outline-none");
    expect(textareaClass).toContain("focus-visible:outline-none");
    // 그릇은 한 부품이고, 보내는 중에는 그릇 전체가 50%로 흐려지며 안쪽 단추는 더 흐려지지 않는다.
    expect(card).toContain('sending && "opacity-50"');
    expect(card).toContain('settledWhenDisabled && "disabled:opacity-100"');
    expect(thread).toContain("settledWhenDisabled={sending}");
  });

  it("[@] 포인터 삽입은 키 입력 전용 작성 중 신호를 내보내지 않고 용어를 맞춘다", () => {
    expect(channel).toContain("onInsertMention={autocomplete.insertTrigger}");
    expect(card).toContain("onClick={onInsertMention}");
    expect(channel).not.toMatch(
      /onInsertMention=\{\(\) => \{\s*autocomplete\.insertTrigger\(\);\s*typing\.onInput\(\)/
    );
    // 접근 이름은 이제 트리거 표의 데이터다(#1930). 목록은 그 표만 읽는다.
    expect(machine).toContain('listLabel: "멘션 선택"');
    expect(machine).not.toContain('listLabel: "멤버 언급"');
    // 목록은 트리거 표에서 읽은 그 spec 하나만 본다(접근 이름도, 비동기
    // 소스의 문장도 — #1930 H-2 로 spec 이 문장을 하나 더 든다).
    expect(list).toContain("const spec = composerTriggerSpec(kind);");
    expect(list).toContain("aria-label={spec.listLabel}");
    expect(list).not.toMatch(/aria-label="[^"]/);
  });
});

describe("컴포저 스페이싱 폴리시 (#1688)", () => {
  it("액션 행은 아이콘 글리프를 textarea 텍스트 기둥의 4px 리듬 안에 둔다", () => {
    expect(spacing("3") - spacing("1")).toBe(spacing("2"));
    expect(channel).toMatch(/<form[^>]+className="[^"]*\bp-3\b[^"]*"/s);
    // 글 칸 인셋(px-3 py-2)과 액션 행(pb-2 pl-1 pr-2)은 두 입력창이 한 곳(`ComposerCard.tsx`)에서 받는다.
    expect(card).toMatch(/COMPOSER_TEXTAREA_CLASS =\s*"[^"]*\bpx-3\b[^"]*\bpy-2\b[^"]*"/);
    expect(card).toContain('className="flex items-center justify-between gap-2 pb-2 pl-1 pr-2"');
    expect(channel).toMatch(/<ComposerHint[\s\S]*?<TypingLine/);
  });

  it("스레드도 같은 입력 인셋과 닫힌 간격 단계만 쓴다", () => {
    expect(thread).toContain('<div className="p-3">');
    expect(thread).toMatch(/data-testid="thread-composer-input"[\s\S]*?className=\{COMPOSER_TEXTAREA_CLASS\}/);
    expect(spacing("3")).toBe(12);
    expect(spacing("6")).toBe(24);
  });
});
