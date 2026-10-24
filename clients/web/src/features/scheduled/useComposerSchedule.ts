import { useCallback, useRef, useState } from "react";
import { COMPOSER_OFFLINE_COPY } from "@momo/core/features/chat/composerCopy";
import type { AttachmentDraft } from "@momo/core/features/attachments/model";
import { SCHEDULED_COPY, type PlaceWord } from "@momo/core/features/scheduled/copy";
import { scheduledErrorLine, type ScheduledErrorLine } from "@momo/core/features/scheduled/errors";
import { scheduleBlockTitle, scheduleGate, type ScheduleGate } from "@momo/core/features/scheduled/gate";
import {
  defaultSendAtMs,
  formatScheduledAt,
  scheduledPresets,
  scheduledZoneLine,
  sendAtProblemSentence,
  validateSendAt,
  type ScheduledPreset,
} from "@momo/core/features/scheduled/presets";
import {
  nextClientRequest,
  type ClientRequestMemory,
} from "@momo/core/features/scheduled/request";
import type { DialogFocusTarget } from "@/design/ui/dialog";
import { dropClaimed, peekSent } from "@/features/attachments/draftStore";
import type { ScheduleDialogProps } from "./ScheduleDialog";
import type { ScheduleSendMenuProps } from "./ScheduleSendMenu";
import { useScheduled, useScheduledPlaces } from "./useScheduled";
import { useTransientStatus } from "@/features/common/useTransientStatus";

// =============================================================================
// 입력창의 「예약해서 보내기」 흐름 한 벌 (ADR-0208 D16, UI 명세 0.3·0.4·0.5, #4215).
//
// 채널 입력창과 스레드 입력창이 **같은 훅**을 부른다. 호스트가 다른 것은 입력창의 자리(보이는 3초 줄 vs 안 보이는
// 낭독 노드)와 무엇을 비우는가뿐이고, 판정·잠금·요청·실패 문장은 한 벌이다.
//
// 지키는 것 다섯.
//  1. **보내기와 같은 판정을 같은 함수로**(`scheduleGate`: `sendBlockReason`·`containsSecretKey`를 부른다). 막힌
//     사유는 한 번에 하나, 명세 0.4 표의 순서다.
//  2. **제출 시점의 스냅샷**(글·첨부·`rootId`)을 잡고 요청이 나는 동안 잠근다(`busy`: 같은 값으로 두 번째 예약이
//     생기지 않게 동기 ref로도 잠근다).
//  3. **서버가 201을 준 뒤에만 비운다.** 글·초안은 스냅샷과 **같을 때만** 비우고(요청 중에 고친 글은 남긴다),
//     스냅샷의 첨부는 **항상** 트레이에서 뺀다(예약이 점유한다). 실패하면 글·첨부가 그대로 남는다.
//  4. **`clientRequestId`는 요청 내용이 같을 때만 다시 쓴다**(코어 `nextClientRequest`). 연결이 끊겨 결과를 모를 때
//     같은 값으로 다시 누르면 서버가 같은 행으로 받는다.
//  5. **프리셋 요청이 실패하면 같은 시각이 채워진 직접 고르기가 열려** 오류 줄이 이유를 말한다. 채널·스레드 입력창에는
//     시간으로 사라지지 않는 오류 줄을 놓을 자리가 없고(메타 슬롯은 3초 소거), 대화상자 안에서는 같은 값으로 바로
//     다시 시도할 수 있다.
// =============================================================================

export interface ComposerScheduleOptions {
  /** 채널 입력창은 보이는 3초 줄, 스레드 입력창은 안 보이는 낭독 노드가 `statusText`를 읽는다. */
  surface: "channel" | "thread";
  workspaceId: string;
  channelId: string;
  /** 스레드 답글이면 그 스레드의 루트. 예약에 `rootId`로 실린다. */
  rootId?: string;
  /** 지금의 글(렌더에 쓰는 값). */
  text: string;
  /** **지금** 글을 읽는다(요청이 끝난 뒤 스냅샷과 비교한다). */
  readText: () => string;
  /** 이 입력창의 첨부 트레이 열쇠(`surfaceKey`). */
  trayKey: string;
  drafts: readonly AttachmentDraft[];
  offline: boolean;
  /** `/` 명령을 쓰는 중이다. */
  commandDraft: boolean;
  /** 지금 보내면 내 개인 에이전트 호출이 되는 글이다. */
  personalCall: boolean;
  quoting: boolean;
  /** 모델 지정(`routing`)이 켜져 있다. */
  routingSet: boolean;
  /**
   * 호스트가 이미 다른 요청을 날리는 중이다(스레드 입력창의 답글 전송). 그동안 ▾는 `aria-busy`로 잠긴다:
   * 같은 글이 답글과 예약으로 둘 다 나가면 안 된다.
   */
  hostBusy?: boolean;
  /** 입력창으로 초점을 돌려 준다. */
  focusInput: () => void;
  /** 예약이 걸렸다. `textUnchanged`일 때만 글·초안을 비운다. 첨부는 이 훅이 이미 뺐다. */
  onScheduled: (info: { textUnchanged: boolean }) => void;
  /** 키 모양 글을 예약하려 했다: 호출부가 기존 키 차단 줄을 세운다. */
  onSecretKey: () => void;
}

