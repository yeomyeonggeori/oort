import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { dismissTemporarySurfaces } from "@momo/core/features/notifications/entryDismiss";
import { ADE_SURFACE_ID } from "@momo/core/features/capabilities/serverSurfaces";
import { readTrayAction, TRAY_ACTION } from "@momo/core/features/notifications/trayAction";
import { adeItemLanding } from "@momo/core/features/work/adeLanding";
import { globalShortcutsHeld } from "@/app/globalShortcutHold";
import { useSession } from "@/app/session";
import { workSessionPath } from "@/features/inbox/anchor";
import { useMailboxReadActions } from "@/features/inbox/useMailbox";
import { useNeedsMe } from "@/features/inbox/useNeedsMe";
import { useAdeControl } from "@/features/ade/useAdeControl";
import { useSurfaceProvidedWhileOpen } from "@/features/capabilities/useSurfaceProvided";
import { openWorkPanel } from "@/features/agents/workLogStore";
import { useOpenNewDm } from "@/features/directory/useNewDm";
import { useChannels, useReadStates } from "@/features/workspace/useWorkspace";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { isDesktop, onTrayAction, setTrayStatus, type TrayStatusWire } from "@/lib/tauri";
import { createCloseNotice } from "./closeNotice";
import { useDockBadgeCount } from "./useDockBadgeCount";
import { buildTrayStatus, createRowIds, readAllTargets, trayCopy } from "./trayModel";

/**
 * 메뉴 막대 아이콘의 상태를 셸에 보내고, 메뉴에서 고른 것을 받아 간다 (#5193). 아무것도 렌더하지 않는다.
 * 데스크탑 밖에서는 효과도 없다.
 *
 *  - **보내는 것** 독 배지와 같은 수(`useDockBadgeCount`), 실행 중인 작업(관제 서랍이 읽는 `useAdeControl`. 세션 읽기는
 *    관제 표면이 서 있을 때만 켠다 — 같은 쿼리 키라 요약 줄이 떠 있으면 요청은 여전히 한 벌이다), 메뉴의 낱말(이미 사람의 언어로). 상태가 바뀔
 *    때만 보낸다: 보낼 내용을 문자열로 만들어 그 문자열이 달라질 때만 부른다. 열린 턴이 있는 동안 서랍 시계가 초마다
 *    이 컴포넌트를 다시 그리지만 보낼 내용은 그대로이므로 IPC는 일어나지 않는다.
 *  - **받는 것** `momo:tray-action`. 「새 메시지」는 새 다이렉트 메시지 모달(사이드바 +, ⌘⇧K와 같은 문)을 열고, 작업
 *    줄은 관제 서랍의 카드와 같은 곳으로 간다. 이벤트의 id는 마지막으로 보낸 줄들과 맞춰 본 것만 믿는다.
 *    알림 배너처럼 메뉴 막대도 **새 입구**라서 이동 직전에 겹친 임시 표면을 걷고(`dismissTemporarySurfaces`), 한 번만
 *    보이는 값을 쥔 화면이 있으면(`globalShortcutsHeld`) 전역 단축키처럼 물러선다 — 창은 이미 앞으로 와 있다.
 *    둘이 더 있다. **「모두 읽음 처리」**(#5195)는 안 읽은 멘션이 있는 채널과 안 읽은 DM의 읽음 위치를 올린다
 *    (`readAllTargets`; 승인·응답 필요 칸은 결정으로만 닫히므로 두고, 남은 수를 메뉴의 한 줄로 말한다). 이동도 겹친 표면도
 *    없는 일이라 걷지도, 물러서지도 않는다 — 창이 앞으로 오지도 않는다(셸이 그렇게 한다). **「창 치움」**(#5196)은 선택이
 *    아니라 빨간 단추가 창을 메뉴 막대로 치웠다는 알림이다: 처음 한 번만 그 사실을 OS 알림으로 말한다(`closeNotice.ts`).
 *  - **내려갈 때** 앱 셸이 내려가면(로그아웃) 수를 0, 줄을 비우고 「새 메시지」·「모두 읽음 처리」를 끄고 남은 일 줄을 지운다.
 *    아이콘은 앱이 끝날 때까지 남는다. 셸은 이 상태(`compose: false`)에서 빨간 단추를 다시 앱 종료로 되돌린다.
 */
