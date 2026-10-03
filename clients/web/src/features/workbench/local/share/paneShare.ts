import { ApiError } from "@momo/core/lib/api";
import type { LocalWorkHostStatus } from "@momo/core/features/settings/thisMacHost";
import { cleanLabel, type ShareSender, type ShareSummaryS1 } from "@momo/core/features/workbench/shareSummary";
import { createShareCollectors, harnessOf, type ShareCollectors, type ShareGitReader, type ShareSessionsPort } from "../shareCollectors";
import type { LocalSessionView } from "../localSessions";
import { lastChannelFor, rememberChannelFor, type RepoChannelStorage } from "./repoChannelStore";

// Reading this as: 「채널에 공유」 for internal team users on Tauri desktop,
// density 7/10, motion 0/10.
//
// 칸 하나를 팀에 보이게 하는 한 번의 동작(#2867, ADR-0190 D4·D4-b Q4·Q5, ADR-0194 D4).
// 이 모듈이 하는 일:
//   1. 공유 켜기: 이 맥이 작업 호스트로 등록·실행 중인지 보고, 집 채널을 정해서
//      `POST work-sessions {origin: local_pty}`를 부른다. 서버가 같은 트랜잭션에서 root 카드를
//      채널에 올린다(클라이언트는 직접 게시하지 않는다). 그 다음 S1 수집기를 켠다.
//   2. 갱신: 수집기가 만든 요약을 host 서명 PATCH(…/share)로 보낸다. 서명은 셸의
//      `work_host_share` → workd가 한다. 이 페이지는 세션 id와 본문만 건넨다.
//   3. 공유 끄기: 서버에 `{shared:false}`가 **먼저** 닿아야 꺼진 것으로 친다(서버가 S1을 지운다).
//
// 불변:
// - 기본은 끔이다. 이 모듈은 사람이 `share()`를 부르기 전에 서버를 부르지도, 수집기를 켜지도 않는다.
// - 수집기는 켜진 칸의 요약만 만들고, 이 모듈의 `senderFor`는 켜진 칸의 세션 id가 있을 때만 보낸다.
// - 집 채널은 정해지면 바꾸지 않는다(ADR-0190 D4-b). 껐다 다시 켜면 같은 세션·같은 채널이다.
// - 저장소 → 마지막 채널 기억은 이 기기에만(repoChannelStore).
// - 칸이 닫히면 세션을 끝낸다(원장에 「실행 중」이 남지 않게). 실패해도 칸 닫기를 막지 않는다.

export type ShareRefusal =
  /** 이 맥이 작업 호스트로 등록되지 않았다: 「이 맥」 등록으로 안내한다. */
  | "host_not_registered"
  /** 등록은 됐는데 호스트가 꺼져 있다: 서명할 수 없다. */
  | "host_not_running"
  /** 다른 워크스페이스·서버에 등록돼 있다. */
  | "host_elsewhere"
  /** 데스크탑 셸이 아니다(브라우저). */
  | "no_shell"
  | "channel_forbidden"
  | "limit"
  | "offline"
  | "no_pane"
  | "failed";

export type ShareResult = { ok: true } | { ok: false; reason: ShareRefusal };

export type HostReadiness = "ready" | "not_registered" | "not_running" | "elsewhere" | "no_shell";

export interface PaneShareView {
  /** `starting`·`stopping`은 서버 답을 기다리는 중이다. */
  kind: "off" | "starting" | "on" | "stopping";
  /** 켜져 있거나, 껐지만 집 채널이 이미 정해진 세션의 채널. 없으면 null. */
  channelId: string | null;
  sessionId: string | null;
  /** 켠 뒤 마지막 요약을 서버에 못 보냈다. */
  syncFailed: boolean;
}

const OFF: PaneShareView = Object.freeze({ kind: "off", channelId: null, sessionId: null, syncFailed: false });

/** 세션 이름 상한(ADR-0190 D4-b: 80자). 서버 상한(120자)보다 좁다. */
export const SHARE_NAME_MAX = 80;

/**
 * 팀에 보이는 세션 이름. 이름은 **주인이 정한다**(D4-b): 창이 이 값을 채워 보여 주고 주인이 고친
 * 값만 서버로 간다. 하네스·셸이 OSC 제목에 무엇을 실었는지(작업 문장, 경로, user@host)는 주인이
 * 보기 전에는 기기를 떠나지 않으므로, 기본값에서 경로 구분자와 제어·서식 문자를 지운다.
 */
