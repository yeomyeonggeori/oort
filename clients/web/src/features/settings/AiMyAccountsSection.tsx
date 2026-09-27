import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import type { LocalHarnessId, LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import {
  AI_CONNECT_ROW_COPY,
  AI_CONNECT_SERVER_OFF_NOTE,
  harnessPill,
  type HarnessPill,
} from "@momo/core/features/onboarding/aiConnect";
import { harnessPillView } from "@momo/core/features/settings/aiLinkPill";
import {
  RELOGIN_LABEL,
  addSubscriptionCreateFailed,
  destructiveActionLabel,
  myAccountRowDetail,
  myAccountRowTitle,
  myAccountRows,
  restoreHiddenLine,
  type HarnessProfileRef,
  type MyAccountRow,
} from "@momo/core/features/settings/harnessProfiles";
import { Button } from "@/design/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { Skeleton } from "@/features/common/States";
import { IS_TAURI } from "@/lib/env";
import {
  harnessProfileCreate,
  harnessProfileList,
  harnessProfileRemove,
  harnessProfileStatus,
} from "@/lib/tauri";
import { AI_CONNECT_REENTRY_PATH, openAiConnectReentry } from "@/features/welcome/aiConnectReentry";
import { HarnessLoginDialog } from "@/features/welcome/harnessLogin/HarnessLoginDialog";
import { HarnessUnlinkDialog } from "@/features/welcome/harnessLogin/HarnessUnlinkDialog";
import { useSubscriptionEntryState } from "@/features/welcome/SubscriptionAgentEntry";
import { useLocalHarnessWatch } from "@/features/welcome/useLocalHarnessWatch";
import { AddSubscriptionDialog, type AddSubscriptionDraft } from "./AddSubscriptionDialog";
import { AiFoot, AiLineRow, AiLogo, AiPill, AiSection, AiSectionHead, AiSource } from "./aiAccountsParts";
import {
  MY_ACCOUNTS_BROWSER_LINE,
  MY_ACCOUNTS_DENIED_DETAIL,
  MY_ACCOUNTS_EMPTY_DETAIL,
  MY_ACCOUNTS_EMPTY_LINE,
  myAccountsBrowserTab,
  readHiddenDefaults,
  readProbeFixture,
  readProfilesFixture,
  readUnlinkFixture,
  writeHiddenDefaults,
} from "./aiMyAccountsModel";

// =============================================================================
// 설정 › AI 연결 › 내 계정 · 이 맥 (#2877 틀, #2938 감지, #2878 연결 지점).
//
// 이 절이 싣는 것은 이 맥의 공식 CLI 구독이다. 줄은 두 종류다(코어
// `harnessProfiles.ts`).
//
// - **기본 로그인**: 설치된 CLI마다 한 줄. 사용자가 원래 터미널에서 쓰던 로그인이다.
//   ⋯ › 「목록에서 빼기」만 있고 로그아웃하지 않는다(Q2). 뺀 목록은 이 기기에만 둔다.
// - **oort 프로필**: 「구독 추가」가 만든 계정 폴더(ADR-0191 D1). ⋯ › 「다시 로그인」은
//   #2816 로그인 모달을 **그 프로필로** 열고, 「연결 해제」는 숨은 PTY에서 공식 CLI
//   로그아웃 → 셸이 확인한 뒤 폴더 삭제(ADR-0190 D3-f).
//
// 「구독 추가」는 CLI와 라벨을 받아 셸에 폴더를 만들게 하고, 로그인 모달을 그 프로필로
// 연다. 연결되면 목록에 새 줄이 선다. 실패·취소면 그 폴더를 지우고(셸이 로그인 안 됨을
// 확인한 뒤) 추가 창으로 돌아온다(시안 §4 2a).
//
// 로그인 모달·해제 창은 채팅 연결 카드(#2961)·온보딩과 **같은 부품**이다
// (`HarnessLoginDialog`). 이 절은 프로필 인자만 더 넘긴다.
//
// 브라우저 탭에는 이 맥의 CLI가 없다. 그 탭에서는 이유 한 줄만 둔다(시안 §6).
// =============================================================================

export const MY_ACCOUNTS_HEADING_ID = "ai-my-accounts-title";

const OWN_ACCOUNT_FOOT =
  "본인 계정만 추가하세요. 이 계정은 이 맥에서 나만 씁니다. 팀 에이전트는 이 계정을 쓰지 않습니다.";

const PROFILES_KEY = ["local", "harness-profiles"] as const;

export function AiMyAccountsSection() {
  const state = useSubscriptionEntryState();
  const browserTab = myAccountsBrowserTab(state, IS_TAURI);
  useReentryFocusReturn();

  return (
    <AiSection labelledBy={MY_ACCOUNTS_HEADING_ID} testId="ai-my-accounts">
      <AiSectionHead id={MY_ACCOUNTS_HEADING_ID} title="내 계정" scope="이 맥" />
      {state === "pending" && !browserTab ? (
        <Skeleton ready={false} rows={1} className="py-3" />
      ) : browserTab ? (
        <AiLineRow testId="subscription-entry" surface="desktop-only" last>
          <span data-testid="subscription-entry-detail">{MY_ACCOUNTS_BROWSER_LINE}</span>
        </AiLineRow>
      ) : state === "rows" ? (
        <MyAccountRows />
      ) : (
        <AiLineRow testId="subscription-entry" surface={state} last>
          <span>{MY_ACCOUNTS_EMPTY_LINE}</span>
          {state === "server-off" && (
            <span className="text-meta text-ink-muted" data-testid="subscription-entry-detail">
              {AI_CONNECT_SERVER_OFF_NOTE}
            </span>
          )}
          {state === "denied" && (
            <span className="text-meta text-ink-muted" data-testid="subscription-entry-detail">
              {MY_ACCOUNTS_DENIED_DETAIL}
            </span>
          )}
        </AiLineRow>
      )}
    </AiSection>
  );
}

/**
 * 재진입(AI 연결 화면)을 닫고 설정으로 돌아오면 초점을 「구독 추가」로 돌린다
 * (#2909 review M3). 재진입은 셸 위의 층이라 이 절은 그동안 마운트돼 있다.
 */
function useReentryFocusReturn() {
  useEffect(() => {
    let last = window.location.hash;
    const onHash = () => {
      const was = last;
      last = window.location.hash;
      if (!was.startsWith(`#${AI_CONNECT_REENTRY_PATH}`) || last.startsWith(`#${AI_CONNECT_REENTRY_PATH}`)) {
        return;
      }
      // 셸의 inert가 풀린 다음 프레임에 옮긴다.
      window.requestAnimationFrame(() => {
        const target =
          document.querySelector<HTMLElement>("[data-testid='subscription-entry-open']") ??
          document.getElementById(MY_ACCOUNTS_HEADING_ID);
        target?.focus({ preventScroll: false });
      });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
}

interface LoginTarget {
  harness: LocalHarnessId;
  profile: string | null;
  /** 「구독 추가」가 방금 만든 폴더인가: 연결되지 않고 닫히면 지운다. */
  fresh: AddSubscriptionDraft | null;
}

function profileKey(profile: HarnessProfileRef): string {
  return `${profile.harness}/${profile.label}`;
}

function MyAccountRows() {
  const client = useQueryClient();
  const probeFixture = readProbeFixture();
  const profilesFixture = readProfilesFixture();
  const unlinkFixture = readUnlinkFixture();
  const harness = useLocalHarnessWatch({
    enabled: true,
    fixture: probeFixture ? { probes: probeFixture } : null,
  });
  const profilesQuery = useQuery({
    queryKey: PROFILES_KEY,
    queryFn: harnessProfileList,
    enabled: profilesFixture === null,
    retry: false,
  });
  const profiles = profilesFixture?.profiles ?? profilesQuery.data ?? [];
  const statusQueries = useQueries({
    queries: profiles.map((profile) => ({
      queryKey: [...PROFILES_KEY, "status", profile.harness, profile.label],
      queryFn: () => harnessProfileStatus(profile),
      enabled: profilesFixture === null,
      retry: false,
    })),
  });
  const statusOf = (profile: HarnessProfileRef): LocalHarnessProbe | null => {
    if (profilesFixture) return profilesFixture.status[profileKey(profile)] ?? null;
    const at = profiles.findIndex((row) => profileKey(row) === profileKey(profile));
    return at === -1 ? null : (statusQueries[at]?.data ?? null);
  };

  const [hidden, setHidden] = useState<LocalHarnessId[]>(readHiddenDefaults);
  const [login, setLogin] = useState<LoginTarget | null>(null);
  const loginConnected = useRef(false);
  const [adding, setAdding] = useState<{ draft: AddSubscriptionDraft | null } | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [unlink, setUnlink] = useState<Pick<MyAccountRow, "harness" | "profile"> | null>(
    unlinkFixture && profilesFixture ? { harness: "claude", profile: "회사" } : null
  );
  const addRef = useRef<HTMLButtonElement>(null);
  const unlinkOpener = useRef<HTMLElement | null>(null);

  const refreshProfiles = useCallback(() => {
    void client.invalidateQueries({ queryKey: PROFILES_KEY });
  }, [client]);

  if (harness.probes === null) {
    return <Skeleton ready={false} rows={1} className="py-3" />;
  }
  const installed = harness.probes.filter((probe) => probe.installed).map((probe) => probe.id);
  const rows = myAccountRows({ probes: harness.probes, profiles, hiddenDefaults: hidden });
  const hiddenInstalled = hidden.filter((id) => installed.includes(id));
  const takenLabels = {
    claude: profiles.filter((p) => p.harness === "claude").map((p) => p.label),
    codex: profiles.filter((p) => p.harness === "codex").map((p) => p.label),
  } as const;

  const openAdd = () => {
    // 설치된 CLI가 없으면 추가할 곳이 없다: 설치 안내가 있는 AI 연결 화면으로.
    if (installed.length === 0) {
      openAiConnectReentry("settings");
      return;
    }
    setAddError(null);
    setAdding({ draft: null });
  };

  const submitAdd = (draft: AddSubscriptionDraft) => {
    setAddBusy(true);
    setAddError(null);
    void harnessProfileCreate({ harness: draft.harness, label: draft.label }).then(
      () => {
        setAddBusy(false);
        setAdding(null);
        loginConnected.current = false;
        setLogin({ harness: draft.harness, profile: draft.label, fresh: draft });
      },
      (error: unknown) => {
        setAddBusy(false);
        setAddError(addSubscriptionCreateFailed(String(error)));
      }
    );
  };

  const closeLogin = () => {
    const target = login;
    setLogin(null);
    if (!target) return;
    if (target.fresh && !loginConnected.current) {
      // 방금 만든 폴더인데 연결되지 않았다: 셸이 로그인 안 됨을 확인하고 지운다.
      // 그리고 추가 창으로 돌아온다(값을 들고).
      const draft = target.fresh;
      void harnessProfileRemove({ harness: draft.harness, label: draft.label })
        .catch(() => "unknown" as const)
        .finally(refreshProfiles);
      setAdding({ draft });
      return;
    }
    refreshProfiles();
  };

  const moreId = (row: Pick<MyAccountRow, "harness" | "profile">) =>
    row.profile === null ? `my-account-${row.harness}-more` : `my-account-${row.harness}/${row.profile}-more`;

  return (
    <>
      {rows.length === 0 ? (
        <AiLineRow
          testId="subscription-entry"
          surface="rows"
          action={<AddButton ref={addRef} onClick={openAdd} />}
        >
          <span>{MY_ACCOUNTS_EMPTY_LINE}</span>
          <span className="text-meta text-ink-muted" data-testid="subscription-entry-detail">
            {MY_ACCOUNTS_EMPTY_DETAIL}
          </span>
        </AiLineRow>
      ) : (
        <>
          <ul className="flex min-w-0 flex-col" aria-label="이 맥의 구독 계정">
            {rows.map((row) => {
              const probe =
                row.profile === null
                  ? (harness.probes?.find((p) => p.id === row.harness) ?? null)
                  : statusOf({ harness: row.harness, label: row.profile });
              const pill: HarnessPill =
                row.profile === null
                  ? harness.pill(row.harness)
                  : probe === null
                    ? "checking"
                    : harnessPill(probe);
              return (
                <MyAccountRowView
                  key={row.key}
                  row={row}
                  pill={pill}
                  moreTestId={moreId(row)}
                  onLogin={() => {
                    loginConnected.current = false;
                    setLogin({ harness: row.harness, profile: row.profile, fresh: null });
                  }}
                  onDestructive={(opener) => {
                    unlinkOpener.current = opener;
                    setUnlink({ harness: row.harness, profile: row.profile });
                  }}
                />
              );
            })}
          </ul>
          <AiLineRow
            testId="subscription-entry"
            surface="rows"
            action={<AddButton ref={addRef} onClick={openAdd} />}
            last
          >
            <span className="text-meta text-ink-muted" data-testid="subscription-entry-detail">
              같은 CLI의 다른 계정도 이 맥에서 붙일 수 있어요.
            </span>
          </AiLineRow>
        </>
      )}
      {hiddenInstalled.length > 0 && (
        <button
          type="button"
          className="harness-login-disclosure press focus-visible:focus-ring self-start pt-2"
          onClick={() => {
            writeHiddenDefaults([]);
            setHidden([]);
          }}
          data-testid="my-account-restore-hidden"
        >
          {restoreHiddenLine(hiddenInstalled.length)}
        </button>
      )}
      <AiFoot>{OWN_ACCOUNT_FOOT}</AiFoot>

      <AddSubscriptionDialog
        open={adding !== null}
        opener={addRef}
        installed={installed}
        takenLabels={takenLabels}
        initial={adding?.draft ?? null}
        busy={addBusy}
        error={addError}
        onCancel={() => setAdding(null)}
        onSubmit={submitAdd}
      />

      <HarnessLoginDialog
        harness={login?.harness ?? null}
        profile={login?.profile ?? null}
        onClose={closeLogin}
        onConnected={(id) => {
          loginConnected.current = true;
          if (login?.profile === null) harness.recheck(id);
          refreshProfiles();
        }}
        onFallbackStarted={(id) => harness.recheck(id)}
        focusAfterConnected={() =>
          login ? document.querySelector<HTMLElement>(`[data-testid="${moreId(login)}"]`) : null
        }
      />

      <HarnessUnlinkDialog
        row={unlink}
        opener={unlinkOpener}
        onClose={() => setUnlink(null)}
        onRemoveFromList={(row) => {
          const next = [...hidden.filter((id) => id !== row.harness), row.harness];
          writeHiddenDefaults(next);
          setHidden(next);
        }}
        onUnlinked={refreshProfiles}
        fixture={unlinkFixture ? { status: unlinkFixture } : null}
      />
    </>
  );
}

const AddButton = forwardRef<HTMLButtonElement, { onClick: () => void }>(function AddButton(
  { onClick },
  ref
) {
  return (
    <Button
      ref={ref}
      type="button"
      size="sm"
      className="tap-target"
      onClick={onClick}
      data-testid="subscription-entry-open"
    >
      구독 추가
    </Button>
  );
});

function MyAccountRowView({
  row,
  pill,
  moreTestId,
  onLogin,
  onDestructive,
}: {
  row: MyAccountRow;
  pill: HarnessPill;
  moreTestId: string;
  onLogin: () => void;
  onDestructive: (opener: HTMLElement | null) => void;
}) {
  // 판정은 코어 한 곳(#2941): 채팅 연결 카드의 같은 줄과 같은 알약이다.
  const view = harnessPillView(pill);
  const title = myAccountRowTitle(row);
  const moreRef = useRef<HTMLButtonElement>(null);
  const testId = row.profile === null ? `my-account-${row.harness}` : `my-account-${row.harness}/${row.profile}`;
  const needsLogin = pill === "login" || pill === "recheck";
  return (
    <li
      className="flex min-w-0 items-center gap-3 border-b border-line px-2 py-3"
      data-testid={testId}
      data-pill={pill}
      data-kind={row.kind}
    >
      <AiLogo mark={AI_CONNECT_ROW_COPY[row.harness].mark} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-semibold text-ink">{title}</span>
        <span className="truncate text-meta text-ink-muted">
          <AiSource>구독</AiSource>
          {myAccountRowDetail(row)}
        </span>
      </div>
      <span className="shrink-0" data-testid={`${testId}-state`}>
        <AiPill tone={view.tone}>{view.text}</AiPill>
      </span>
      {/* 로그인이 필요한 줄은 알약만으로 끝나지 않는다: 같은 줄(같은 프로필)로 로그인
          모달을 바로 연다(시안 §3 「재연동 연결 지점」). */}
      {needsLogin && (
        <Button
          type="button"
          size="sm"
          variant={row.profile === null ? "outline" : "default"}
          className="tap-target shrink-0"
          aria-label={`${title} ${row.profile === null ? "로그인" : RELOGIN_LABEL}`}
          onClick={onLogin}
          data-testid={`${testId}-login`}
        >
          {row.profile === null ? "로그인" : RELOGIN_LABEL}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            ref={moreRef}
            type="button"
            aria-label={`${title} 더 보기`}
            className="ai-more tap-target press grid shrink-0 place-items-center rounded-md text-icon hover:bg-surface-hover focus-visible:focus-ring"
            data-testid={moreTestId}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-testid={`${testId}-menu`}>
          {row.profile !== null && (
            <DropdownMenuItem onSelect={onLogin} data-testid={`${testId}-menu-relogin`}>
              {RELOGIN_LABEL}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            tone="danger"
            onSelect={() => onDestructive(moreRef.current)}
            data-testid={`${testId}-menu-destructive`}
          >
            {destructiveActionLabel(row)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