export interface ComposerSchedule {
  gate: ScheduleGate;
  /** 요청이 나는 중. 예약·보내기 단추는 `aria-busy`이고 Enter 전송도 같은 잠금 아래다. */
  busy: boolean;
  /** 3초 상태줄·낭독 노드의 문장. 없으면 `null`. */
  statusText: string | null;
  menuProps: ScheduleSendMenuProps;
  dialogProps: ScheduleDialogProps;
  /** 배너가 세는 곳. */
  place: { channelId: string; rootId?: string };
  /** 배너 문장의 장소 낱말: 스레드는 「스레드」, 아니면 채널·대화. */
  bannerWord: PlaceWord;
}

/** 글 미리보기 한 줄: 줄바꿈은 공백으로 접는다. */
function previewOf(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface DialogState {
  open: boolean;
  seedAtMs: number;
  error: ScheduledErrorLine | null;
}

const CLOSED_DIALOG: DialogState = { open: false, seedAtMs: 0, error: null };

export function useComposerSchedule(options: ComposerScheduleOptions): ComposerSchedule {
  const data = useScheduled();
  const places = useScheduledPlaces();
  const { status, announce } = useTransientStatus();
  const [busy, setBusy] = useState(false);
  const [presets, setPresets] = useState<readonly ScheduledPreset[]>([]);
  const [dialog, setDialog] = useState<DialogState>(CLOSED_DIALOG);
  const busyRef = useRef(false);
  /** 직접 고르기에서 건 예약이 성공했다: 대화상자가 닫힌 뒤 초점은 연 단추가 아니라 입력창으로 간다. */
  const focusInputOnClose = useRef(false);
  const memoryRef = useRef<ClientRequestMemory | null>(null);
  const openerRef = useRef<DialogFocusTarget | null>(null);
  // 요청이 끝났을 때 **지금의** 호출부 값을 읽는다(요청 중에 채널을 옮겼을 수 있다).
  const latest = useRef(options);
  latest.current = options;

  const place = places(options.channelId);
  const gate = scheduleGate({
    offered: data.surface !== "absent",
    offline: options.offline,
    schedulerDisabled: data.schedulerDisabled,
    text: options.text,
    attachments: options.drafts,
    commandDraft: options.commandDraft,
    personalCall: options.personalCall,
    quoting: options.quoting,
    pendingCount: data.pendingCount,
    routingSet: options.routingSet,
  });
  const gateRef = useRef(gate);
  gateRef.current = gate;
  const placeRef = useRef(place);
  placeRef.current = place;

  const openDialog = useCallback((seedAtMs: number, error: ScheduledErrorLine | null) => {
    setDialog({ open: true, seedAtMs, error });
  }, []);

  /** 요청 한 번. 성공하면 `true`. */
  const run = useCallback(
    async (atMs: number, via: "preset" | "dialog", seedForDialog: number): Promise<boolean> => {
      if (busyRef.current) return false;
      const current = latest.current;
      // 메뉴를 열어 둔 사이 시각이 지났을 수 있다: 서버에 보내기 전에 말한다.
      const problem = validateSendAt(atMs, Date.now());
      if (problem !== null) {
        openDialog(seedForDialog, { text: sendAtProblemSentence(problem) });
        return false;
      }
      // 키 모양 글은 고르는 순간 막는다(기존 키 차단 줄이 선다).
      if (gateRef.current.secretKey) {
        current.onSecretKey();
        return false;
      }
      const { channelId, rootId, workspaceId, trayKey } = current;
      const snapshotText = current.readText();
      const attachmentIds = peekSent(trayKey).attachmentIds;
      memoryRef.current = nextClientRequest(
        memoryRef.current,
        { workspaceId, channelId, ...(rootId === undefined ? {} : { rootId }), body: snapshotText, sendAtMs: atMs, attachmentIds },
        () => crypto.randomUUID()
      );
      const clientRequestId = memoryRef.current.id;
      busyRef.current = true;
      setBusy(true);
      try {
        const row = await data.mutations.create({
          channelId,
          body: snapshotText,
          sendAtMs: atMs,
          ...(rootId === undefined ? {} : { rootId }),
          attachmentIds,
          clientRequestId,
        });
        memoryRef.current = null;
        // 예약이 점유한 첨부는 항상 뺀다. 글은 스냅샷과 같을 때만 비운다(요청 중에 고친 글은 남긴다).
        dropClaimed(trayKey, attachmentIds);
        const now = latest.current;
        now.onScheduled({ textUnchanged: now.readText() === snapshotText });
        setDialog(CLOSED_DIALOG);
        // 요청 중에 다른 곳으로 옮겼으면 그 입력창에 이 확인을 말하지 않는다.
        if (now.channelId === channelId && now.rootId === rootId) {
          announce(SCHEDULED_COPY.status.scheduled(formatScheduledAt(row.sendAtMs, Date.now()).full));
          // 메뉴에서 고른 예약은 메뉴가 닫히며 입력창으로 돌려준다. 대화상자에서 건 예약은 대화상자가 닫힌 뒤(Radix의
          // 초점 반환이 열었던 단추로 되돌리기 전에 가로채서) 입력창으로 보낸다.
          if (via === "dialog") focusInputOnClose.current = true;
          else now.focusInput();
        }
        return true;
      } catch (error) {
        const line = scheduledErrorLine("create", error, placeRef.current.errorWord);
        // 프리셋이 실패하면 고른 시각이 채워진 직접 고르기가 열려 오류 줄이 이유를 말한다. 대화상자 안의
        // 실패는 그 안에서 말한다(처음 값은 그대로).
        openDialog(via === "preset" ? atMs : seedForDialog, line);
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [announce, data.mutations, openDialog]
  );

  const onOpen = useCallback((opener: HTMLElement | null) => {
    openerRef.current = opener;
    setPresets(scheduledPresets(Date.now()));
  }, []);

  const menuProps: ScheduleSendMenuProps = {
    gate,
    busy: busy || options.hostBusy === true,
    presets,
    zoneLine: scheduledZoneLine(presets[0]?.atMs ?? Date.now()),
    onOpen,
    onPickPreset: (preset) => {
      void run(preset.atMs, "preset", preset.atMs);
    },
    onPickCustom: (opener) => {
      openerRef.current = opener;
      // 키 모양 글은 직접 고르기도 막는다(고르는 순간).
      if (gateRef.current.secretKey) {
        latest.current.onSecretKey();
        return;
      }
      openDialog(defaultSendAtMs(Date.now()), null);
    },
    onBlockedPress: () => {
      const reason = gateRef.current.lines?.reason;
      if (reason !== undefined) announce(reason);
    },
    returnFocus: () => latest.current.focusInput(),
    blockedTitle:
      scheduleBlockTitle(gate.lines) ?? (gate.block === "offline" ? COMPOSER_OFFLINE_COPY : null),
    testIdPrefix: options.surface === "thread" ? "thread-composer" : "composer",
  };

  const dialogProps: ScheduleDialogProps = {
    open: dialog.open,
    onOpenChange: (open) => {
      if (open) return;
      setDialog(CLOSED_DIALOG);
    },
    mode: "create",
    opener: openerRef.current,
    placeLabel: place.markedLabel,
    preview: previewOf(options.text),
    initialAtMs: dialog.seedAtMs,
    pending: busy,
    error: dialog.error,
    offline: options.offline,
    unavailable: data.schedulerDisabled,
    routingNote: gate.routingNote,
    onCommit: (atMs) => {
      void run(atMs, "dialog", dialog.seedAtMs);
    },
    onCloseAutoFocus: (event) => {
      if (!focusInputOnClose.current) return;
      focusInputOnClose.current = false;
      event.preventDefault();
      latest.current.focusInput();
    },
  };

  return {
    gate,
    busy,
    // 프리셋 요청이 나는 동안은 **「예약 중」**이 3초 줄·낭독 노드에 선다: `aria-busy`는 낭독이 알리지 않고 눈에는 아무 신호도
    // 없어서, 느린 서버에서는 입력창이 몇 초 멈춘 것처럼 보이고 두 번째 누름이 말없이 무시됐다(design-review #4215 2회차 M4).
    // 직접 고르기에서 건 요청은 대화상자의 「예약 중」 단추가 말한다. 성공하면 같은 자리가 「…에 보낼게요」로 바뀐다.
    statusText: busy && !dialog.open ? SCHEDULED_COPY.dialog.saving : status,
    menuProps,
    dialogProps,
    place: options.rootId === undefined ? { channelId: options.channelId } : { channelId: options.channelId, rootId: options.rootId },
    bannerWord: options.rootId === undefined ? place.word : "스레드",
  };
}
