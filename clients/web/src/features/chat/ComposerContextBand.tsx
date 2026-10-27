import type { ReactNode } from "react";
import { cn } from "@/design/lib/cn";
import type { ComposerContextHost } from "./composerContext";

// 입력창 카드 맨 위에 붙는 맥락 띠 (#4317, Codex 입력창의 「폴더·이 컴퓨터」 띠). 카드 **안**의 첫 줄이라
// 입력창과 한 덩어리로 보이고, 실을 것이 없으면 호출부가 그리지 않는다(빈 띠 없음).

export function ComposerContextBand({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col border-b border-line"
      data-testid="composer-context-band"
    >
      {children}
    </div>
  );
}

export function ComposerHostChip({ host }: { host: ComposerContextHost }) {
  return (
    <p
      className="flex items-center gap-2 px-4 py-2 text-meta text-ink-muted"
      data-testid="composer-context-host"
      data-online={host.online ? "" : undefined}
      data-routine={host.routine === true ? "" : undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          host.online ? "bg-ok" : "border border-ink-muted"
        )}
      />
      <span className="min-w-0 truncate">{host.text}</span>
    </p>
  );
}
