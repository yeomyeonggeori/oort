import { forwardRef, type ReactNode } from "react";
import { Lock, MoreHorizontal, WifiOff, X } from "lucide-react";
import { cn } from "@/design/lib/cn";

// =============================================================================
// 설정 › AI 연결의 부품 (#2877). 시안: claudedocs/ai-accounts/mockups.html §1·§6.
//
// 목록은 평평한 행이고(카드로 싸지 않음) 곁판만 `sheet` 판이다(제안서 §3.1).
// 줄 하나는 「로고 · 이름과 라벨 · 출처 알약 · 상태 · 작은 사용량 · ⋯」이다. 줄의
// 격자는 tokens.css `ai-acct-row`가 진다(그릇 폭으로 접힌다).
// =============================================================================

/** 시안 `.pill`. 색만으로 전하지 않는다: 알약 안에 늘 낱말이 있다. */
export type AiPillTone = "ok" | "warn" | "bad" | "mute";

const PILL_TONE: Record<AiPillTone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-danger-soft text-danger",
  mute: "bg-muted-soft text-ink-muted",
};

export function AiPill({ tone, children }: { tone: AiPillTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex w-max items-center whitespace-nowrap rounded-full px-2 py-1 text-timestamp font-semibold leading-none",
        PILL_TONE[tone]
      )}
      data-tone={tone}
    >
      {children}
    </span>
  );
}

/** 시안 `.src`: 출처 알약(구독 / API 키 / 내부용). */
export function AiSource({ children }: { children: ReactNode }) {
  return (
    <span className="me-1 inline-flex rounded-sm bg-muted-soft px-1 py-px text-timestamp font-semibold text-ink-muted">
      {children}
    </span>
  );
}

/** 시안 `.lg`: 로고 칸. 글자 한두 개를 싣는다(회사 로고 자산은 쓰지 않는다). */
export function AiLogo({ mark, large = false }: { mark: string; large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center border border-line font-bold text-ink",
        large ? "ai-logo-lg rounded-lg bg-surface text-body" : "ai-logo rounded-md bg-surface-muted text-meta"
      )}
    >
      {mark}
    </span>
  );
}

/** 시안 `.sec-h`: 절 머리. 제목 · 범위(이 맥 / 이 서버) · 빈칸 · 자물쇠 · 행동. */
export function AiSectionHead({
  id,
  title,
  scope,
  locked = false,
  action,
}: {
  id: string;
  title: string;
  scope?: string;
  locked?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3 border-b border-line pb-2">
      <h3 id={id} className="text-body font-bold text-ink">
        {title}
      </h3>
      {scope && <span className="text-meta text-ink-muted">{scope}</span>}
      <span className="flex-1" />
      {locked && (
        <span className="inline-flex items-center gap-1 text-meta text-ink-muted">
          <Lock className="size-3 shrink-0" aria-hidden="true" />
          운영자 설정
        </span>
      )}
      {action}
    </div>
  );
}

/** 한 절. `aria-labelledby`로 머리 제목에 묶인다. */
export function AiSection({
  labelledBy,
  children,
  testId,
}: {
  labelledBy: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="flex min-w-0 flex-col" aria-labelledby={labelledBy} data-testid={testId}>
      {children}
    </section>
  );
}

/**
 * 시안 §6 「비어 있음」: 한 줄 + 한 행동. 가운데 그림이 아니라 줄 자리에 선다.
 */
export function AiLineRow({
  children,
  action,
  last = false,
  testId,
  surface,
}: {
  children: ReactNode;
  action?: ReactNode;
  last?: boolean;
  testId?: string;
  surface?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 px-2 py-3 sm:flex-row sm:items-center",
        !last && "border-b border-line"
      )}
      data-testid={testId}
      data-surface={surface}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1 break-keep text-body text-ink">{children}</div>
      {action && <div className="shrink-0 self-start sm:self-center">{action}</div>}
    </div>
  );
}

/** 시안 `.foot`. */
export function AiFoot({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} className="break-keep pt-2 text-meta text-ink-muted">
      {children}
    </p>
  );
}

/**
 * 시안 `.acct`: 계정 줄. 줄 어디를 눌러도 곁판이 열리고, 키보드 길은 ⋯ 버튼
 * 하나다(줄 전체를 버튼으로 만들면 안에 버튼을 둘 수 없다).
 */
