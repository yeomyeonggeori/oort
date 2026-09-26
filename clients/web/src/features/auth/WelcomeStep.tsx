import { useState, type FormEvent, type ReactNode, type Ref } from "react";
import { assertGuideLine } from "@momo/core/features/onboarding/guide";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { IS_TAURI } from "@/lib/env";
import { openExternalUrl } from "@/lib/tauri";
import { KomettoFace } from "@/features/onboarding/guide/KomettoFace";
import {
  ONBOARDING_ACTION_CLASS,
  ONBOARDING_FIELD_CLASS,
} from "@/features/onboarding/guide/OnboardingFrame";
import type { ConnectGuide } from "./connectGuide";
import {
  OnboardingDivider,
  OnboardingFieldBlock,
  ServerRow,
} from "./connectParts";
import { serverLabel } from "./entryInput";
import type { DiscoveredServer } from "./discovery";

// Reading this as: onboarding for internal team users on web+Tauri,
// density 5/10, motion 2/10.

/** 셀프호스트 첫날 문서의 「비밀번호 클레임」 절(#2808 Acceptance). */
export const SELF_HOST_CLAIM_DOC_URL =
  "https://github.com/yeomyeonggeori/oort/blob/main/docs/SELF_HOST_FIRST_DAY.ko.md#%EB%B9%84%EB%B0%80%EB%B2%88%ED%98%B8-%ED%81%B4%EB%A0%88%EC%9E%84";

export const ENTRY_PLACEHOLDER = "https://team.example.com 또는 초대 링크";

/**
 * D0 환영 (ADR-0193 D7·D11, #2808 OB2-2). 시안 「D0 환영 · 세 진입점」.
 *
 * 왼쪽은 히어로(코메토 280 + oort + 한 줄 소개), 오른쪽은 말풍선 질문 「어디로
 * 갈까요?」와 입력 한 칸, [계속], 그 아래 발견·최근 서버 줄, 맨 아래 작은 링크
 * [처음 설치했어요]. 진행 점은 없다. 좁은 창에서는 위아래로 쌓인다.
 */
