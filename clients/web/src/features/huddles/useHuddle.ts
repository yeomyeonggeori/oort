import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  fetchActiveHuddle,
  joinHuddle,
  leaveHuddle,
  leaveHuddleOnPageExit,
  startHuddle,
  uuidEq,
  type Huddle,
} from "@momo/core/lib/api";
import type {
  HuddleLifecycleFrame,
  RealtimeHandle,
} from "@/lib/realtime";
import type { HuddleAudioSession } from "./huddleRuntime";
import { loadHuddleRuntime } from "./huddleRuntimeLoader";
import {
  huddleErrorCopy,
  huddleErrorKind,
  initialHuddleProjection,
  isHuddleUnsupportedStatus,
  reduceHuddleProjection,
  type HuddleErrorKind,
} from "@momo/core/features/huddles/huddleModel";

export type HuddleBusyAction = "start-or-join" | "leave" | "microphone" | null;

export interface HuddleController {
  status: ReturnType<typeof initialHuddleProjection>["status"];
  active: Huddle | null;
  joined: boolean;
  muted: boolean;
  busy: HuddleBusyAction;
  notice: string | null;
  retry: () => void;
  startOrJoin: () => Promise<void>;
  leave: () => Promise<void>;
  toggleMicrophone: () => Promise<void>;
}

interface JoinedSession {
  huddleId: string;
  expiresAtMs: number;
}

/**
 * One channel's huddle lifecycle. PostgreSQL's active projection remains the
 * truth; realtime only invalidates it and LiveKit carries audio only.
 */