export function cleanShareName(raw: string | null | undefined, fallback: string): string {
  const stripped = (raw ?? "").replace(/[\\/]+/g, " ").replace(/\s+/g, " ");
  return cleanLabel(stripped, SHARE_NAME_MAX) ?? cleanLabel(fallback, SHARE_NAME_MAX) ?? "셸";
}

export interface SharePrepared {
  /** 이 칸의 기본 세션 이름(주인이 고칠 수 있다). */
  name: string;
  host: HostReadiness;
  /** 저장소 표시 이름(G1). 못 읽으면 null. */
  repo: string | null;
  /** 이 저장소로 마지막에 공유한 채널(저장돼 있고 지금도 고를 수 있을 때). */
  defaultChannelId: string | null;
  /** 이 칸이 이미 집 채널을 가졌다면 그 채널(바꿀 수 없다). */
  lockedChannelId: string | null;
}

export interface PaneShareDeps {
  workspaceId: string;
  sessions: ShareSessionsPort;
  readGit: ShareGitReader;
  hostStatus: () => Promise<LocalWorkHostStatus | null>;
  serverOrigin: () => string;
  createSession: (input: {
    channelId: string;
    hostId: string;
    tool: string;
    label: string;
    folderLabel: string | null;
  }) => Promise<{ id: string; channelId: string }>;
  endSession: (sessionId: string) => Promise<unknown>;
  /** 셸의 `work_host_share`. 거부는 닫힌 코드 문자열로 reject한다. */
  sendShare: (sessionId: string, body: Record<string, unknown>) => Promise<void>;
  /** 이 칸이 선택할 수 있는 채널 id인가(보관·DM 제외 목록). */
  channelSelectable?: (channelId: string) => boolean;
  labelOf?: (view: LocalSessionView) => string;
  storage?: RepoChannelStorage | null;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => () => void;
}

export interface PaneShare {
  subscribe(listener: () => void): () => void;
  getState(paneId: string): PaneShareView;
  prepare(paneId: string): Promise<SharePrepared>;
  /** `name`은 주인이 확인한 세션 이름. 없으면 기본 이름(정제됨)을 쓴다. */
  share(paneId: string, channelId: string, name?: string): Promise<ShareResult>;
  unshare(paneId: string): Promise<ShareResult>;
  /** 공유된 칸의 팀 보드 주소. 공유 중이 아니면 null(링크는 공유된 세션에만 있다). */
  linkFor(paneId: string): string | null;
  /** 요약 한 번을 이 칸의 세션으로 보낸다(시험·수집기 배선이 쓴다). */
  summaryOf(paneId: string): ShareSummaryS1 | null;
  dispose(): void;
}

interface Entry {
  view: PaneShareView;
  /** 집 채널이 정해진 세션(껐어도 남는다). */
  home: { sessionId: string; channelId: string } | null;
  /** 같은 세션으로 가는 PATCH를 한 줄로 세운다: 끄기 뒤에 늦은 켜기가 닿지 않게. */
  chain: Promise<unknown>;
  /** `unshare`가 시작된 뒤에는 요약을 보내지 않는다. */
  sending: boolean;
}

const HOST_REFUSAL: Record<Exclude<HostReadiness, "ready">, ShareRefusal> = {
  not_registered: "host_not_registered",
  not_running: "host_not_running",
  elsewhere: "host_elsewhere",
  no_shell: "no_shell",
};

function programName(view: LocalSessionView): string {
  return view.program.kind === "harness" ? view.program.id : "셸";
}

function defaultLabel(view: LocalSessionView): string {
  return cleanShareName(view.title, programName(view));
}

function refusalOf(error: unknown): ShareRefusal {
  if (error instanceof ApiError) {
    if (error.status === 403 && error.code === "local_share_requires_registered_host") return "host_not_registered";
    if (error.status === 403) return "channel_forbidden";
    if (error.status === 409 && error.code === "local_share_limit") return "limit";
    return "failed";
  }
  return typeof error === "object" && error !== null && "status" in error ? "failed" : "offline";
}

