import { useCallback, useLayoutEffect, useRef, useState, type ChangeEvent, type Ref } from "react";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import {
  CHANNEL_NAME_ISSUE_KEYS,
  CHANNEL_NAME_MAX,
  CHANNEL_CREATE_FAILURE_KEYS,
  CHANNEL_NAME_SERVER_REJECTED_KEY,
  channelNameIssue,
  normalizeChannelName,
  type ChannelNameIssue,
} from "@momo/core/features/channels/model";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// =============================================================================
// 채널 이름 칸 한 벌 (ADR-0225 D13). 채널 만들기 창(`CreateChannelDialog`)과 이름 바꾸기 창(`RenameChannelDialog`)이 같은 이 칸을
// 쓴다 — 둘째 구현을 만들면 한쪽만 조합 중 얼리기·자리 예약·미리보기가 빠진다. 칸 값은 치는 도중에 바꾸지 않고(한글 조합이 깨진다),
// 친 것과 저장될 이름이 다를 때만 아래에 저장될 이름을 말하고, 접는 것은 보낼 때 한다.
//
// 이 파일에 옮겨 온 것은 만들기 창에 있던 것 그대로다: 아래 줄 한 자리(`NameStatus`), 조합 중 아래 줄 얼리기, 자리 예약. 안내 글 ·
// 거절 문장 · 미리보기 문장은 사전 키로 화면 언어를 따른다. 직접 문구(칸 이름표 따위)는 부르는 창이 `label` 로 넘긴다.
// =============================================================================

/** 미리보기 줄의 이름 자리를 문장에서 떼어 내는 표시. 사전 문장은 `{name}`이 앞·뒤 어디에 서든 그대로 두고(언어마다 다르다), 이름만 한 줄에서 줄여 보인다. */
const PREVIEW_NAME_MARK = "\uE000";

/** 조합 중인 글자 가운데 한글(음절·자모)과 빈칸이 아닌 것이 있으면 아직 이름이 아니다(병음의 라틴 글자·`'`, 변환 전 가나). */
const NOT_YET_NAME = /[^\p{Script=Hangul}\s]/u;

/** 보이는 줄 수에 맞춰 미리보기를 말줄임하는 클래스(Tailwind가 글자 그대로 읽어야 해서 목록으로 둔다). */
const CLAMP = ["line-clamp-1", "line-clamp-2", "line-clamp-3", "line-clamp-4", "line-clamp-5", "line-clamp-6", "line-clamp-7", "line-clamp-8"];

