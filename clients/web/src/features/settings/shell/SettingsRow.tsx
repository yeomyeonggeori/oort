import type { ReactNode } from "react";
import { cn } from "@/design/lib/cn";

// 설정 행 (#3578): 왼쪽에 라벨과 설명, 오른쪽에 컨트롤. 카드 폭이 34rem 아래이면 컨트롤이
// 아래로 내려온다(`settings-row`가 컨테이너 질의로 한다). 변형:
//   stack  처음부터 세로. 입력칸처럼 폭이 필요한 컨트롤.
//   align="start"  컨트롤이 여러 줄일 때(스와치) 위 정렬.
//   keep   좁아도 접지 않는다(세그먼트처럼 줄어들 수 없는 짧은 컨트롤은 라벨이 접힌다).
// `labelId`·`descriptionId`는 컨트롤이 `aria-labelledby`·`aria-describedby`로 건다.

export function SettingsRow({
  label,
  description,
  children,
  stack = false,
  keep = false,
  align = "center",
  labelId,
  descriptionId,
  className,
  testId,
  role,
  plain = false,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  stack?: boolean;
  keep?: boolean;
  align?: "center" | "start";
  labelId?: string;
  descriptionId?: string;
  className?: string;
  testId?: string;
  role?: "alert" | "status";
  /** 라벨이 제목이 아니라 한 문장이다(안내·오류): 굵게 하지 않는다. */
  plain?: boolean;
}) {
  return (
    <div
      className={cn("settings-row", className)}
      data-stack={stack ? "" : undefined}
      data-keep={keep ? "" : undefined}
      data-align={align === "start" ? "start" : undefined}
      data-testid={testId}
      role={role}
    >
      <div className="flex min-w-0 flex-col gap-px">
        <div id={labelId} className={cn("break-keep text-body text-ink", !plain && "font-semibold")}>
          {label}
        </div>
        {description ? (
          <div id={descriptionId} className="break-keep text-meta text-ink-muted">
            {description}
          </div>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}
