import * as React from "react";
import { cn } from "@/design/lib/cn";

// 카드(rest) — 새벽하늘 (ADR-0189 D1·D7, DS2-1 #2713). 시안 A `.a-group`·`.a-card`:
// 반경 20, 흰 면(--surface), rest 그림자, 테두리 없음. 선으로 구획하던 옛 카드
// (`border-line`, 반경 10)가 「올드함」의 원인 하나였다(ADR-0189 Context). 고대비
// 설정에서만 `card-edge`가 --line-strong 1px를 두른다. 안 여백 14는 core
// `DENSITY.comfortable.cardPadding`이다.
export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-2xl card-edge bg-surface-raised text-ink shadow-sm",
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-card", className)} {...props} />;
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("text-body text-ink-muted", className)}
      {...props}
    />
  );
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-card pt-0", className)} {...props} />;
}
