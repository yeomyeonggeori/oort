import { useEffect, useMemo, useState } from "react";
import {
  listWorkSessions,
  uuidEq,
  type Channel,
  type WorkSession,
} from "../api/client";
import type { RealtimeHandle } from "../realtime/realtime";
import type { ApprovalsStore } from "../state/approvals";
import ObserverTerminal from "./ObserverTerminal";
import Timeline from "./Timeline";

const dateTime = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "short",
  timeStyle: "short",
});

// The record is exhaustive over WorkSession["status"] on purpose: when the spec
// grows a state (ADR-0139 added `idle`), regenerating src/api/schema.d.ts turns
// the omission into a typecheck failure instead of a blank badge. `idle` reuses
// the canonical clients/web wording (workSessionModel.ts) — an idle session is
// finished with its last tool but still alive and resumable, which is a
// different fact from `ended`.
const STATUS_LABEL: Record<WorkSession["status"], string> = {
  running: "실행 중",
  idle: "완료 · 대기 중",
  orphaned: "호스트 이탈",
  ended: "종료",
};

interface WorkObserverViewProps {
  workspaceId: string;
  channels: Channel[];
  currentMemberId: string;
  displayNameFor: (memberId: string) => string;
  realtime: RealtimeHandle | null;
  approvals: ApprovalsStore;
  onLatestSeq: (channelId: string, seq: number) => void;
  online: boolean;
}

export default function WorkObserverView({
  workspaceId,
  channels,
  currentMemberId,
  displayNameFor,
  realtime,
  approvals,
  onLatestSeq,
  online,
}: WorkObserverViewProps) {
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listWorkSessions(workspaceId)
      .then((response) => {
        if (cancelled) return;
        setSessions(response.workSessions);
        setSelectedId((current) =>
          current && response.workSessions.some((item) => uuidEq(item.id, current))
            ? current
            : (response.workSessions[0]?.id ?? null)
        );
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Work 세션을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, workspaceId]);

  const selected =
    sessions.find((session) => uuidEq(session.id, selectedId ?? "")) ?? null;
  const selectedChannel = useMemo(
    () =>
      selected === null
        ? null
        : (channels.find((channel) => uuidEq(channel.id, selected.channelId)) ??
          null),
    [channels, selected]
  );

  return (
    <div className="work-observer-layout" data-testid="work-observer">
      <aside className="work-session-rail">
        <header className="work-session-header">
          <div>
            <h1>Work 관전</h1>
            <p>세션 원장 · 읽기 전용</p>
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setAttempt((value) => value + 1)}
            disabled={loading}
          >
            새로고침
          </button>
        </header>
        {error && (
          <div className="inline-state" role="alert">
            <p className="load-error">{error}</p>
          </div>
        )}
        {loading && sessions.length === 0 && <p className="muted">불러오는 중…</p>}
        {!loading && sessions.length === 0 && error === null && (
          <p className="muted">관전할 Work 세션이 없습니다.</p>
        )}
        <ol className="work-session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className={
                  uuidEq(session.id, selectedId ?? "")
                    ? "work-session-card work-session-card-selected"
                    : "work-session-card"
                }
                onClick={() => setSelectedId(session.id)}
              >
                <span className="work-session-card-topline">
                  <strong>{session.label}</strong>
                  <span className={`work-status work-status-${session.status}`}>
                    {STATUS_LABEL[session.status]}
                  </span>
                </span>
                <span className="work-session-meta">
                  {session.tool} · {displayNameFor(session.memberId)}
                </span>
                <span className="work-session-meta">
                  {dateTime.format(new Date(session.startedAtMs))} · observer {session.observerGrantCount}
                </span>
                <span className="work-session-capability">
                  {session.remoteAttachAvailable ? "원격 터미널" : "스레드만"}
                  {session.observation === "owner_only" ? " · 소유자 전용" : " · 공개 관전"}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </aside>

      <section className="work-session-detail">
        {selected === null ? (
          <div className="screen-center"><p className="muted">세션을 선택하세요.</p></div>
        ) : selectedChannel === null ? (
          <div className="screen-center" role="alert">
            <p className="load-error">세션 채널 투영을 찾지 못했습니다.</p>
          </div>
        ) : (
          <>
            <div className="work-thread-pane">
              <Timeline
                key={`${selected.channelId.toLowerCase()}-${selected.rootMessageId.toLowerCase()}`}
                workspaceId={workspaceId}
                channel={selectedChannel}
                channelLabel={selected.label}
                currentMemberId={currentMemberId}
                displayNameFor={displayNameFor}
                realtime={realtime}
                approvals={approvals}
                onLatestSeq={onLatestSeq}
                online={online}
                focusRootMessageId={selected.rootMessageId}
                readOnly
              />
            </div>
            <ObserverTerminal
              key={selected.id.toLowerCase()}
              workspaceId={workspaceId}
              session={selected}
            />
          </>
        )}
      </section>
    </div>
  );
}
