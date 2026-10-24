import { Bold } from "lucide-react";
import { Button } from "@/design/ui/button";

// 도구 줄의 「서식」 (#4317). 서식 트레이는 글을 고르면 뜨는 것이 원래 길이고, 이 단추는 같은 트레이를
// 손으로 여는 두 번째 길이다. 선택이 없으면 캐럿의 낱말을 골라 연다(`useComposerFormat.openForSelection`).
// 글이 비었을 때만 흐리고(`aria-disabled`, 포커스는 받는다), 터치 기기는 OS 선택 콜아웃이 같은 자리를
// 쓰므로 단추 자체를 그리지 않는다.

export const COMPOSER_FORMAT_BUTTON_LABEL = "서식";
const TITLE = "서식 (굵게 ⌘B · 기울임 ⌘I)";

export function ComposerFormatButton({
  available,
  open,
  hasText,
  onPress,
  testId,
}: {
  available: boolean;
  open: boolean;
  hasText: boolean;
  onPress: () => void;
  testId: string;
}) {
  if (!available) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="tap-target shrink-0 aria-disabled:opacity-50"
      aria-label={COMPOSER_FORMAT_BUTTON_LABEL}
      aria-pressed={open}
      aria-disabled={hasText ? undefined : true}
      title={TITLE}
      data-testid={testId}
      // 누르는 순간 초점이 글 칸을 떠나면 선택이 접힌다. 마우스 누름만 막고, 키보드는 그대로 닿는다.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (hasText) onPress();
      }}
    >
      <Bold aria-hidden="true" />
    </Button>
  );
}
