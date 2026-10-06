import { useId, type ReactNode } from "react";
import { Card } from "@/design/ui/card";
import { cn } from "@/design/lib/cn";

// 설정 섹션 (#3578): (제목 + 선택 설명 + 선택 우측 액션) 아래 **카드 하나**. 카드 안은
// `SettingsRow`들이고 행 사이는 선 하나(`settings-card`)다. 제목은 sentence-case 평문이지
// 대문자 라벨이 아니다(SKILL §8). 카드는 `design/ui/Card`(반경 20, 면, rest 그림자)다.

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
  testId,
}: {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const headingId = useId();
  const hasHeader = Boolean(title || description || action);
  return (
    <section
      aria-labelledby={title ? headingId : undefined}
      data-testid={testId}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      {hasHeader ? (
        <div className="flex min-w-0 items-end gap-4 px-4">
          <div className="flex min-w-0 flex-1 flex-col gap-px">
            {title ? (
              <h2 id={headingId} className="break-keep text-meta font-semibold text-ink-muted">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="break-keep text-meta text-ink-muted">{description}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <Card className="settings-card">{children}</Card>
    </section>
  );
}
