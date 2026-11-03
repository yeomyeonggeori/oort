import type { MessageAttachment } from '@momo/core/features/attachments/model';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listenToPlayer, isPlayerFailure } from './videoPlayerEvents';
import { openVideoSource, PLAYBACK, type PlaybackPhase } from './videoContent';

// =============================================================================
// 전체 화면 영상 재생의 한 갈래 (#5208) — 플레이어 하나의 수명, 열기, 복구.
//
// 이 훅은 **활성인 쪽(지금 보는 영상)만** 만든다. 뷰어의 가로 pager 가 영상을 여러 장 들고 있어도 AVPlayer 는 하나다 — 다른 쪽은
// 포스터만 그린다(`VideoViewerPage.tsx`). 쪽을 떠나면 이 훅이 풀려 플레이어가 해제되고 재생이 멈춘다.
//
// ## 열기
// 빈 플레이어를 먼저 만들고(`useVideoPlayer(null)`), `openVideoSource`(`videoContent.ts`)가 인가를 확인하면 `replaceAsync` 로
// 소스를 넣는다. 소스를 훅의 인자로 바꾸지 않는 이유: `useVideoPlayer` 는 소스의 JSON 이 바뀌면 **플레이어를 새로 만든다** — 토큰이
// 바뀔 때마다 재생 위치를 잃는다. `replaceAsync` 는 같은 플레이어에서 바꾼다.
//
// ## 복구 — 재생 중 토큰이 만료되면
// 플레이어가 오류 상태가 되면 **한 번** 같은 길(`openVideoSource`, 필요하면 코어의 단 한 번 회전)로 새 소스를 만들어 바꾸고, 오류 직전의
// 재생 위치와 재생 의도를 되돌린다. AVPlayer 의 오류는 401 인지 알려 주지 않으므로 오류마다 한 번 시도한다. 복구한 뒤 **1초 이상 앞으로
// 나아가야** 다음 복구가 허락된다 — 같은 지점에서 되풀이되는 오류가 영원히 다시 열리지 않는다. 그 뒤에는 실패로 서고 사용자가
// 「다시 시도」를 누른다.
//
// ## 외부 재생(AirPlay)은 끈다
// AirPlay 수신기는 이 주소를 **자기가** 받으러 간다 — 우리의 `Authorization` 헤더 없이. 헤더 없는 요청은 401 이고, 주소는 기기 밖으로 나간다.
// =============================================================================

export interface VideoController {
  /** 재생 ↔ 멈춤. 끝까지 본 뒤에는 처음부터 다시 재생한다. */
  togglePlay: () => void;
  /** 초 단위 절대 위치로 옮긴다(0 ~ 길이로 가둔다). */
  seekTo: (seconds: number) => void;
  /** 지금 위치에서 초만큼 건너뛴다(접근성의 늘림·줄임). */
  seekBy: (seconds: number) => void;
  toggleMuted: () => void;
  /** 실패했을 때 처음부터 다시 연다. */
  retry: () => void;
}

export interface VideoPlayback {
  player: VideoPlayer;
  controller: VideoController;
  phase: PlaybackPhase;
  playing: boolean;
  ended: boolean;
  /** 첫 장면이 그려졌다 — 그 전까지 포스터가 덮고 있다. */
  firstFrame: boolean;
  markFirstFrame: () => void;
}

/** 위치 갱신 간격(초). 진행 막대가 부드럽게 가되 JS 를 자주 깨우지 않는다. */
const TIME_UPDATE_SECONDS = 0.25;
/** 복구한 뒤 이만큼(초) 앞으로 나아가야 다음 복구가 허락된다. */
const RECOVERY_PROGRESS_SECONDS = 1;

