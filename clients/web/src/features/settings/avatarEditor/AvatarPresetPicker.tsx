import { useId } from "react";
import { Check } from "lucide-react";
import {
  AVATAR_EDITOR_COPY,
  AVATAR_PRESET_IDS,
  avatarPresetLabel,
  type AvatarPresetId,
} from "@momo/core/features/workspace/avatarEditor";
import { KOMETTO_EXPRESSION_NAMES } from "@momo/core/features/onboarding/guide";
import { cn } from "@/design/lib/cn";
import "./avatarEditor.css";

// 코메토 프리셋 고르기 (#4261): 정본 표정 여섯 장을 지금 고른 배경 위에서 **실제로 구워진 모습**으로 보여 준다.
// 타일의 그림은 올릴 PNG 와 같은 함수가 굽는다(`useAvatarRender.usePreviewUrl` 계열, 작은 크기). CSS 로 흉내 낸 자르기가
// 아니라서 타일에서 본 것이 저장되는 것이다. 굽는 동안(또는 못 구울 때)은 빈 칩이 서 있다.

export function AvatarPresetPicker({
  value,
  thumbs,
  onChange,
}: {
  value: AvatarPresetId;
  /** 표정 → `data:` 주소. 아직 구워지지 않은 표정은 없다. */
  thumbs: Readonly<Partial<Record<AvatarPresetId, string>>>;
  onChange: (preset: AvatarPresetId) => void;
}) {
  const groupName = useId();
  return (
    <div
      role="radiogroup"
      aria-label={AVATAR_EDITOR_COPY.presetLegend}
      className="flex flex-wrap gap-x-3 gap-y-2"
      data-testid="avatar-preset-picker"
    >
      {AVATAR_PRESET_IDS.map((id) => (
        <label key={id} className="avatar-choice press">
          <input
            type="radio"
            name={groupName}
            value={id}
            checked={value === id}
            onChange={() => onChange(id)}
            aria-label={avatarPresetLabel(id)}
            data-testid={`avatar-preset-${id}`}
            className="sr-only"
          />
          <span className="avatar-chip" data-size="art" aria-hidden="true">
            {thumbs[id] ? <img src={thumbs[id]} alt="" draggable={false} className="avatar-chip-image" /> : null}
            <span className="avatar-chip-check">
              <Check aria-hidden="true" className="size-4" />
            </span>
          </span>
          <span className={cn("text-meta", value === id ? "font-semibold text-ink" : "text-ink-muted")}>
            {KOMETTO_EXPRESSION_NAMES[id]}
          </span>
        </label>
      ))}
    </div>
  );
}