export function WelcomeStep({
  guide,
  entry,
  onEntryChange,
  entryError,
  onSubmit,
  entryRef,
  discovery,
  recent,
  onPickServer,
  sameOriginHint,
  notices,
  footer,
}: {
  guide: ConnectGuide;
  entry: string;
  onEntryChange: (value: string) => void;
  entryError: string | null;
  onSubmit: () => void;
  entryRef?: Ref<HTMLInputElement>;
  discovery: { servers: DiscoveredServer[]; available: boolean; searching: boolean };
  recent: readonly string[];
  onPickServer: (base: string, source: "discovered" | "recent") => void;
  /** 브라우저에서 이 페이지를 낸 서버로 갈 수 있을 때, 빈 칸의 뜻. */
  sameOriginHint: boolean;
  notices?: ReactNode;
  footer?: ReactNode;
}) {
  const [selfHostOpen, setSelfHostOpen] = useState(false);
  const line = assertGuideLine(guide.line);
  const discoveredBases = new Set(discovery.servers.map((server) => server.base));
  const recentOnly = recent.filter((base) => !discoveredBases.has(base));
  const hint = sameOriginHint
    ? "초대 링크를 붙여 넣으면 이메일만 물어요. 비워 두면 이 페이지의 서버로 들어가요."
    : "초대 링크를 붙여 넣으면 이메일만 물어요. claim 링크도 여기 붙여 넣으면 돼요.";

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <div className="onboarding-welcome" data-testid="onboarding-welcome" data-onboarding-screen="welcome">
      <div className="onboarding-welcome-hero">
        <KomettoFace expression={guide.expression} size="hero" />
        <p className="onboarding-welcome-wordmark" data-testid="onboarding-wordmark">
          oort
        </p>
        <p className="break-keep text-body text-ink-muted" data-testid="onboarding-tagline">
          사람과 에이전트가 같은 자리에서 일하는 메신저.
        </p>
      </div>
      <div className="onboarding-welcome-form">
        <div
          className="kometto-guide-bubble"
          aria-live="polite"
          aria-atomic="true"
          data-testid="kometto-guide-bubble"
          data-expression={guide.expression}
        >
          <h1
            className="break-keep text-title font-semibold text-ink"
            data-testid="kometto-guide-line"
          >
            {line}
          </h1>
          {guide.detail && (
            <p className="break-keep text-body text-ink-muted">{guide.detail}</p>
          )}
        </div>
        {notices}
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <OnboardingFieldBlock
            id="connect-entry"
            label="팀 주소나 초대 링크"
            hint={hint}
            hintId="connect-entry-hint"
            error={entryError}
            errorId="connect-entry-error"
            errorTestId="connect-entry-error"
          >
            <Input
              id="connect-entry"
              ref={entryRef}
              className={ONBOARDING_FIELD_CLASS}
              type="text"
              inputMode="url"
              autoComplete="url"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={ENTRY_PLACEHOLDER}
              value={entry}
              onChange={(event) => onEntryChange(event.target.value)}
              aria-invalid={entryError !== null || undefined}
              aria-describedby={entryError ? "connect-entry-error" : "connect-entry-hint"}
              data-testid="connect-entry"
            />
          </OnboardingFieldBlock>
          <Button
            type="submit"
            className={ONBOARDING_ACTION_CLASS}
            data-testid="connect-entry-submit"
          >
            계속
          </Button>
        </form>

        {discovery.available && (
          <section aria-labelledby="discovered-servers-title" className="flex flex-col gap-3" data-testid="connect-discovery">
            <OnboardingDivider id="discovered-servers-title">
              이 네트워크에서 찾은 서버
            </OnboardingDivider>
            {discovery.servers.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {discovery.servers.map((server) => (
                  <ServerRow
                    key={server.base}
                    name={server.displayHost}
                    base={server.base}
                    live
                    onGo={() => onPickServer(server.base, "discovered")}
                    testId="connect-discovery-item"
                  />
                ))}
              </ul>
            ) : (
              <p
                className="break-keep text-center text-meta text-ink-muted"
                data-testid="connect-discovery-empty"
              >
                {discovery.searching
                  ? "이 네트워크에서 팀 서버를 찾고 있어요."
                  : "이 네트워크에서는 찾은 서버가 없어요. 팀 주소를 받았다면 위 칸에 붙여 넣어요."}
              </p>
            )}
          </section>
        )}

        {recentOnly.length > 0 && (
          <section aria-labelledby="recent-servers-title" className="flex flex-col gap-3" data-testid="connect-recent-servers">
            <OnboardingDivider id="recent-servers-title">최근에 들어간 서버</OnboardingDivider>
            <ul className="flex flex-col gap-2">
              {recentOnly.map((base) => (
                <ServerRow
                  key={base}
                  name={serverLabel(base)}
                  base={base}
                  detail={base}
                  live={false}
                  onGo={() => onPickServer(base, "recent")}
                  testId="connect-recent-server"
                />
              ))}
            </ul>
          </section>
        )}

        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            className="tap-target press rounded-sm text-meta text-ink-muted underline underline-offset-4 hover:text-ink focus-visible:focus-ring"
            aria-expanded={selfHostOpen}
            aria-controls="connect-self-host"
            onClick={() => setSelfHostOpen((open) => !open)}
            data-testid="connect-self-host-toggle"
          >
            처음 설치했어요 (셀프호스트)
          </button>
          {selfHostOpen && (
            <p
              id="connect-self-host"
              className="break-keep text-center text-meta text-ink-muted"
              data-testid="connect-self-host"
            >
              설치가 끝날 때 나온 claim 링크(…/claim/…)를 위 칸에 붙여 넣으세요. 링크를
              잃었다면{" "}
              <a
                href={SELF_HOST_CLAIM_DOC_URL}
                target="_blank"
                rel="noreferrer"
                className="press rounded-sm text-ink underline underline-offset-4 focus-visible:focus-ring"
                data-testid="connect-self-host-doc"
                onClick={(event) => {
                  // Tauri 창에서 target=_blank는 아무것도 열지 않는다(lib/tauri.ts).
                  if (!IS_TAURI) return;
                  event.preventDefault();
                  void openExternalUrl(SELF_HOST_CLAIM_DOC_URL);
                }}
              >
                셀프호스트 첫날 안내의 「비밀번호 클레임」 절
              </a>
              을 보세요.
            </p>
          )}
        </div>
        {footer}
      </div>
    </div>
  );
}
