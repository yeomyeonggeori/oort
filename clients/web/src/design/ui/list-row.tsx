import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/design/lib/cn";
import { Card } from "./card";

// =============================================================================
// 목록 줄 · 묶음 (#5782, owner 2026-11-13 QA 13 「컴포넌트로 구성할 때 따로 신경도 안쓴거야?」).
//
// 사람·에이전트처럼 「누구」를 한 줄씩 늘어놓는 목록의 웹 부품이다. 폰의 `GroupLabel`·`GroupCard`·
// `ListRow`(docs/design-system/phone-sheets.md §4)를 웹 문법으로 옮겼고, 묶음 그릇은 설정의
// `SettingsSection`(머리글 + `Card` 하나 + 행 사이 선 하나)과 같은 모양이다 — 웹에 이미 있던 묶음 문법을
// 다시 쓴다(README 「옳은 답이 바로 옆에 있었다」).
//
//   ListGroup        묶음 머리글(작은 회색 글 + 수) 위, 카드 하나 안에 줄들. 줄 사이는 `--line` 한 줄.
//   ListRow          앞 칸(아바타) · 두 층(제목 / 보조 한 줄) · 끝 칸(칩·표식). 줄 전체가 단추 하나다.
//   ListRowSkeleton  같은 줄을 같은 글자 역할의 줄 상자로 비워 둔 것 — 높이가 실제 줄과 같다.
//
// 높이 규칙: 줄의 높이는 **두 층의 줄 상자**(`text-body` + `text-meta`)가 정한다. 그래서 보조 줄은 늘 한
// 줄이고(넘치면 말줄임), 셋째 줄을 더하지 않는다. 스켈레톤은 막대 높이가 아니라 같은 글자 역할의 줄 상자로
// 높이를 얻으므로 글자 크기 설정(작게·기본·크게)을 따라 실제 줄과 함께 움직인다.
//
// 이 파일은 글자를 갖지 않는다. 제목·보조 줄·끝 칸의 낱말은 부르는 쪽이 사전 키로 넘긴다.
// =============================================================================

/** 줄 상자의 기하. 스켈레톤이 같은 값을 쓴다 — 둘이 갈라지면 목록이 도착 순간 움직인다. */
const ROW_CLASS = "flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left";

/** 두 층 기둥. 첫 층은 `text-body`, 둘째 층은 `text-meta` 의 줄 상자다. */
const STACK_CLASS = "flex min-w-0 flex-1 flex-col";
const TITLE_CLASS = "flex min-w-0 items-center gap-2 text-body";
const SUBTITLE_CLASS = "block min-w-0 truncate text-meta text-ink-muted";

/** 비어 있는 자리의 중립 막대(다른 스켈레톤과 같은 면). */
const BAR_CLASS = "rounded-sm bg-surface-hover";

export function ListGroup({
  label,
  count,
  children,
  testId,
  className,
}: {
  /** 묶음 머리글. 문장형 평문이다(대문자 라벨·번호 머리 금지, SKILL §8). */
  label: ReactNode;
  /** 머리글 옆 수(선택). 숫자 칸이라 `data-numeric`. */
  count?: ReactNode;
  /** `ListRow`·`ListRowSkeleton` 들. */
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      <h2
        id={headingId}
        className="flex min-w-0 items-baseline gap-2 px-4 text-meta font-semibold text-ink-muted"
      >
        <span className="min-w-0 truncate">{label}</span>
        {count !== undefined && count !== null ? (
          <span className="shrink-0 font-normal" data-numeric>
            {count}
          </span>
        ) : null}
      </h2>
      {/* 카드 하나가 묶음이다(「Card only when elevation means grouping」, SKILL §8). 줄은 카드 안의 평평한
          띠이고, 가리킴은 채움뿐이다(README §2.6 「전폭은 폭이다」 — 스케일 눌림 없음). */}
      <Card className="overflow-hidden">
        <ul className="flex flex-col divide-y divide-line">{children}</ul>
      </Card>
    </section>
  );
}

type ListRowProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> & {
  /** 앞 칸: 아바타(32) 하나. 접속 점은 아바타 상자 안에 앉아 줄 높이를 바꾸지 않는다. */
  leading: ReactNode;
  /** 첫 층: 이름과 그 곁의 짧은 표식(「나」·상태 칩·이모지). 이름 칸이 줄어든다. */
  title: ReactNode;
  /** 둘째 층: 보조 한 줄(「@핸들 · 이메일」). 늘 한 줄이고 넘치면 말줄임이다. */
  subtitle: ReactNode;
  /** 끝 칸: 역할 칩·생존 칩처럼 값이 아닌 표식. 이름보다 먼저 줄지 않는다. */
  trailing?: ReactNode;
  /** 바깥 `li` 의 시험 id(줄 단추에는 `data-testid` 를 그대로 넘긴다). */
  itemTestId?: string;
};

export const ListRow = forwardRef<HTMLButtonElement, ListRowProps>(
  function ListRow(
    { leading, title, subtitle, trailing, itemTestId, className, type, ...rest },
    ref
  ) {
    return (
      <li className="flex min-w-0" data-testid={itemTestId}>
        <button
          ref={ref}
          type={type ?? "button"}
          className={cn(
            ROW_CLASS,
            "hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring",
            className
          )}
          {...rest}
        >
          <span className="flex shrink-0">{leading}</span>
          <span className={STACK_CLASS}>
            <span className={TITLE_CLASS}>{title}</span>
            <span className={SUBTITLE_CLASS}>{subtitle}</span>
          </span>
          {trailing ? (
            <span className="flex shrink-0 items-center gap-2">{trailing}</span>
          ) : null}
        </button>
      </li>
    );
  }
);

/**
 * 도착 전의 줄. 막대는 `inline-block` 이라 감싼 블록의 줄 상자(`text-body` 22 · `text-meta` 18, 기본 글자
 * 크기)가 높이를 정한다 — 실제 줄의 두 층과 같은 상자다. 아바타 자리는 실제 아바타와 같은 32 원이다.
 */
export function ListRowSkeleton({ testId }: { testId?: string }) {
  return (
    <li className="flex min-w-0" aria-hidden="true" data-testid={testId}>
      <span className={ROW_CLASS}>
        <span className={cn(BAR_CLASS, "block size-8 shrink-0 rounded-full")} />
        <span className={STACK_CLASS}>
          <span className="block text-body">
            <span className={cn(BAR_CLASS, "inline-block h-3 w-action-sm align-middle")} />
          </span>
          <span className="block text-meta">
            <span className={cn(BAR_CLASS, "inline-block h-2 w-pane-sm align-middle")} />
          </span>
        </span>
      </span>
    </li>
  );
}