export const AiAccountRow = forwardRef<
  HTMLButtonElement,
  {
    mark: string;
    name: ReactNode;
    /** 이름 옆 표지(기본 ★). 이름이 말줄임으로 잘려도 사라지지 않게 칸 밖에 선다. */
    badge?: ReactNode;
    detail: ReactNode;
    state: ReactNode;
    use: ReactNode;
    moreLabel: string;
    selected: boolean;
    asideId: string;
    onOpen: () => void;
    testId?: string;
  }
>(function AiAccountRow(
  { mark, name, badge, detail, state, use, moreLabel, selected, asideId, onOpen, testId },
  moreRef
) {
  return (
    // 줄 클릭은 포인터의 지름길이고 같은 일을 ⋯ 버튼이 키보드로 한다.
    <div
      className={cn(
        "ai-acct-row cursor-pointer px-2 py-3",
        selected ? "rounded-md bg-surface-hover" : "border-b border-line hover:bg-surface-hover"
      )}
      data-testid={testId}
      data-selected={selected ? "" : undefined}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button,a")) return;
        onOpen();
      }}
    >
      <span data-slot="logo">
        <AiLogo mark={mark} />
      </span>
      <div data-slot="name" className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1 text-body font-semibold text-ink">
          <span className="truncate">{name}</span>
          {badge}
        </span>
        <span className="truncate text-meta text-ink-muted">{detail}</span>
      </div>
      <div data-slot="state" className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
        {state}
      </div>
      <div data-slot="use" className="min-w-0 text-meta text-ink-muted">
        {use}
      </div>
      <button
        ref={moreRef}
        type="button"
        data-slot="more"
        aria-label={moreLabel}
        aria-expanded={selected}
        aria-controls={selected ? asideId : undefined}
        onClick={onOpen}
        className="ai-more tap-target press grid place-items-center rounded-md text-icon hover:bg-surface-hover focus-visible:focus-ring"
        data-testid={testId ? `${testId}-more` : undefined}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
});

/** 시안 `.aside`: 곁판. `sheet` 판 위에 `surface` 카드들이 선다. */
export function AiAside({
  id,
  label,
  mark,
  title,
  subtitle,
  onClose,
  headingRef,
  children,
  testId,
}: {
  id: string;
  label: string;
  mark: string;
  title: string;
  subtitle: string;
  onClose: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <aside
      id={id}
      aria-label={label}
      className="flex min-w-0 flex-col gap-4 rounded-xl bg-sheet p-4"
      data-testid={testId}
    >
      <div className="flex min-w-0 items-center gap-3">
        <AiLogo mark={mark} large />
        <div className="flex min-w-0 flex-1 flex-col">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="break-keep text-title font-bold text-ink focus-visible:focus-ring"
          >
            {title}
          </h3>
          <span className="break-keep text-meta text-ink-muted">{subtitle}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="곁판 닫기"
          className="tap-target press grid size-icon-button shrink-0 place-items-center rounded-md text-icon hover:bg-surface-hover focus-visible:focus-ring"
          data-testid={testId ? `${testId}-close` : undefined}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      {children}
    </aside>
  );
}

/** 시안 `.card`: 곁판 안의 카드. */
export function AiCard({
  title,
  trailing,
  children,
  testId,
}: {
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg bg-surface p-4 shadow-sm" data-testid={testId}>
      <div className="flex min-w-0 items-center gap-2">
        <h4 className="flex-1 text-meta font-bold text-ink">{title}</h4>
        {trailing}
      </div>
      {children}
    </div>
  );
}

/**
 * 시안 §6 「오프라인」: 인라인 배너 하나(`.banner.warn`). 설정 셸의 일반 배너
 * 대신 선다. 이 페이지는 두 절이 서로 다르게 끊기므로(팀은 서버, 내 계정은 이 맥)
 * 일반 문장으로는 무엇을 쓸 수 있는지 말하지 못한다.
 */
export function AiOfflineBanner() {
  return (
    <div
      className="flex min-w-0 items-start gap-3 rounded-md bg-warn-soft px-3 py-2 text-body text-ink"
      role="status"
      data-testid="ai-offline-banner"
    >
      <WifiOff className="mt-1 size-4 shrink-0 text-warn" aria-hidden="true" />
      <p className="min-w-0 break-keep">
        <b className="font-semibold">서버와 연결이 끊겼어요.</b> 팀 연결은 마지막으로 받은 값을
        보여 주고, 바꾸기는 다시 연결된 뒤에 할 수 있어요. 내 계정(이 맥)은 그대로 쓸 수 있어요.
      </p>
    </div>
  );
}
