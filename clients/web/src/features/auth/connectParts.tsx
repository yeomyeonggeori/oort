import type { ReactNode } from "react";
import { Globe } from "lucide-react";
import { Button } from "@/design/ui/button";
import { serverLabel } from "./entryInput";

// Reading this as: onboarding for internal team users on web+Tauri,
// density 5/10, motion 2/10.
//
// 로그인 전 세 화면(D0·D1·D1′)이 나눠 쓰는 조각. 값은 시안
// `claudedocs/onboarding-2.0/mockups.html`의 `.field`·`.chip`·`.svr`·`.divider`다.

/**
 * 시안 `.field`: 라벨(13/600 잉크 흐림) + 그릇 + 힌트나 오류. 오류가 있으면 힌트
 * 자리를 오류가 대신한다(문제 자리의 합니다체 오류, D11).
 */
export function OnboardingFieldBlock({
  id,
  label,
  optional = false,
  hint,
  hintId,
  error,
  errorId,
  errorTestId,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  hint?: string;
  hintId?: string;
  error?: string | null;
  errorId?: string;
  errorTestId?: string;
  children: ReactNode;
}) {
  return (
    <div className="onboarding-field-block">
      <label htmlFor={id} className="onboarding-field-label">
        {label}
        {optional && <span className="font-normal"> (선택)</span>}
      </label>
      {children}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="text-meta text-danger"
          data-testid={errorTestId}
        >
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-meta text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 시안 `.chip`: 이 화면이 어느 서버를 향하는지. [바꾸기]는 D0로 돌아간다.
 * 칩은 정보이고, 행동은 옆의 버튼 하나다.
 */
export function ServerChip({
  base,
  onChange,
  changeDisabled = false,
}: {
  base: string;
  onChange?: () => void;
  changeDisabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="connect-server-chip">
      <span className="onboarding-chip">
        <Globe className="size-4 shrink-0" aria-hidden="true" />
        <span className="sr-only">서버 </span>
        <b className="min-w-0 truncate font-semibold text-ink" data-testid="connect-server-chip-host">
          {serverLabel(base)}
        </b>
      </span>
      {onChange && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-ink-muted"
          onClick={onChange}
          disabled={changeDisabled}
          aria-label={`서버 바꾸기 (${serverLabel(base)})`}
          data-testid="connect-server-change"
        >
          바꾸기
        </Button>
      )}
    </div>
  );
}

/** 시안 `.divider`: 가는 선 사이의 작은 제목. 목록의 이름표다. */
export function OnboardingDivider({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="onboarding-divider">
      {children}
    </p>
  );
}

/**
 * 시안 `.svr`: 발견·최근 서버 한 줄. 초록 점은 「이 네트워크에서 방금 보였다」는
 * 사실에만 선다(최근 서버는 살아 있는지 모르므로 점이 없다).
 */
export function ServerRow({
  name,
  base,
  detail,
  live,
  onGo,
  testId,
}: {
  name: string;
  base: string;
  /** 둘째 줄. 없으면 스킴을 뗀 주소. */
  detail?: string;
  live: boolean;
  onGo: () => void;
  testId: string;
}) {
  return (
    <li className="onboarding-server-row glass" data-testid={testId}>
      {live ? (
        <span className="onboarding-server-dot" aria-hidden="true" />
      ) : null}
      <span className="min-w-0 flex-1">
        <b className="block truncate text-body font-semibold text-ink">{name}</b>
        <span className="block truncate font-mono text-meta text-ink-muted">
          {detail ?? serverLabel(base)}
        </span>
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="onboarding-action-sm"
        data-variant="secondary"
        onClick={onGo}
        aria-label={`${name} 서버로 가기`}
        data-testid={`${testId}-go`}
      >
        여기로
      </Button>
    </li>
  );
}
