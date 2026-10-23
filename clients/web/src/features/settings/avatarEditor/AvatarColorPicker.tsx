import { useId, useLayoutEffect, useRef } from "react";
import { Check } from "lucide-react";
import { AVATAR_EDITOR_COPY } from "@momo/core/features/workspace/avatarEditor";
import {
  AVATAR_BACKGROUNDS,
  avatarBackgroundByHex,
  type AvatarBackground,
  type AvatarBackgroundId,
} from "@momo/core/features/workspace/avatarPalette";
import { Input } from "@/design/ui/input";
import "./avatarEditor.css";

// 배경색 고르기 (#4261): 정해진 팔레트 열다섯 칸 + 직접 입력 한 칸. 두 길이 한 값(`bg`)을 쓴다.
//
// 칩의 색은 core 표에서 와서 마운트할 때 CSS 변수 하나로 넘어간다(`WallpaperRow` 의 칩과 같은 길: 색 글자는 core 에만
// 있고, 칠하는 규칙은 `avatarEditor.css` 의 `.avatar-chip` 이 쥔다). 라디오가 칩의 몸이라 방향키와 한 번의 탭 정차,
// 그룹 이름은 브라우저가 한다.
//
// **판정 통과 때만 저장된다**: 지금 고른 그림이 그 색 위에서 묻히면(`blocked`) 칩은 흐려져 고를 수 없고, 직접
// 입력한 색이 묻히면 아래 한 줄이 이유를 말한다(그 줄은 편집기가 `colorProblem` 으로 넘긴다). 마지막 저장 길(`composeAvatarPng`)은
// 이 화면의 상태와 무관하게 한 번 더 판정한다.

function Swatch({
  entry,
  selected,
  blocked,
  groupName,
  onSelect,
}: {
  entry: AvatarBackground;
  selected: boolean;
  blocked: boolean;
  groupName: string;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    ref.current?.style.setProperty("--avatar-chip-color", entry.hex);
  }, [entry.hex]);
  return (
    <label className="avatar-choice press">
      <input
        type="radio"
        name={groupName}
        value={entry.id}
        checked={selected}
        disabled={blocked}
        onChange={onSelect}
        aria-label={entry.label}
        data-testid={`avatar-color-${entry.id}`}
        className="sr-only"
      />
      <span ref={ref} className="avatar-chip" aria-hidden="true">
        <span className="avatar-chip-check">
          <Check aria-hidden="true" className="size-4" />
        </span>
      </span>
    </label>
  );
}

export function AvatarColorPicker({
  bg,
  text,
  blocked,
  problem,
  disabled = false,
  onPalette,
  onText,
  onTextBlur,
}: {
  /** 지금 쓰는 배경(소문자 `#rrggbb`). 팔레트 칸이면 그 칸이 켜지고, 아니면 어느 칸도 켜지지 않는다. */
  bg: string;
  /** 직접 입력 칸의 글자. 쓰는 중에는 `bg` 와 다를 수 있다(아직 `#rrggbb` 가 아닌 글자). */
  text: string;
  /** 지금 그림이 묻혀서 고를 수 없는 칸. 비어 있으면(표본이 아직 없다) 모두 고를 수 있다. */
  blocked: Readonly<Partial<Record<AvatarBackgroundId, boolean>>>;
  /** 직접 입력한 색 아래에 말할 한 줄(꼴 오류 또는 묻힘). 없으면 `null`. */
  problem: string | null;
  disabled?: boolean;
  onPalette: (entry: AvatarBackground) => void;
  onText: (value: string) => void;
  onTextBlur: () => void;
}) {
  const groupName = useId();
  const legendId = useId();
  const inputId = useId();
  const problemId = useId();
  const selected = avatarBackgroundByHex(bg);
  const anyBlocked = AVATAR_BACKGROUNDS.some((entry) => blocked[entry.id]);
  return (
    <div className="flex flex-col gap-2" data-testid="avatar-color-picker">
      <p id={legendId} className="text-meta text-ink-muted">
        {AVATAR_EDITOR_COPY.colorLegend}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={legendId}
        className="flex flex-wrap gap-x-2 gap-y-1"
      >
        {AVATAR_BACKGROUNDS.map((entry) => (
          <Swatch
            key={entry.id}
            entry={entry}
            selected={selected?.id === entry.id}
            blocked={disabled || blocked[entry.id] === true}
            groupName={groupName}
            onSelect={() => onPalette(entry)}
          />
        ))}
      </div>
      {anyBlocked ? (
        <p className="text-meta text-ink-muted" data-testid="avatar-color-blocked-hint">
          {AVATAR_EDITOR_COPY.colorBlockedHint}
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-meta text-ink-muted">
          {AVATAR_EDITOR_COPY.colorFreeLabel}
        </label>
        <Input
          id={inputId}
          value={text}
          maxLength={7}
          disabled={disabled}
          placeholder={AVATAR_EDITOR_COPY.colorFreeHint}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? problemId : undefined}
          className="max-w-pane-sm font-mono"
          data-testid="avatar-color-input"
          onChange={(event) => onText(event.currentTarget.value)}
          onBlur={onTextBlur}
        />
        {problem ? (
          <p id={problemId} role="alert" className="text-meta text-danger" data-testid="avatar-color-problem">
            {problem}
          </p>
        ) : null}
      </div>
    </div>
  );
}