export function useVideoPlayback({
  workspaceId,
  channelId,
  attachment,
  autoPlay,
  durationHintSeconds,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  autoPlay: boolean;
  /** 보낸 기기가 잰 길이(초). 플레이어가 길이를 알려 주기 전의 탐색 상한이다. */
  durationHintSeconds?: number;
}): VideoPlayback {
  const player = useVideoPlayer(null, instance => {
    instance.loop = false;
    instance.timeUpdateEventInterval = TIME_UPDATE_SECONDS;
    instance.keepScreenOnWhilePlaying = true;
    // 잠금 화면·제어 센터에 서지 않고, 앱을 벗어나면 멈춘다(오디오 백그라운드 모드도 선언하지 않았다).
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
    // AirPlay 수신기는 헤더 없이 주소를 받으러 간다(파일 머리).
    instance.allowsExternalPlayback = false;
  });
  const [phase, setPhase] = useState<PlaybackPhase>(PLAYBACK.OPENING);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [firstFrame, setFirstFrame] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const wantPlaying = useRef(autoPlay);
  const endedRef = useRef(false);
  const mounted = useRef(true);
  /** 복구를 몇 번 했고 어디서 했는가. 0 이면 다음 오류에서 복구를 시도한다. */
  const recoveries = useRef(0);
  const recoveryPoint = useRef(0);
  const attachmentRef = useRef(attachment);
  attachmentRef.current = attachment;
  const durationHint = useRef(durationHintSeconds ?? 0);
  durationHint.current = durationHintSeconds ?? 0;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const finish = useCallback((next: boolean) => {
    endedRef.current = next;
    setEnded(next);
  }, []);

  // ---- 열기 ---------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    setPhase(PLAYBACK.OPENING);
    setFirstFrame(false);
    finish(false);
    recoveries.current = 0;
    void (async () => {
      const result = await openVideoSource(workspaceId, channelId, attachmentRef.current);
      if (!alive) return;
      if (result.phase !== PLAYBACK.READY) {
        setPhase(result.phase);
        return;
      }
      try {
        await player.replaceAsync(result.source);
      } catch {
        if (alive) setPhase(PLAYBACK.FAILED);
        return;
      }
      if (!alive) return;
      setPhase(PLAYBACK.READY);
      if (wantPlaying.current) player.play();
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, channelId, attachment.id, attempt, player, finish]);

  // ---- 복구 ---------------------------------------------------------------
  const recover = useCallback(async () => {
    if (recoveries.current >= 1) {
      setPhase(PLAYBACK.FAILED);
      return;
    }
    recoveries.current += 1;
    const at = player.currentTime;
    recoveryPoint.current = Number.isFinite(at) ? at : 0;
    const resume = wantPlaying.current;
    const result = await openVideoSource(workspaceId, channelId, attachmentRef.current);
    if (!mounted.current) return;
    if (result.phase !== PLAYBACK.READY) {
      setPhase(result.phase);
      return;
    }
    try {
      await player.replaceAsync(result.source);
      if (!mounted.current) return;
      if (recoveryPoint.current > 0) player.currentTime = recoveryPoint.current;
      if (resume) player.play();
    } catch {
      if (mounted.current) setPhase(PLAYBACK.FAILED);
    }
  }, [player, workspaceId, channelId]);

  // ---- 플레이어의 사건 ------------------------------------------------------
  useEffect(
    () =>
      listenToPlayer(player, {
        playingChange: ({ isPlaying }) => setPlaying(isPlaying),
        playToEnd: () => {
          wantPlaying.current = false;
          finish(true);
          setPlaying(false);
        },
        statusChange: payload => {
          if (isPlayerFailure(payload)) void recover();
        },
        timeUpdate: ({ currentTime }) => {
          if (recoveries.current > 0 && currentTime >= recoveryPoint.current + RECOVERY_PROGRESS_SECONDS) {
            recoveries.current = 0;
          }
        },
      }),
    [player, recover, finish],
  );

  // ---- 조작 ---------------------------------------------------------------
  const controller = useMemo<VideoController>(() => {
    const limit = () => {
      const duration = player.duration;
      return Number.isFinite(duration) && duration > 0 ? duration : durationHint.current;
    };
    const seekTo = (seconds: number) => {
      const upper = limit();
      const target = Math.max(0, upper > 0 ? Math.min(seconds, upper) : seconds);
      player.currentTime = target;
      if (endedRef.current) finish(false);
    };
    return {
      togglePlay: () => {
        if (endedRef.current) {
          wantPlaying.current = true;
          finish(false);
          player.replay();
          return;
        }
        if (player.playing) {
          wantPlaying.current = false;
          player.pause();
        } else {
          wantPlaying.current = true;
          player.play();
        }
      },
      seekTo,
      seekBy: seconds => seekTo(player.currentTime + seconds),
      toggleMuted: () => {
        player.muted = !player.muted;
      },
      retry: () => {
        wantPlaying.current = true;
        setAttempt(value => value + 1);
      },
    };
  }, [player, finish]);

  const markFirstFrame = useCallback(() => setFirstFrame(true), []);

  return { player, controller, phase, playing, ended, firstFrame, markFirstFrame };
}