export function hostReadiness(status: LocalWorkHostStatus | null, workspaceId: string, serverOrigin: string): HostReadiness {
  if (!status) return "no_shell";
  if (!status.sidecar || !status.registered) return "not_registered";
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  let sameServer = false;
  try {
    sameServer = new URL(status.registered.serverUrl).origin === new URL(serverOrigin).origin;
  } catch {
    sameServer = false;
  }
  if (!same(status.registered.workspaceId, workspaceId) || !sameServer) return "elsewhere";
  return status.running ? "ready" : "not_running";
}

export function createPaneShare(deps: PaneShareDeps): PaneShare {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let disposed = false;
  const labelOf = deps.labelOf ?? defaultLabel;

  const entryOf = (paneId: string): Entry => {
    let e = entries.get(paneId);
    if (!e) {
      e = { view: OFF, home: null, chain: Promise.resolve(), sending: false };
      entries.set(paneId, e);
    }
    return e;
  };
  const emit = () => listeners.forEach((l) => l());
  const set = (e: Entry, view: PaneShareView) => {
    e.view = view;
    emit();
  };
  const queue = <T>(e: Entry, run: () => Promise<T>): Promise<T> => {
    const next = e.chain.then(run, run);
    e.chain = next.catch(() => undefined);
    return next;
  };

  // 수집기: 켜진 칸의 세션 id가 있을 때만, 그 세션으로만 보낸다.
  const senderFor = (paneId: string): ShareSender => ({
    send: async (summary) => {
      const e = entries.get(paneId);
      if (!e || e.view.kind !== "on" || !e.sending || !e.view.sessionId) return;
      const sessionId = e.view.sessionId;
      await queue(e, async () => {
        // 줄을 기다리는 사이 껐다면 보내지 않는다.
        if (e.view.kind !== "on" || !e.sending) return;
        try {
          await deps.sendShare(sessionId, { shared: true, ...summary });
          if (e.view.syncFailed) set(e, { ...e.view, syncFailed: false });
        } catch (error) {
          if (e.view.kind === "on" && !e.view.syncFailed) set(e, { ...e.view, syncFailed: true });
          throw error;
        }
      });
    },
  });
  const collectors: ShareCollectors = createShareCollectors({
    sessions: deps.sessions,
    readGit: deps.readGit,
    senderFor,
    now: deps.now,
    setInterval: deps.setInterval,
  });

  // 칸이 사라지면 그 칸의 세션을 끝낸다(원장에 실행 중이 남지 않게). 실패는 삼킨다.
  const unsubscribeSessions = deps.sessions.subscribe(() => {
    if (disposed) return;
    const present = deps.sessions.getSnapshot();
    for (const [paneId, e] of [...entries]) {
      if (present.has(paneId)) continue;
      entries.delete(paneId);
      e.sending = false;
      emit();
      if (e.home) void Promise.resolve(deps.endSession(e.home.sessionId)).catch(() => undefined);
    }
  });

  async function readRepo(paneId: string): Promise<string | null> {
    const ptyId = deps.sessions.ptyIdOf(paneId);
    if (ptyId === null) return null;
    const g1 = await deps.readGit("g1", ptyId);
    return g1.outcome === "ok" && g1.value.kind === "repo" ? g1.value.name : null;
  }

  async function hostReady(): Promise<{ readiness: HostReadiness; hostId: string | null }> {
    let status: LocalWorkHostStatus | null = null;
    try {
      status = await deps.hostStatus();
    } catch {
      status = null;
    }
    const readiness = hostReadiness(status, deps.workspaceId, deps.serverOrigin());
    return { readiness, hostId: readiness === "ready" ? (status?.registered?.hostId ?? null) : null };
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState(paneId) {
      return entries.get(paneId)?.view ?? OFF;
    },
    async prepare(paneId) {
      const [{ readiness }, repo] = await Promise.all([hostReady(), readRepo(paneId).catch(() => null)]);
      const locked = entries.get(paneId)?.home?.channelId ?? null;
      const view = deps.sessions.getSnapshot().get(paneId);
      const last = lastChannelFor(deps.workspaceId, repo, deps.storage);
      const selectable = last !== null && (deps.channelSelectable?.(last) ?? true);
      return {
        name: view ? cleanShareName(labelOf(view), programName(view)) : "셸",
        host: readiness,
        repo,
        defaultChannelId: selectable ? last : null,
        lockedChannelId: locked,
      };
    },
    async share(paneId, channelId, name) {
      const view = deps.sessions.getSnapshot().get(paneId);
      if (!view) return { ok: false, reason: "no_pane" };
      const e = entryOf(paneId);
      if (e.view.kind === "starting" || e.view.kind === "stopping" || e.view.kind === "on") return { ok: true };
      // 호스트 확인을 기다리는 동안 두 번째 호출이 같은 칸으로 세션을 또 만들지 못하게 먼저 잡는다.
      set(e, { kind: "starting", channelId: e.home?.channelId ?? channelId, sessionId: e.home?.sessionId ?? null, syncFailed: false });
      const back = (): PaneShareView => ({ kind: "off", channelId: e.home?.channelId ?? null, sessionId: e.home?.sessionId ?? null, syncFailed: false });
      const { readiness, hostId } = await hostReady();
      if (readiness !== "ready" || !hostId) {
        set(e, back());
        return { ok: false, reason: readiness === "ready" ? "failed" : HOST_REFUSAL[readiness] };
      }
      // 호스트를 확인하는 사이 칸이 닫혔다(이미 세션이 있던 칸이면 닫힘 처리기가 끝냈다): 켜지 않는다.
      if (!deps.sessions.getSnapshot().has(paneId)) {
        entries.delete(paneId);
        emit();
        return { ok: false, reason: "no_pane" };
      }
      try {
        let home = e.home;
        if (!home) {
          const repo = await readRepo(paneId).catch(() => null);
          const created = await deps.createSession({
            channelId,
            hostId,
            tool: harnessOf(view.program),
            label: cleanShareName(name ?? labelOf(view), programName(view)),
            folderLabel: repo,
          });
          home = { sessionId: created.id, channelId: created.channelId };
          // 서버가 세션을 만드는 사이 칸이 닫혔다: 이 세션의 주인 칸이 없으니 바로 끝낸다.
          if (!deps.sessions.getSnapshot().has(paneId)) {
            entries.delete(paneId);
            emit();
            void Promise.resolve(deps.endSession(created.id)).catch(() => undefined);
            return { ok: false, reason: "no_pane" };
          }
          e.home = home;
          rememberChannelFor(deps.workspaceId, repo, home.channelId, deps.storage);
        }
        e.sending = true;
        set(e, { kind: "on", channelId: home.channelId, sessionId: home.sessionId, syncFailed: false });
        collectors.setSharing(paneId, true);
        return { ok: true };
      } catch (error) {
        set(e, back());
        return { ok: false, reason: refusalOf(error) };
      }
    },
    async unshare(paneId) {
      const e = entries.get(paneId);
      if (!e || e.view.kind !== "on" || !e.view.sessionId) return { ok: true };
      const { sessionId, channelId } = e.view;
      set(e, { kind: "stopping", channelId, sessionId, syncFailed: false });
      // 이 순간부터 새 요약은 나가지 않는다. 이미 줄에 선 것은 줄 순서가 끄기 앞이다.
      e.sending = false;
      collectors.setSharing(paneId, false);
      try {
        await queue(e, () => deps.sendShare(sessionId, { shared: false }));
      } catch {
        // 서버가 모른다: 켜진 채로 둔다. 꺼진 척하지 않는다.
        e.sending = true;
        set(e, { kind: "on", channelId, sessionId, syncFailed: true });
        collectors.setSharing(paneId, true);
        return { ok: false, reason: "failed" };
      }
      set(e, { kind: "off", channelId, sessionId, syncFailed: false });
      return { ok: true };
    },
    linkFor(paneId) {
      const e = entries.get(paneId);
      if (!e || e.view.kind !== "on" || !e.view.sessionId) return null;
      return `${deps.serverOrigin().replace(/\/+$/, "")}/work?view=team&card=${encodeURIComponent(e.view.sessionId)}`;
    },
    summaryOf(paneId) {
      return collectors.summaryOf(paneId);
    },
    dispose() {
      disposed = true;
      unsubscribeSessions();
      collectors.dispose();
      listeners.clear();
    },
  };
}