export function TrayStatus() {
  const desktop = isDesktop();
  const unread = useDockBadgeCount();
  const { workspaceId } = useSession();
  const needs = useNeedsMe();
  const channels = useChannels(workspaceId);
  const readStates = useReadStates(workspaceId);
  // 관제 줄과 서랍은 `SurfaceGate surface="ade"` 뒤에 있다(온라인 호스트가 있을 때만). 이 컴포넌트는 셸에 늘 마운트돼 있어 그
  // 문이 없으므로 같은 판정(유예 포함)으로 세션 읽기를 직접 건다: 호스트가 없는 워크스페이스에서 원장을 20초마다 묻지 않는다.
  // 열린 턴은 실시간 스토어에서 오므로 이 판정과 무관하게 흐른다.
  const adeProvided = useSurfaceProvidedWhileOpen(ADE_SURFACE_ID);
  const { items } = useAdeControl(false, adeProvided);
  const formatMessage = useFormatMessage();
  const navigate = useNavigate();
  const openNewDm = useOpenNewDm();
  const { markChannelsRead } = useMailboxReadActions();

  // 「모두 읽음 처리」가 읽을 채널들. 메뉴 항목의 켜짐과 눌렀을 때 읽는 목록이 같은 답이다.
  const targets = useMemo(
    () =>
      readAllTargets({
        readStates: readStates.data ?? [],
        dmChannelIds: new Set(channels.groups.dms.map((dm) => dm.id.toLowerCase())),
      }),
    [readStates.data, channels.groups.dms]
  );

  // 카드마다 짧은 줄 id를 정해 주는 장부. 컴포넌트가 사는 동안 같은 카드는 같은 id를 갖는다(지연 초기화: 다시 그릴 때마다 만들지 않는다).
  const [rowIds] = useState(createRowIds);

  // 번역은 렌더마다 다시 만든다(`formatMessage` 함수는 언어가 바뀌어도 같은 것일 수 있다). 아래 효과는 그 결과를
  // 문자열로 비교하므로 언어가 바뀌면 낱말이 달라져 다시 보낸다.
  const { status, byId } = buildTrayStatus({
    unread,
    compose: true,
    readAll: targets.length > 0,
    left: { approvals: needs.approvals, panes: needs.panes },
    items,
    copy: trayCopy(formatMessage),
    rowIds,
  });
  const payload = JSON.stringify(status);

  const rowsRef = useRef(byId);
  rowsRef.current = byId;
  const labelsRef = useRef<TrayStatusWire["labels"]>(status.labels);
  labelsRef.current = status.labels;

  useEffect(() => {
    if (!desktop) return;
    void setTrayStatus(JSON.parse(payload) as TrayStatusWire);
  }, [desktop, payload]);

  useEffect(
    () => () => {
      if (!desktop) return;
      void setTrayStatus({
        unread: 0,
        compose: false,
        readAll: false,
        labels: labelsRef.current,
        running: [],
        more: null,
        remaining: null,
      });
    },
    [desktop]
  );

  // 가장 최근의 이동 함수를 ref로 읽는다: 구독은 한 번만 만든다(`navigate`는 경로마다 새 함수라서 그 변화에 다시 구독하면
  // 그 사이에 온 선택을 놓친다 — `DesktopNotifications`의 같은 이유).
  const landRef = useRef({ navigate, openNewDm, markChannelsRead });
  landRef.current = { navigate, openNewDm, markChannelsRead };
  // 눌린 순간의 목록을 읽는다(구독은 한 번만 만든다).
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const closeNoticeText = formatMessage("desktop.tray.closeNotice");
  const closeNoticeTextRef = useRef(closeNoticeText);
  closeNoticeTextRef.current = closeNoticeText;
  const [announceHidden] = useState(() => createCloseNotice());
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    void onTrayAction((payload) => {
      const action = readTrayAction(payload);
      if (action === null) return;
      // 이 둘은 화면을 옮기지도 겹친 표면을 걷지도 않아서 「한 번만 보이는 값」을 쥔 화면 앞에서 물러설 까닭이 없다.
      if (action.action === TRAY_ACTION.windowHidden) {
        void announceHidden(closeNoticeTextRef.current);
        return;
      }
      if (action.action === TRAY_ACTION.readAll) {
        void landRef.current.markChannelsRead(targetsRef.current);
        return;
      }
      if (globalShortcutsHeld()) return;
      if (action.action === TRAY_ACTION.newMessage) {
        dismissTemporarySurfaces();
        landRef.current.openNewDm(null);
        return;
      }
      const item = rowsRef.current.get(action.id);
      const landing = item === undefined ? null : adeItemLanding(item);
      if (landing === null) return;
      dismissTemporarySurfaces();
      if (landing.panel !== undefined) openWorkPanel(landing.panel, null);
      else landRef.current.navigate(workSessionPath(landing.session.channelId, landing.session.sessionId));
    }).then(
      (unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      },
      () => undefined
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [desktop, announceHidden]);

  return null;
}
