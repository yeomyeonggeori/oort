import type { DialogFocusTarget } from "@/design/ui/dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";

// =============================================================================
// 컴포저와 메시지 반응이 함께 쓰는 이모지 표면 (#1688).
//
// 피커 라이브러리를 쓰지 않는 것은 기존 ReactionPickerDialog의 결정 그대로다.
// 라이브러리는 폰트나 스프라이트를 싣기 쉽고, 이 앱은 외부 호스트가 막힌 CSP와
// 오프라인 Tauri 셸을 함께 낸다. 업무 대화에서 실제로 쓰는 고정 32종은 네트워크도
// 런타임 스타일도 필요 없고, 반응과 본문 삽입이 같은 어휘를 보게 한다.
//
// DialogTrigger는 두지 않는다. 두 소비자는 열기 전에 각각 메시지 행 또는 textarea의
// 선택 범위를 기록해야 하므로, 실제 button onClick이 open을 올리고 그 button을
// `opener`로 넘기는 정본 프로그래매틱 패턴을 쓴다.
// =============================================================================

// eslint-disable-next-line react-refresh/only-export-components -- 테스트가 공용 그리드의 닫힌 32종을 직접 센다.
export const PICKER_EMOJI = [
  "👍", "👎", "✅", "❌", "🙏", "🎉", "👀", "😄",
  "😂", "😅", "🤔", "😮", "😭", "🔥", "💯", "✨",
  "🚀", "🐛", "🛠️", "📌", "📝", "🔍", "⏳", "⚠️",
  "❤️", "💡", "🙌", "👏", "☕", "🍀", "🥲", "🫡",
] as const;

const COPY = {
  reaction: {
    title: "반응 고르기",
    description: "이 메시지에 남길 이모지를 고르세요.",
    action: "반응 남기기",
    itemPrefix: "picker-react",
  },
  insert: {
    title: "이모지 넣기",
    description: "메시지에 넣을 이모지를 고르세요.",
    action: "메시지에 넣기",
    itemPrefix: "picker-insert",
  },
} as const;

export function EmojiPickerDialog({
  open,
  onOpenChange,
  onPick,
  opener,
  purpose,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (emoji: string) => void;
  opener: DialogFocusTarget | null;
  purpose: keyof typeof COPY;
  testId: string;
}) {
  const copy = COPY[purpose];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        opener={opener}
        data-testid={testId}
        className="max-w-pane-sm gap-3 p-4"
      >
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription className="sr-only">
          {copy.description}
        </DialogDescription>
        <div className="grid grid-cols-8 gap-1">
          {PICKER_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              data-testid={`${copy.itemPrefix}-${emoji}`}
              aria-label={`${emoji} ${copy.action}`}
              onClick={() => {
                onPick(emoji);
                onOpenChange(false);
              }}
              className="tap-target flex size-control items-center justify-center rounded-sm text-title transition-colors hover:bg-surface-hover focus-visible:focus-ring"
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
