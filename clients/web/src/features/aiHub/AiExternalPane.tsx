import { useEffect, useRef, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  AI_EXTERNAL_BASE_PATH,
  AI_EXTERNAL_COPY as COPY,
  AI_EXTERNAL_ROWS,
  AI_HUB_OVERVIEW_COPY,
  aiExternalRow,
  aiHubSection,
  glossaryEntry,
  type AiExternalRow,
  type AiExternalRowId,
} from "@momo/core/features/ai/aiHubModel";
import { CHIP_CLASS } from "@/features/common/chip";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import { PluginSection } from "@/features/plugins/PluginSection";
import { AgentCredentialsSection } from "@/features/settings/AgentCredentialsSection";
import { EventSubscriptionSection } from "@/features/settings/EventSubscriptionSection";
import { SectionHeadingContext } from "@/features/settings/SettingsFields";
import { WebhookSection } from "@/features/settings/WebhookSection";
import { GithubPane } from "@/features/github/GithubPane";
import { PersonalAssistantsList } from "@/features/hostedAgents/PersonalAssistantsList";
import { HUB_CHIP_TONE } from "./AiHubOverview";
import type { AppsRead, ChipTone, ExternalInput, Read } from "./aiHubOverviewModel";
import { useAppsRead, useExternalReads } from "./useAiHubOverview";

// =============================================================================
// 「외부 연결」 구획 (AIH-8, #3438, 플랜 §2·§7, 시안 panel-external).
//
// 첫 화면은 다섯 줄의 목차다(이름 · 한 문장 · 개수 · 열기). 줄을 열면 /ai/external/<줄> 에서 지금
// 있는 구획 본문(PluginSection · WebhookSection · EventSubscriptionSection · AgentCredentialsSection)이
// 그대로 선다. 본문 로직을 복제하지 않고, 본문이 그리던 제목·설명만 `SectionHeadingContext` 로 접어
// 이 머리가 대신 말한다. 편집 권한은 본문이 서버 답(403)으로 정한다: 소유자·관리자는 편집, 그 밖은
// 읽기(OperatorNotice). 이 화면은 역할 이름으로 컨트롤을 열고 닫지 않는다.
// 호스티드 봇 초대는 본문이 따로 없고 「에이전트 만들기」의 같은 선택 창으로 간다.
// =============================================================================

interface PaneProps {
  offline: boolean;
  workspaceId: string;
  memberId: string;
}

function PaneHead() {
  const entry = glossaryEntry(aiHubSection("external").glossaryId);
  return (
    <div className="mb-6 flex min-w-0 flex-col gap-1" data-testid="ai-hub-pane-external">
      <h2 className="text-display font-bold text-ink">{entry.term}</h2>
      <p className="max-w-2xl break-keep text-body text-ink-muted">{entry.meaning}</p>
      <p className="max-w-2xl break-keep text-body text-ink-muted" data-testid="ai-external-permission">
        {COPY.permission}
      </p>
    </div>
  );
}

function countChip(row: AiExternalRow, read: AppsRead | null): { text: string; tone: ChipTone } | null {
  if (read === null || read.state === "absent" || row.countNoun === null) return null;
  if (read.state === "ok") return { text: `${row.countNoun} ${read.value}`, tone: "neutral" };
  if (read.state === "denied") return { text: AI_HUB_OVERVIEW_COPY.chip.operatorOnly, tone: "neutral" };
  if (read.state === "error") return { text: AI_HUB_OVERVIEW_COPY.chip.readFailed, tone: "warn" };
  return null;
}

function readFor(id: AiExternalRowId, input: ExternalInput, hostedBots: Read<number>): AppsRead | null {
  // 「GitHub 알림」 줄은 세는 것이 없다(`countNoun: null`): 칩도 읽기도 없다.
  if (id === "github") return null;
  return id === "hostedBotInvite" ? hostedBots : input[id];
}

function RowItem({
  row,
  input,
  hostedBots,
  restoreFocus,
}: {
  row: AiExternalRow;
  input: ExternalInput;
  hostedBots: Read<number>;
  restoreFocus: boolean;
}) {
  const chip = countChip(row, readFor(row.id, input, hostedBots));
  const to = row.path ?? COPY.inviteHref;
  const titleId = `ai-external-row-title-${row.id}`;
  const linkId = `ai-external-open-id-${row.id}`;
  const linkRef = useRef<HTMLAnchorElement>(null);
  // 상세에서 「‹ 외부 연결」로 돌아오면 방금 연 줄의 열기에 포커스를 돌려준다.
  useEffect(() => {
    if (restoreFocus) linkRef.current?.focus({ preventScroll: false });
  }, [restoreFocus]);
  return (
    <li
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line py-4 first:border-t"
      data-testid={`ai-external-row-${row.id}`}
    >
      <div className="flex min-w-0 basis-full flex-col gap-1 sm:flex-1 sm:basis-pane-sm">
        <h3 id={titleId} className="break-keep text-body font-semibold text-ink">
          {row.title}
          {row.legacy && <span className="ml-2 text-meta font-normal text-ink-muted">({row.legacy})</span>}
        </h3>
        <p className="break-keep text-meta text-ink-muted">{row.summary}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {chip && (
          <span className={cn(CHIP_CLASS, HUB_CHIP_TONE[chip.tone])} data-numeric data-testid={`ai-external-chip-${row.id}`}>
            {chip.text}
          </span>
        )}
        <Button asChild variant="secondary" size="sm" className="tap-target">
          <Link ref={linkRef} id={linkId} to={to} aria-labelledby={`${linkId} ${titleId}`} data-testid={`ai-external-open-${row.id}`}>
            {COPY.open}
          </Link>
        </Button>
      </div>
    </li>
  );
}