/** 칸 아래 한 줄: 규칙 안내 · 저장될 이름 · 거절 문장 중 하나만 선다. 서는 자리는 하나이고, 서지 않은 문장들이 같은 칸에 보이지 않게 겹쳐 있어 줄 수가 가장 긴 문장으로 정해진다(칸이 문장에 따라 오르내리지 않는다). */
export function NameStatus({
  fieldId,
  hint,
  preview,
  error,
  reserve,
}: {
  fieldId: string;
  hint: string;
  /** 저장될 이름(접은 값, `#` 없이). 칸에 친 것과 같거나 거절이면 null. */
  preview: { name: string; before: string; after: string } | null;
  error: string | null;
  /** 이 자리에 설 수 있는 모든 문장(안내·거절·서버 응답). 높이만 정하고 보이지 않는다. */
  reserve: string[];
}) {
  // 자리에 예약된 줄 수. 미리보기는 그 안에서 줄바꿈하고(큰 글자에서 이름이 잘리지 않게), 넘치면 말줄임한다 — 높이는 예약이 정하므로 안 움직인다.
  const reserveRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState(1);
  useLayoutEffect(() => {
    const box = reserveRef.current;
    if (box === null) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(box).lineHeight);
      const next = lineHeight > 0 ? Math.round(box.getBoundingClientRect().height / lineHeight) : 1;
      setLines(Math.min(CLAMP.length, Math.max(1, next)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [reserve]);
  return (
    <div className="grid min-w-0" data-testid={`${fieldId}-status`}>
      <div ref={reserveRef} aria-hidden="true" className="invisible col-start-1 row-start-1 grid text-meta">
        {reserve.map((text) => (
          <p key={text} className="col-start-1 row-start-1 text-meta">
            {text}
          </p>
        ))}
      </div>
      <div className="col-start-1 row-start-1 min-w-0">
        {/* 낭독은 오류에만 건다(polite): 안내와 미리보기는 글자를 칠 때마다 바뀌어 조합 중 낭독이 쏟아진다. */}
        <div aria-live="polite" aria-atomic="true">
          {error ? (
            <p className="text-meta text-danger" id={`${fieldId}-error`} data-testid={`${fieldId}-error`}>
              {error}
            </p>
          ) : null}
        </div>
        {!error && preview ? (
          // 이름 쪽만 줄어든다: 앞말·뒷말은 줄지 않는 칸(shrink-0), 이름은 줄어드는 칸(min-w-0 + 예약된 줄 수만큼 말줄임).
          // 앞뒤 빈칸은 글자에 그대로 두고(낭독·복사는 한 문장) 눈에 보이는 간격은 gap이 만든다.
          <p
            className="flex min-w-0 items-end gap-x-1 text-meta text-ink-muted"
            id={`${fieldId}-preview`}
            data-testid={`${fieldId}-preview`}
          >
            {preview.before ? (
              <span className="max-w-full shrink-0 self-start" data-testid={`${fieldId}-preview-before`}>
                {preview.before}
              </span>
            ) : null}
            <span className={cn("min-w-0 break-all text-ink", CLAMP[lines - 1])} data-testid={`${fieldId}-preview-name`}>
              #{preview.name}
            </span>
            {preview.after ? (
              <span className="max-w-full shrink-0" data-testid={`${fieldId}-preview-after`}>
                {preview.after}
              </span>
            ) : null}
          </p>
        ) : null}
        {!error && !preview ? (
          <p className="text-meta text-ink-muted" id={`${fieldId}-hint`} data-testid={`${fieldId}-hint`}>
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** 이름 칸 아래 줄이 말하는 것: 거절(서버 응답 포함)이나 저장될 이름. 둘 다 없으면 안내 글이 선다. */
type NameLine = { error: string | null; preview: { name: string; before: string; after: string } | null };

/**
 * 진행 중인 조합(`compositionstart`부터). `text`는 조합 중인 글자, `frozen`은 한글이 아닌 글자가 조합에 든 순간 얼려 둔 줄이다.
 * 아래 줄은 「칸에 실제로 든 값으로 계산한 줄」이거나 이 얼린 줄, 둘 중 하나다 — 조합 글자를 칸 값에서 찾아 빼서 이름을 짐작하지 않는다.
 */
type Composition = { text: string; frozen: NameLine | null };

/** 조합이 스스로 내는 input 종류. 이것만 얼린 줄을 그대로 두고, 그 밖의 input(붙여 넣기·잘라 내기·끌어 놓기·실행 취소·다시 실행·지우기, 종류를 모르는 것)은 곧바로 녹인다. */
const COMPOSITION_INPUT_TYPES = new Set(["insertCompositionText", "deleteCompositionText", "insertFromComposition", "deleteByComposition"]);

/** 아래 줄 미리보기 문장: 만들기 창은 「…로 만들어져요」, 이름 바꾸기 창은 「…로 바뀌어요」. */
export type NamePreviewKey = "channels.nameRule.preview" | "channels.rename.preview";

export interface ChannelNameFieldState {
  hint: string;
  nameError: string | null;
  previewParts: { name: string; before: string; after: string } | null;
  reserve: string[];
  /** 한글이 아닌 조합이 진행 중이라 아래 줄이 얼어 있는가. 이 동안 보내기를 잠근다. */
  frozen: boolean;
  /** 얼린 줄을 녹인다(제출 · 창을 다시 엶). */
  thaw: () => void;
  onChangeInputType: (event: ChangeEvent<HTMLInputElement>) => void;
  onCompositionStart: () => void;
  onCompositionUpdate: (event: { data: string }) => void;
  onCompositionEnd: () => void;
  onBlur: () => void;
}

/**
 * 이름 칸 아래 줄이 말할 것을 정한다. `name` 은 칸에 든 그대로의 값, `serverError` 는 서버가 이 이름에 대해 한 말(편집하면 부르는 쪽이
 * 지운다), `attempted` 는 보내 본 적이 있는가(빈 칸 꾸중은 그다음부터), `reserveExtra` 는 이 자리에 설 수 있는 그 창만의 문장이다.
 */
export function useChannelNameField({
  name,
  attempted,
  serverError,
  previewKey,
  reserveExtra = [],
}: {
  name: string;
  attempted: boolean;
  serverError: string | null;
  previewKey: NamePreviewKey;
  reserveExtra?: string[];
}): ChannelNameFieldState {
  const formatMessage = useFormatMessage();
  const [composition, setComposition] = useState<Composition | null>(null);
  const issueMessage = (issue: ChannelNameIssue) => {
    if (issue === "tooLong") return formatMessage(CHANNEL_NAME_ISSUE_KEYS.tooLong, { max: CHANNEL_NAME_MAX });
    return formatMessage(CHANNEL_NAME_ISSUE_KEYS[issue]);
  };
  const hint = formatMessage("channels.nameRule.hint", { max: CHANNEL_NAME_MAX });
  /** 칸에 실제로 든 값으로 계산한 줄. */
  const lineFor = (value: string): NameLine => {
    const issue = channelNameIssue(value);
    // A rule is only worth stating once the reader has done something it applies
    // to: an untouched empty field is not a mistake, it is a field.
    const localError = issue !== null && (attempted || value.trim() !== "") ? issueMessage(issue) : null;
    // 거절이면 미리보기 대신 오류다. 친 것과 저장될 이름이 다를 때만 선다(「Design Review」 → #design-review).
    const saved = issue === null ? normalizeChannelName(value) : null;
    if (saved === null || saved === value) return { error: localError ?? serverError, preview: null };
    const [before = "", after = ""] = formatMessage(previewKey, { name: PREVIEW_NAME_MARK }).split(PREVIEW_NAME_MARK);
    return { error: localError ?? serverError, preview: { name: saved, before, after } };
  };
  // 아래 줄: 한글이 아닌 조합이 진행 중이면 얼려 둔 줄, 아니면 지금 칸 값의 줄. 둘 말고는 없다.
  const frozenLine = composition?.frozen ?? null;
  const liveLine = lineFor(name);
  const { error: nameError, preview: previewParts } = frozenLine ?? liveLine;
  // 마지막으로 그린 「칸 값의 줄」. 얼리는 순간 이 줄을 그대로 쥔다 — 엔진이 조합 글자를 칸에 언제 넣든(사건 앞이든 뒤든) 얼린 줄은 화면에 있던 줄이다.
  const drawnLine = useRef<NameLine>(liveLine);
  useLayoutEffect(() => {
    if (frozenLine === null) drawnLine.current = liveLine;
  });
  // 이 자리에 설 수 있는 문장 전부(줄 수가 가장 긴 것이 자리의 높이를 정한다). 409 문장도 사전 키다.
  // 서 있는 오류도 넣는다: 얼린 줄이 쥔 서버 문장은 편집으로 실패가 지워져도 녹을 때까지 서 있다.
  const reserve = [
    hint,
    ...(Object.keys(CHANNEL_NAME_ISSUE_KEYS) as ChannelNameIssue[]).map(issueMessage),
    formatMessage(CHANNEL_NAME_SERVER_REJECTED_KEY),
    formatMessage(CHANNEL_CREATE_FAILURE_KEYS.duplicate),
    ...reserveExtra,
    ...[serverError, nameError].filter((text): text is string => text !== null),
  ].filter((text, at, all) => all.indexOf(text) === at);

  const thaw = useCallback(() => setComposition(null), []);
  return {
    hint,
    nameError,
    previewParts,
    reserve,
    frozen: frozenLine !== null,
    thaw,
    // 조합이 스스로 낸 input이 아니면(붙여 넣기·잘라 내기·끌어 놓기·실행 취소·다시 실행·지우기) 녹인다. 엔진은 조합 구간을 덮어쓴
    // 붙여 넣기 뒤에 `compositionend` 없이 조합을 버리기도 한다 — 다음 `compositionstart`까지 줄은 칸 값을 따른다.
    onChangeInputType: (event) => {
      if (!COMPOSITION_INPUT_TYPES.has((event.nativeEvent as InputEvent).inputType ?? "")) setComposition(null);
    },
    onCompositionStart: () => setComposition({ text: "", frozen: null }),
    onCompositionUpdate: (event) => {
      const text = event.data;
      // 한글이 아닌 글자가 조합에 든 순간, 그때까지 그린 줄을 얼린다. 한글·빈칸뿐이면 얼리지 않는다.
      const drawn = drawnLine.current;
      setComposition((current) =>
        current === null ? null : { text, frozen: NOT_YET_NAME.test(text) ? (current.frozen ?? drawn) : null }
      );
    },
    onCompositionEnd: () => setComposition(null),
    onBlur: () => setComposition(null),
  };
}

/** 이름표 + 칸 + 아래 한 자리. `id` 가 `${id}-error | -preview | -hint | -status` 와 칸 자신의 `data-testid` 를 정한다. */
export function ChannelNameField({
  id,
  label,
  placeholder,
  value,
  onChange,
  field,
  inputRef,
  disabled,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  field: ChannelNameFieldState;
  inputRef?: Ref<HTMLInputElement>;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-meta text-ink-muted">
        {label}
      </label>
      <Input
        id={id}
        ref={inputRef}
        name="name"
        value={value}
        onChange={(event) => {
          field.onChangeInputType(event);
          onChange(event);
        }}
        onCompositionStart={field.onCompositionStart}
        onCompositionUpdate={field.onCompositionUpdate}
        onCompositionEnd={field.onCompositionEnd}
        onBlur={field.onBlur}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-invalid={field.nameError ? true : undefined}
        aria-describedby={
          field.nameError ? `${id}-error` : field.previewParts ? `${id}-preview` : `${id}-hint`
        }
        data-testid={id}
      />
      <NameStatus
        fieldId={id}
        hint={field.hint}
        preview={field.previewParts}
        error={field.nameError}
        reserve={field.reserve}
      />
    </div>
  );
}
