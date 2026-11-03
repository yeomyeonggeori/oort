import type {MessageAttachment} from '@momo/core/features/attachments/model';
import {useCallback, useEffect, useRef, useState} from 'react';
import {AccessibilityInfo} from 'react-native';

import {useFormatMessage} from '../../i18n/useFormatMessage';
import {downloadAttachmentFile} from './content';
import {runSave, saveRouteFor, type SaveOutcome, type SavePorts, type SaveRoute} from './saveAttachment';
import {nativeSavePorts} from './saveNative';

// =============================================================================
// 첨부 「저장」의 상태 기계 (#5209, ADR-0168 증보 3). 순수 절반은 `saveAttachment.ts`, 이 훅은 그것을 화면에 잇는다.
//
// 사진·영상 뷰어의 [저장], 파일 카드의 저장 단추, (영상 뷰어가 서면) 그쪽 [저장]이 **같은 훅**을 쓴다 — 길(사진 보관함·파일 앱)은 첨부의 MIME 이
// 정하고 호출자가 고르지 않는다. `useShareAttachment`(공유 시트)와 나란한 형제이고 서로를 부르지 않는다.
//
//   idle ──저장──▶ working ──▶ saved(route)   영수증 — `SAVE_RECEIPT_MS` 뒤 idle. 보조기술에도 알린다.
//                          ├─▶ denied         사진 접근이 꺼져 있다 → 「설정 열기」. 사라지지 않는다(다음 저장이 지운다)
//                          ├─▶ failed         → 「다시 시도」. 사라지지 않는다
//                          └─▶ idle           폴더 선택 창을 고르지 않고 닫았다 — 실패가 아니다
//
// 실패·거부는 시간으로 사라지지 않는다(`docs/design-system/README.md` §4 오류 — 맥락 안에서 다음 행동까지 서 있는다). 영수증만 사라진다(복사 영수증과
// 같은 종류).
// =============================================================================

/** 저장했다는 영수증이 서 있는 시간(ms). 복사 영수증(`COPY_RECEIPT_MS` 1.5초)보다 길다 — 읽을 문장이 길고 사람의 눈이 사진에 가 있다. */
export const SAVE_RECEIPT_MS = 2_500;

export type SaveState =
  | {status: 'idle'}
  | {status: 'working'}
  | {status: 'saved'; route: SaveRoute}
  | {status: 'denied'}
  | {status: 'failed'};

export interface SaveAttachment {
  state: SaveState;
  /** 이 첨부가 저장되는 곳. 단추의 이름·힌트가 여기서 갈린다. */
  route: SaveRoute;
  /** 저장한다. 이미 하고 있으면 아무것도 하지 않는다. */
  save: () => void;
  /** 기기 설정 앱의 oort 화면 — `denied` 의 「설정 열기」. */
  openSettings: () => void;
}

/** 상태가 말하는 문구의 사전 키. 말할 것이 없으면 `null`(idle). */
export function saveNoticeKey(
  state: SaveState,
):
  | 'mobile.attachmentSave.saving'
  | 'mobile.attachmentSave.savedToPhotos'
  | 'mobile.attachmentSave.savedToFiles'
  | 'mobile.attachmentSave.failed'
  | 'mobile.attachmentSave.photosDenied'
  | null {
  switch (state.status) {
    case 'working':
      return 'mobile.attachmentSave.saving';
    case 'saved':
      return state.route === 'photos'
        ? 'mobile.attachmentSave.savedToPhotos'
        : 'mobile.attachmentSave.savedToFiles';
    case 'failed':
      return 'mobile.attachmentSave.failed';
    case 'denied':
      return 'mobile.attachmentSave.photosDenied';
    default:
      return null;
  }
}

function stateOf(outcome: SaveOutcome): SaveState {
  switch (outcome.kind) {
    case 'saved':
      return {status: 'saved', route: outcome.route};
    case 'denied':
      return {status: 'denied'};
    case 'failed':
      return {status: 'failed'};
    default:
      return {status: 'idle'};
  }
}

export function useSaveAttachment(
  workspaceId: string,
  channelId: string,
  attachment: MessageAttachment,
  ports: SavePorts = nativeSavePorts,
): SaveAttachment {
  const formatMessage = useFormatMessage();
  const [state, setState] = useState<SaveState>({status: 'idle'});
  const route = saveRouteFor(attachment);
  const working = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 영수증은 시간으로 걷힌다. 실패·거부는 걷히지 않는다.
  useEffect(() => {
    if (state.status !== 'saved') return;
    const timer = setTimeout(() => setState({status: 'idle'}), SAVE_RECEIPT_MS);
    return () => clearTimeout(timer);
  }, [state]);

  // 다른 첨부로 넘어가면(뷰어는 한 훅으로 여러 장을 본다) 앞 장의 결과 말은 걷는다. 하는 중인 저장은 끝나는 대로 말한다.
  useEffect(() => {
    setState(previous => (previous.status === 'working' ? previous : {status: 'idle'}));
  }, [attachment.id]);

  const save = useCallback(() => {
    if (working.current) return;
    working.current = true;
    setState({status: 'working'});
    void runSave(route, {
      ports,
      download: async () => {
        const file = await downloadAttachmentFile(workspaceId, channelId, attachment);
        return {uri: file.uri, name: attachment.name, mime: attachment.mime};
      },
    }).then(outcome => {
      working.current = false;
      if (!mounted.current) return;
      const next = stateOf(outcome);
      setState(next);
      const key = saveNoticeKey(next);
      if (key !== null) AccessibilityInfo.announceForAccessibility(formatMessage(key));
    });
  }, [attachment, channelId, formatMessage, ports, route, workspaceId]);

  const openSettings = useCallback(() => ports.openSettings(), [ports]);

  return {state, route, save, openSettings};
}