function Index() {
  const { input, hostedBots } = useExternalReads();
  const from = (useLocation().state as { from?: string } | null)?.from;
  return (
    <div className="flex min-w-0 flex-col">
      <PaneHead />
      {isSurfaceProvided("hostedAgentPairing") && <PersonalAssistantsList className="mb-8" />}
      <ul className="flex min-w-0 flex-col" aria-label={glossaryEntry("externalConnection").term}>
        {/* 서버가 앱 목록을 싣지 않으면 「앱」 줄은 접힌다(#3860). 열면 접힌 화면만 만나는 진입점은
            세우지 않는다. 같은 서버가 「읽지 못했어요」를 말하는 것도 거짓이라 칩도 함께 빠진다. */}
        {AI_EXTERNAL_ROWS.filter(
          (row) =>
            (row.id !== "apps" || input.apps.state !== "absent") &&
            // 서버가 GitHub 알림을 싣지 않으면 막다른 진입점을 세우지 않는다(#3955).
            (row.id !== "github" || isSurfaceProvided("githubNotifications"))
        ).map((row) => (
          <RowItem key={row.id} row={row} input={input} hostedBots={hostedBots} restoreFocus={from === row.id} />
        ))}
      </ul>
      <div
        className="mt-6 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg bg-surface-muted px-4 py-3"
        data-testid="ai-external-code-host"
      >
        <p className="min-w-0 flex-1 basis-pane-sm break-keep text-meta text-ink">{COPY.codeHost.text}</p>
        <Link
          to={COPY.codeHost.href}
          data-testid="ai-external-code-host-link"
          className="tap-target inline-flex shrink-0 items-center text-body font-semibold text-ink underline underline-offset-4 press focus-visible:focus-ring"
        >
          {COPY.codeHost.action}
        </Link>
      </div>
    </div>
  );
}

function DetailHead({ row, quiet = false }: { row: AiExternalRow; quiet?: boolean }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // 상세로 들어오면 포커스를 제목으로 옮겨 화면이 바뀐 것을 읽어 준다(설정 셸의 headingRef와 같은 방식).
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="mb-6 flex min-w-0 flex-col gap-1" data-testid={`ai-external-detail-${row.id}`}>
      <Link
        to={AI_EXTERNAL_BASE_PATH}
        state={{ from: row.id }}
        data-testid="ai-external-back"
        className="tap-target mb-2 inline-flex items-center gap-1 self-start text-meta text-ink-muted press hover:text-ink focus-visible:focus-ring"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        {COPY.back}
      </Link>
      <h2 ref={headingRef} tabIndex={-1} className="break-keep text-display font-bold text-ink">
        {row.title}
        {row.detailLegacy && <span className="ml-2 text-body font-normal text-ink-muted">({row.detailLegacy})</span>}
      </h2>
      {/* quiet: 서버가 이 구획을 싣지 않으면 머리말의 설명 줄도 접는다. 설명은 현재형으로 약속하는데
          본문이 바로 아래에서 부정하면 화면이 스스로를 반박한다. 제목과 돌아가기는 남는다. */}
      {!quiet && row.detail.map((line) => (
        <p key={line} className="max-w-2xl break-keep text-body text-ink-muted">
          {line}
        </p>
      ))}
    </div>
  );
}

function Detail({
  id,
  quiet = false,
  children,
}: {
  id: AiExternalRowId;
  quiet?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col" data-testid={`ai-hub-external-${id}`}>
      <DetailHead row={aiExternalRow(id)} quiet={quiet} />
      <SectionHeadingContext.Provider value={false}>{children}</SectionHeadingContext.Provider>
    </div>
  );
}

/** 앱 상세. 서버가 앱 목록을 싣지 않으면(접힌 줄로 직접 들어온 경우) 머리말 설명은 서지 않는다. */
function AppsDetail({ offline }: { offline: boolean }) {
  const apps = useAppsRead();
  return (
    <Detail id="apps" quiet={apps.state === "absent"}>
      <PluginSection offline={offline} />
    </Detail>
  );
}

export function AiExternalPane({ offline, workspaceId, memberId }: PaneProps) {
  return (
    <Routes>
      <Route index element={<Index />} />
      <Route path="apps" element={<AppsDetail offline={offline} />} />
      <Route
        path="github"
        element={
          <Detail id="github" quiet={!isSurfaceProvided("githubNotifications")}>
            <GithubPane workspaceId={workspaceId} memberId={memberId} offline={offline} />
          </Detail>
        }
      />
      <Route
        path="incoming"
        element={
          <Detail id="incoming">
            <WebhookSection workspaceId={workspaceId} memberId={memberId} offline={offline} />
          </Detail>
        }
      />
      <Route
        path="outgoing"
        element={
          <Detail id="outgoing">
            <EventSubscriptionSection workspaceId={workspaceId} offline={offline} />
          </Detail>
        }
      />
      <Route
        path="agents"
        element={
          <Detail id="externalAgents">
            <AgentCredentialsSection offline={offline} />
          </Detail>
        }
      />
      <Route path="*" element={<Navigate to={AI_EXTERNAL_BASE_PATH} replace />} />
    </Routes>
  );
}