export function useHuddle(
  workspaceId: string,
  channelId: string,
  realtime: RealtimeHandle | null,
  offline: boolean
): HuddleController {
  const [projection, dispatch] = useReducer(
    reduceHuddleProjection,
    channelId,
    initialHuddleProjection
  );
  const [joinedVersion, setJoinedVersion] = useState(0);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState<HuddleBusyAction>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const activationRef = useRef(0);
  const joinAttemptHuddleRef = useRef<string | null>(null);
  const joinedRef = useRef<JoinedSession | null>(null);
  const audioRef = useRef<HuddleAudioSession | null>(null);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    const requestId = ++requestIdRef.current;
    dispatch({ type: "load-started", requestId });
    void fetchActiveHuddle(workspaceId, channelId)
      .then((huddle) => {
        if (!mountedRef.current) return;
        dispatch({ type: "load-succeeded", requestId, huddle });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        if (
          error instanceof ApiError &&
          isHuddleUnsupportedStatus(error.status)
        ) {
          dispatch({ type: "load-unconfigured", requestId });
        } else {
          dispatch({ type: "load-failed", requestId });
        }
      });
  }, [workspaceId, channelId]);

  const clearExpiry = useCallback(() => {
    if (expiryTimerRef.current !== null) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
  }, []);

  const disconnectAudio = useCallback(async () => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) await audio.disconnect();
  }, []);

  const leaveCurrent = useCallback(
    async (reportError: boolean): Promise<void> => {
      const activation = activationRef.current;
      const joined = joinedRef.current;
      joinedRef.current = null;
      setJoinedVersion((value) => value + 1);
      clearExpiry();
      setMuted(false);
      await disconnectAudio();
      if (!joined) return;
      try {
        const result = await leaveHuddle(workspaceId, joined.huddleId);
        if (
          !mountedRef.current ||
          activationRef.current !== activation
        ) {
          return;
        }
        if (result.ended) {
          dispatch({ type: "huddle-ended", huddleId: joined.huddleId });
        } else {
          dispatch({ type: "huddle-updated", huddle: result.huddle });
        }
      } catch {
        if (
          reportError &&
          mountedRef.current &&
          activationRef.current === activation
        ) {
          setNotice(
            "오디오는 종료됐지만 서버에 나가기를 확인하지 못했습니다. 활성 상태를 다시 확인하세요."
          );
          refresh();
        }
      }
    },
    [clearExpiry, disconnectAudio, refresh, workspaceId]
  );

  const leaveForReason = useCallback(
    async (kind: HuddleErrorKind) => {
      await leaveCurrent(false);
      if (mountedRef.current) setNotice(huddleErrorCopy(kind));
    },
    [leaveCurrent]
  );

  const scheduleExpiry = useCallback(
    (expiresAtMs: number) => {
      clearExpiry();
      expiryTimerRef.current = setTimeout(() => {
        void leaveForReason("expired");
      }, Math.max(0, expiresAtMs - Date.now()));
    },
    [clearExpiry, leaveForReason]
  );

  const handleRealtime = useCallback(
    (frame: HuddleLifecycleFrame) => {
      if (!uuidEq(frame.payload.channel_id, channelId)) return;
      if (frame.type === "huddle_ended") {
        // Also invalidates a start/join attempt that has not assigned joinedRef
        // yet. Its eventual join response is rolled back instead of connecting
        // audio to a room the channel already declared ended.
        const endedJoined = uuidEq(
          joinedRef.current?.huddleId,
          frame.payload.huddle_id
        );
        const endedJoinAttempt = uuidEq(
          joinAttemptHuddleRef.current ?? undefined,
          frame.payload.huddle_id
        );
        if (endedJoined || endedJoinAttempt) {
          activationRef.current += 1;
        }
        dispatch({
          type: "huddle-ended",
          huddleId: frame.payload.huddle_id,
        });
        if (endedJoined) {
          joinedRef.current = null;
          setJoinedVersion((value) => value + 1);
          clearExpiry();
          setMuted(false);
          void disconnectAudio();
          setNotice("허들이 종료되어 오디오 연결을 닫았습니다.");
        } else if (endedJoinAttempt) {
          setNotice("허들이 종료되어 참가를 취소했습니다.");
        }
        return;
      }
      refresh();
    },
    [channelId, clearExpiry, disconnectAudio, refresh]
  );

  useEffect(() => {
    mountedRef.current = true;
    activationRef.current += 1;
    const requestId = ++requestIdRef.current;
    dispatch({ type: "channel", channelId, requestId });
    void fetchActiveHuddle(workspaceId, channelId)
      .then((huddle) => {
        if (mountedRef.current) {
          dispatch({ type: "load-succeeded", requestId, huddle });
        }
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        dispatch({
          type:
            error instanceof ApiError &&
            isHuddleUnsupportedStatus(error.status)
              ? "load-unconfigured"
              : "load-failed",
          requestId,
        });
      });

    return () => {
      activationRef.current += 1;
      requestIdRef.current += 1;
      clearExpiry();
      // Route/channel teardown must release both planes. React cannot await an
      // effect cleanup, so both operations are deliberately started here.
      void leaveCurrent(false);
    };
  }, [channelId, workspaceId, clearExpiry, leaveCurrent]);

  useEffect(() => {
    if (!realtime) return;
    return realtime.subscribeHuddle(workspaceId, channelId, {
      onLifecycle: handleRealtime,
      onResync: refresh,
    });
  }, [realtime, workspaceId, channelId, handleRealtime, refresh]);

  useEffect(() => {
    const onPageExit = () => {
      activationRef.current += 1;
      const joined = joinedRef.current;
      if (!joined) return;
      joinedRef.current = null;
      clearExpiry();
      void disconnectAudio();
      leaveHuddleOnPageExit(workspaceId, joined.huddleId);
    };
    window.addEventListener("pagehide", onPageExit);
    window.addEventListener("beforeunload", onPageExit);
    return () => {
      window.removeEventListener("pagehide", onPageExit);
      window.removeEventListener("beforeunload", onPageExit);
    };
  }, [clearExpiry, disconnectAudio, workspaceId]);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const startOrJoin = useCallback(async () => {
    if (busy || offline) return;
    setBusy("start-or-join");
    setNotice(null);
    let joinedForRollback: JoinedSession | null = null;
    let connectedAudio: HuddleAudioSession | null = null;
    let attemptedHuddleId: string | null = null;
    const activation = activationRef.current;
    try {
      const huddle =
        projection.active ?? (await startHuddle(workspaceId, channelId));
      dispatch({ type: "huddle-updated", huddle });
      attemptedHuddleId = huddle.id;
      joinAttemptHuddleRef.current = huddle.id;

      // Start loading the optional SDK beside the join request. Both begin only
      // after a user action, and neither depends on the other's result.
      const runtimePromise = loadHuddleRuntime();
      const joinedPromise = joinHuddle(workspaceId, huddle.id);
      const [runtime, joined] = await Promise.all([
        runtimePromise,
        joinedPromise,
      ]);
      joinedForRollback = {
        huddleId: joined.huddle.id,
        expiresAtMs: joined.expiresAtMs,
      };
      if (
        !mountedRef.current ||
        activationRef.current !== activation
      ) {
        void leaveHuddle(workspaceId, joined.huddle.id);
        return;
      }
      connectedAudio = await runtime.connectHuddleAudio({
        livekitUrl: joined.livekitUrl,
        token: joined.token,
        onDisconnected: () => {
          void leaveForReason("connection");
        },
      });
      if (
        !mountedRef.current ||
        activationRef.current !== activation
      ) {
        await connectedAudio.disconnect();
        void leaveHuddle(workspaceId, joined.huddle.id);
        return;
      }
      audioRef.current = connectedAudio;
      joinedRef.current = joinedForRollback;
      setJoinedVersion((value) => value + 1);
      setMuted(false);
      dispatch({ type: "huddle-updated", huddle: joined.huddle });
      scheduleExpiry(joined.expiresAtMs);
    } catch (error) {
      if (connectedAudio) await connectedAudio.disconnect();
      if (joinedForRollback) {
        try {
          const result = await leaveHuddle(
            workspaceId,
            joinedForRollback.huddleId
          );
          if (result.ended) {
            dispatch({
              type: "huddle-ended",
              huddleId: joinedForRollback.huddleId,
            });
          } else {
            dispatch({ type: "huddle-updated", huddle: result.huddle });
          }
        } catch {
          refresh();
        }
      }
      const kind = huddleErrorKind(error);
      if (kind === "unconfigured") {
        const requestId = ++requestIdRef.current;
        dispatch({ type: "load-started", requestId });
        dispatch({ type: "load-unconfigured", requestId });
      }
      if (
        mountedRef.current &&
        activationRef.current === activation
      ) {
        setNotice(huddleErrorCopy(kind));
      }
    } finally {
      if (
        attemptedHuddleId &&
        uuidEq(joinAttemptHuddleRef.current ?? undefined, attemptedHuddleId)
      ) {
        joinAttemptHuddleRef.current = null;
      }
      if (mountedRef.current) setBusy(null);
    }
  }, [
    busy,
    offline,
    projection.active,
    workspaceId,
    channelId,
    leaveForReason,
    refresh,
    scheduleExpiry,
  ]);

  const leave = useCallback(async () => {
    if (busy) return;
    setBusy("leave");
    setNotice(null);
    await leaveCurrent(true);
    if (mountedRef.current) setBusy(null);
  }, [busy, leaveCurrent]);

  const toggleMicrophone = useCallback(async () => {
    if (busy || !audioRef.current) return;
    setBusy("microphone");
    setNotice(null);
    const target = !muted;
    try {
      await audioRef.current.setMicrophoneMuted(target);
      if (mountedRef.current) setMuted(target);
    } catch (error) {
      if (mountedRef.current) {
        setNotice(huddleErrorCopy(huddleErrorKind(error, "microphone")));
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [busy, muted]);

  // joinedVersion intentionally makes the ref-backed lifecycle reactive.
  void joinedVersion;
  const currentChannel =
    projection.channelId === channelId
      ? projection
      : initialHuddleProjection(channelId);
  return {
    status: currentChannel.status,
    active: currentChannel.active,
    joined: joinedRef.current !== null,
    muted,
    busy,
    notice,
    retry: refresh,
    startOrJoin,
    leave,
    toggleMicrophone,
  };
}
