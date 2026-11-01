import {fetchHumanControlSignatureRequired} from '@momo/core/features/auth/deviceKeys';
import {WORK_REQUEST_SHEET_MODE} from '@momo/core/features/timeline/commandSuggest';
import {uuidEq, type Channel} from '@momo/core/lib/api';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {AccessibilityInfo, StyleSheet, Text, View} from 'react-native';

import {FailureBanner, LoadingState, Sentence} from '../design/atoms';
import {PageSheet, usePageSheetClose} from '../design/PageSheet';
import {SheetHeader, type SheetConfirm} from '../design/SheetChrome';
import {ChoiceRow, GroupCard, ListRow, SheetScroll} from '../design/sheetParts';
import {useStyles} from '../design/theme';
import {font, line, SHEET, space, type Palette} from '../design/tokens';
import {useWorkHosts, useWorkSessions} from '../features/agents/queries';
import {useDeviceKey} from '../features/deviceKey/useDeviceKey';
import {
  AGENT_SUGGEST_LABEL,
  AGENT_SUGGEST_SENTENCE,
  channelReach,
  defaultFolderId,
  defaultHarness,
  destinationLine,
  FACE_ID_NOTE,
  findSpawnedSession,
  FLAG_OFF_DETAIL,
  FLAG_OFF_HEADLINE,
  foldersToPick,
  harnessChoices,
  HARNESS_LABEL,
  homeChannels,
  KEY_NOT_READY_DETAIL,
  KEY_NOT_READY_HEADLINE,
  NEED_CHANNEL_HINT,
  NEED_FOLDER_HINT,
  UNKNOWN_FAILURE_SENTENCE,
  WAITING_NOTE,
  labelFromPrompt,
  MAC_NONE_DETAIL,
  MAC_OFF_DETAIL,
  MAC_OFF_HEADLINE,
  MAC_WENT_OFF_SENTENCE,
  macState,
  MODE_LABEL,
  ownMacs,
  projectFolders,
  promptIssue,
  signingBlock,
  type AskMode,
  type HarnessKey,
} from '../features/work/ask/model';
import {readAskLast, writeAskLast} from '../features/work/ask/session';
import {spawnPort, type SpawnOutcome, type SpawnPort} from '../features/work/ask/spawnPort';
import {useChannels} from '../features/workspace/queries';
import {haptics} from '../lib/haptics';
import {useSession} from '../session/useSession';
import {FieldLabel, SheetNotice, TextArea} from './sheetForm';

// =============================================================================
// 내 맥에 보내기 — 폰에서 하네스로 「물어보기」·작업 요청 (#3597 T6b, ADR-0198 D4·D7 증보 1).
//
// 시트 하나, 한 화면이다. 새 탭이 아니다(ADR-0189 D1).
//
// ## 도착지는 늘 이름으로 보인다
//
// 맨 위의 「보낼 곳」 줄(「내 맥 · <기기> · Claude Code」)은 맥이 켜져 있든 꺼져 있든 서 있다.
// 조용한 대신 보냄이 없다: 맥이 꺼져 있으면 폼 자체를 세우지 않는다. 대기 요청은 없고(v1),
// 에이전트로 가는 길은 **사람이 누르는 버튼 하나**다(N8 시트를 연다).
//
// ## 과금 이야기를 하지 않는다
//
// 어떤 구독으로 도는지는 T0b(#3566)가 재기 전까지 모른다. 이 시트의 문장에는 구독·요금이 없다.
//
// ## Face ID 전에 알 수 있는 것은 먼저 막는다
//
// 서버가 서명 요구를 꺼 두었거나(403 `signed_spawn_disabled`) 이 폰의 서명 키가 준비되지 않았으면
// 보내기를 막고 이유를 보인다. 사람에게 Face ID를 시키고 거절을 보여 주지 않는다.
//
// ## 보낸 뒤
//
// 세션은 맥이 요청을 받은 뒤에야 생긴다. 보내자마자 N3 대화 화면을 열 id가 없으므로, 시트가
// 「내 맥이 받는 중」을 보이며 세션 목록을 짧게 지켜보다가 **내 요청이 만든 세션이 하나로 정해지면**
// 그 대화로 간다. 정해지지 않으면 작업 목록으로 간다(엉뚱한 세션을 열지 않는다).
// =============================================================================

const WAIT_POLL_MS = 2_000;
export const WAIT_TIMEOUT_MS = 20_000;
const HOSTS_POLL_MS = 15_000;

/** 캡처 하네스 전용 시작 모양(`measure/surfaces.tsx`). 앱은 쓰지 않는다. */
export interface AskMacPreview {
  mode?: AskMode;
  harness?: HarnessKey;
  folderId?: string;
  channelId?: string;
  prompt?: string;
  /** 서명 준비 상태를 강제한다. 시뮬레이터에는 Secure Enclave가 없다. */
  signing?: 'ready' | 'flag_off';
  waiting?: boolean;
}

export function AskMacSheet({
  onClose,
  onUseAgent,
  onOpenSession,
  onOpenWorkList,
  port,
  preview,
  initialHarness,
  initialPrompt,
  waitTimeoutMs = WAIT_TIMEOUT_MS,
}: {
  onClose: () => void;
  /** 맥이 꺼져 있을 때 사람이 누르는 「에이전트에게 맡기기」. 시트를 닫고 N8 시트를 연다. */
  onUseAgent: () => void;
  /** 내 요청이 만든 세션이 정해졌을 때: N3 대화 화면으로. */
  onOpenSession: (sessionId: string) => void;
  /** 세션을 정하지 못했을 때: 작업 목록으로. */
  onOpenWorkList: () => void;
  port?: SpawnPort;
  preview?: AskMacPreview;
  /** 「개인 에이전트」 줄이 넘기는 처음 하네스. 이 맥이 못 고르는 키면 평소 기본값이 이긴다. */
  initialHarness?: HarnessKey;
  /**
   * 도우미의 「작업 요청 열기」 카드(`work.request.open`, #4972)가 미리 채운 글. 있으면 시트는
   * **「작업 요청」 모드**로 열리고 이 글이 입력 칸에 들어 있다 — 보내는 것은 사람이다(글을 읽고
   * 고치고 ✓를 눌러야 서명·전송이 일어난다). 폴더·채널·맥은 미리 고르지 않는다.
   */
  initialPrompt?: string;
  waitTimeoutMs?: number;
}): React.JSX.Element {
  return (
    <PageSheet
      onClose={onClose}
      accessibilityLabel="내 맥에 보내기"
      scrimLabel="내 맥에 보내기 닫기"
      testID="ask-mac-sheet"
    >
      <SheetBody
        onClose={onClose}
        onUseAgent={onUseAgent}
        onOpenSession={onOpenSession}
        onOpenWorkList={onOpenWorkList}
        port={port}
        preview={preview}
        initialHarness={initialHarness}
        initialPrompt={initialPrompt}
        waitTimeoutMs={waitTimeoutMs}
      />
    </PageSheet>
  );
}

function SheetBody({
  onClose,
  onUseAgent,
  onOpenSession,
  onOpenWorkList,
  port,
  preview,
  initialHarness,
  initialPrompt,
  waitTimeoutMs,
}: {
  onClose: () => void;
  onUseAgent: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenWorkList: () => void;
  port?: SpawnPort;
  preview?: AskMacPreview;
  initialHarness?: HarnessKey;
  initialPrompt?: string;
  waitTimeoutMs: number;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {member, workspaceId} = useSession();
  const client = useQueryClient();
  const slideClose = usePageSheetClose() ?? onClose;
  const sender = port ?? spawnPort();

  const hostsQuery = useWorkHosts(workspaceId);
  const channelsQuery = useChannels(workspaceId);
  const [waiting, setWaiting] = useState(preview?.waiting === true);
  const sessionsQuery = useWorkSessions(
    workspaceId,
    true,
    waiting ? WAIT_POLL_MS : undefined,
  );
  const flagQuery = useQuery({
    queryKey: ['ask-mac', 'signature-required', workspaceId],
    queryFn: () => fetchHumanControlSignatureRequired(workspaceId),
    staleTime: 30_000,
    enabled: preview?.signing === undefined,
  });
  const deviceKey = useDeviceKey(workspaceId, {poll: false});

  // 맥이 켜졌는지는 서버의 한 식이다. 열려 있는 동안 가끔 다시 읽는다(전송 직전 상태 확인).
  useEffect(() => {
    const id = setInterval(() => {
      void hostsQuery.refetch();
    }, HOSTS_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const macs = useMemo(
    () => ownMacs(hostsQuery.data, member.id),
    [hostsQuery.data, member.id],
  );
  const state = macState(macs);
  const last = useMemo(() => readAskLast(workspaceId), [workspaceId]);

  const [macId, setMacId] = useState<string | null>(null);
  // 카드가 글을 미리 채웠으면 일을 시키는 시트다(「작업 요청」): 글이 시킬 일이라서다.
  const [mode, setMode] = useState<AskMode>(
    preview?.mode ?? (initialPrompt !== undefined ? WORK_REQUEST_SHEET_MODE : 'ask'),
  );
  const [harnessPick, setHarnessPick] = useState<HarnessKey | null>(
    preview?.harness ?? initialHarness ?? null,
  );
  const [folderPick, setFolderPick] = useState<string | null>(
    preview?.folderId ?? null,
  );
  const [channelPick, setChannelPick] = useState<string | null>(
    preview?.channelId ?? null,
  );
  const [prompt, setPrompt] = useState(preview?.prompt ?? initialPrompt ?? '');
  const [issue, setIssue] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [flagClosedByServer, setFlagClosedByServer] = useState(false);
  const openedRef = useRef(false);
  const sentRef = useRef<{
    before: Set<string>;
    hostId: string;
    channelId: string;
    label: string;
  } | null>(null);

  const activeMac =
    state.kind === 'on'
      ? state.macs.find(mac => macId !== null && mac.id === macId) ??
        (state.macs[0] as (typeof state.macs)[number])
      : null;

  const harnesses = activeMac === null ? [] : harnessChoices(activeMac);
  const harness: HarnessKey | null =
    activeMac === null
      ? null
      : harnessPick !== null && harnesses.includes(harnessPick)
      ? harnessPick
      : defaultHarness(harnesses, last.harness);

  const folderOptions = activeMac === null ? [] : foldersToPick(mode, activeMac);
  const folderId: string | null =
    activeMac === null
      ? null
      : folderPick !== null &&
        activeMac.folders.some(folder => folder.id === folderPick)
      ? folderPick
      : defaultFolderId(mode, activeMac, last.projectFolderId);

  const channelOptions = useMemo<Channel[]>(
    () => homeChannels(channelsQuery.groups.channels),
    [channelsQuery.groups.channels],
  );
  // 집 채널: 고른 것, 아니면 이 폴더로 마지막에 쓴 채널(기기에만 기억). 처음이면 고르게 한다.
  const rememberedChannel =
    folderId === null ? undefined : last.channelByFolder[folderId];
  const channelId: string | null = (() => {
    const wanted =
      channelPick ??
      rememberedChannel ??
      (channelOptions.length === 1 ? (channelOptions[0] as Channel).id : null);
    if (wanted === null) return null;
    return channelOptions.some(channel => uuidEq(channel.id, wanted)) ? wanted : null;
  })();

  const signing = signingBlock(
    preview?.signing === 'flag_off' || flagClosedByServer
      ? false
      : preview?.signing === 'ready'
      ? true
      : flagQuery.data ?? null,
    preview?.signing !== undefined ? 'approved' : deviceKey.view.kind,
  );
  const signingSentence =
    signing === 'flag_off'
      ? FLAG_OFF_DETAIL
      : signing === 'key'
      ? KEY_NOT_READY_DETAIL
      : null;

  useEffect(() => {
    const sentence = banner ?? signingSentence ?? issue;
    if (sentence !== null) AccessibilityInfo.announceForAccessibility(sentence);
  }, [banner, signingSentence, issue]);

  const loading =
    hostsQuery.isPending || channelsQuery.isPending;

  // ---- 보낸 뒤: 내 요청이 만든 세션을 기다린다 -----------------------------------
  useEffect(() => {
    if (!waiting || sentRef.current === null) return;
    const sent = sentRef.current;
    const found = findSpawnedSession(sessionsQuery.data ?? [], sent.before, {
      selfId: member.id,
      hostId: sent.hostId,
      channelId: sent.channelId,
      label: sent.label,
    });
    if (found !== null && !openedRef.current) {
      openedRef.current = true;
      onOpenSession(found);
      slideClose();
    }
  }, [waiting, sessionsQuery.data, member.id, onOpenSession, slideClose]);
  useEffect(() => {
    if (!waiting) return;
    const id = setTimeout(() => {
      onOpenWorkList();
      slideClose();
    }, waitTimeoutMs);
    return () => clearTimeout(id);
  }, [waiting, waitTimeoutMs, onOpenWorkList, slideClose]);

  const canSend =
    !pending &&
    activeMac !== null &&
    harness !== null &&
    folderId !== null &&
    channelId !== null &&
    signing === null;

  const submit = async () => {
    if (!canSend || activeMac === null || harness === null) return;
    if (folderId === null || channelId === null) return;
    const wrong = promptIssue(prompt);
    if (wrong !== null) {
      setIssue(wrong);
      haptics.error();
      return;
    }
    setIssue(null);
    setBanner(null);
    const text = prompt.normalize('NFC').trim();
    const label = labelFromPrompt(text);
    const before = new Set((sessionsQuery.data ?? []).map(session => session.id));
    setPending(true);
    haptics.light();
    let outcome: SpawnOutcome;
    try {
      outcome = await sender.spawn({
        workspaceId,
        memberId: member.id,
        hostId: activeMac.id,
        folderId,
        tool: harness,
        channelId,
        label,
        prompt: text,
      });
    } catch {
      // 포트는 실패를 결과로 돌려주기로 했지만, 던져도 사람은 왜 아무 일도 없었는지 알아야 한다.
      outcome = {kind: 'refused', sentence: UNKNOWN_FAILURE_SENTENCE};
    } finally {
      setPending(false);
    }
    switch (outcome.kind) {
      case 'sent':
        haptics.success();
        writeAskLast(workspaceId, {
          harness,
          channel: {folderId, channelId},
          ...(mode === 'work' ? {projectFolderId: folderId} : {}),
        });
        sentRef.current = {before, hostId: activeMac.id, channelId, label};
        void client.invalidateQueries({queryKey: ['work-sessions', workspaceId]});
        setWaiting(true);
        return;
      case 'mac_off':
        haptics.error();
        setBanner(MAC_WENT_OFF_SENTENCE);
        void hostsQuery.refetch();
        return;
      case 'flag_off':
        haptics.error();
        setFlagClosedByServer(true);
        return;
      case 'cancelled':
        // 사람이 Face ID를 스스로 접었다. 오류가 아니다: 조용히 폼으로 돌아간다.
        return;
      case 'refused':
      case 'not_wired':
        haptics.error();
        setBanner(outcome.sentence);
        return;
    }
  };

  const header = (confirm?: SheetConfirm) => (
    <SheetHeader
      title="내 맥에 보내기"
      closeLabel="내 맥에 보내기 닫기"
      onClose={slideClose}
      closeTestID="ask-mac-close"
      confirm={confirm}
    />
  );

  const destinationValue =
    activeMac !== null && harness !== null
      ? destinationLine(activeMac, harness)
      : state.kind === 'off'
      ? `내 맥 · ${state.mac.displayName} · 꺼져 있음`
      : '내 맥 · 연결 안 됨';

  const folderName =
    activeMac === null || folderId === null
      ? null
      : activeMac.folders.find(folder => folder.id === folderId)?.displayName ?? null;
  const channelName =
    channelId === null
      ? null
      : channelOptions.find(channel => uuidEq(channel.id, channelId))?.name ?? null;
  const placeLine = [
    folderName !== null
      ? folderName.endsWith('폴더')
        ? folderName
        : `폴더 ${folderName}`
      : null,
    channelName !== null ? `#${channelName}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  const destination = (
    <GroupCard label="보낼 곳" testID="ask-mac-destination">
      <View style={styles.destination}>
        <Sentence style={styles.destinationValue} testID="ask-mac-destination-line">
          {destinationValue}
        </Sentence>
        {state.kind === 'on' && placeLine !== '' ? (
          <Sentence style={styles.destinationPlace} testID="ask-mac-folder-line">
            {placeLine}
          </Sentence>
        ) : null}
      </View>
    </GroupCard>
  );

  if (waiting) {
    return (
      <>
        {header()}
        <SheetScroll>
          {destination}
          <GroupCard>
            <LoadingState
              label="내 맥이 받는 중이에요. 받으면 대화 화면으로 가요."
              testID="ask-mac-waiting"
            />
          </GroupCard>
          <Sentence style={styles.note}>{WAITING_NOTE}</Sentence>
          <GroupCard>
            <ListRow
              title="작업 목록 보기"
              accessory="chevron"
              closesSheet
              onPress={onOpenWorkList}
              testID="ask-mac-to-list"
            />
          </GroupCard>
        </SheetScroll>
      </>
    );
  }

  if (loading) {
    return (
      <>
        {header()}
        <SheetScroll>
          <GroupCard>
            <LoadingState label="내 맥을 확인하는 중이에요." testID="ask-mac-loading" />
          </GroupCard>
        </SheetScroll>
      </>
    );
  }

  if (state.kind !== 'on') {
    return (
      <>
        {header()}
        <SheetScroll testID="ask-mac-off">
          {destination}
          <SheetNotice
            headline={MAC_OFF_HEADLINE}
            detail={state.kind === 'none' ? MAC_NONE_DETAIL : MAC_OFF_DETAIL}
            testID="ask-mac-off-notice"
          />
          {banner !== null ? (
            <FailureBanner message={banner} testID="ask-mac-banner" />
          ) : null}
          <Sentence style={styles.note}>{AGENT_SUGGEST_SENTENCE}</Sentence>
          <GroupCard>
            <ListRow
              title={AGENT_SUGGEST_LABEL}
              accessory="chevron"
              closesSheet
              onPress={onUseAgent}
              testID="ask-mac-use-agent"
            />
          </GroupCard>
        </SheetScroll>
      </>
    );
  }

  if (signing !== null) {
    return (
      <>
        {header()}
        <SheetScroll testID="ask-mac-blocked">
          {destination}
          <SheetNotice
            headline={signing === 'flag_off' ? FLAG_OFF_HEADLINE : KEY_NOT_READY_HEADLINE}
            detail={signingSentence ?? undefined}
            testID="ask-mac-signing"
          />
        </SheetScroll>
      </>
    );
  }

  const sendLabel = pending ? '보내는 중' : '보내기';
  const promptLabel = mode === 'ask' ? '물어볼 것' : '시킬 일';

  return (
    <>
      {header({
        label: sendLabel,
        disabled: !canSend,
        busy: pending,
        onPress: () => {
          void submit();
        },
        testID: 'ask-mac-send',
      })}
      <SheetScroll
        keyboardDismissMode="on-drag"
        // 큰 단은 시트가 키보드를 올리지 않는다 — 몸 스크롤이 입력 칸을 키보드 위로 올려 준다.
        automaticallyAdjustKeyboardInsets
        testID="ask-mac-form">
        {destination}

        {banner !== null ? (
          <FailureBanner message={banner} testID="ask-mac-banner" />
        ) : null}

        <GroupCard label="어떻게 보낼까요" testID="ask-mac-modes">
          {(['ask', 'work'] as const).map(value => (
            <ChoiceRow
              key={value}
              title={MODE_LABEL[value]}
              detail={
                value === 'ask'
                  ? '빈 질문용 폴더에서 물어봐요.'
                  : '프로젝트 폴더에서 일을 시켜요.'
              }
              selected={mode === value}
              onPress={() => {
                haptics.selection();
                setMode(value);
                setFolderPick(null);
                setIssue(null);
              }}
              testID={`ask-mac-mode-${value}`}
            />
          ))}
        </GroupCard>

        <View style={styles.field}>
          <FieldLabel label={promptLabel} />
          <TextArea
            value={prompt}
            onChangeText={value => {
              setPrompt(value);
              setIssue(null);
            }}
            placeholder={
              mode === 'ask'
                ? '예: 이 에러 메시지가 무슨 뜻이야?'
                : '예: 로그인 버그를 찾아서 고쳐 줘.'
            }
            invalid={issue !== null}
            editable={!pending}
            accessibilityLabel={promptLabel}
            testID="ask-mac-prompt"
          />
          {issue !== null ? (
            <Text
              accessibilityLiveRegion="polite"
              style={styles.issue}
              lineBreakStrategyIOS="hangul-word"
              testID="ask-mac-issue"
            >
              {issue}
            </Text>
          ) : null}
          {!pending && folderId === null ? (
            <Text style={styles.hint} lineBreakStrategyIOS="hangul-word" testID="ask-mac-hint">
              {NEED_FOLDER_HINT}
            </Text>
          ) : !pending && channelId === null ? (
            <Text style={styles.hint} lineBreakStrategyIOS="hangul-word" testID="ask-mac-hint">
              {NEED_CHANNEL_HINT}
            </Text>
          ) : null}
          <Text
            style={styles.rule}
            lineBreakStrategyIOS="hangul-word"
            testID="ask-mac-face-id-note">
            {FACE_ID_NOTE}
          </Text>
        </View>

        {state.macs.length > 1 ? (
          <GroupCard label="어느 맥으로" testID="ask-mac-macs">
            {state.macs.map(mac => {
              const on = activeMac !== null && mac.id === activeMac.id;
              return (
                <ChoiceRow
                  key={mac.id}
                  title={mac.displayName}
                  selected={on}
                  onPress={() => {
                    haptics.selection();
                    setMacId(mac.id);
                    setFolderPick(null);
                  }}
                  testID={`ask-mac-mac-${mac.id}`}
                />
              );
            })}
          </GroupCard>
        ) : null}

        <GroupCard label="도구" testID="ask-mac-harnesses">
          {harnesses.map(key => (
            <ChoiceRow
              key={key}
              title={HARNESS_LABEL[key]}
              selected={harness === key}
              onPress={() => {
                haptics.selection();
                setHarnessPick(key);
              }}
              testID={`ask-mac-harness-${key}`}
            />
          ))}
        </GroupCard>

        {folderOptions.length > 0 ? (
          <GroupCard
            label={mode === 'work' ? '어느 폴더에서' : '질문용 폴더를 골라 주세요'}
            testID="ask-mac-folders"
          >
            {folderOptions.map(folder => (
              <ChoiceRow
                key={folder.id}
                title={folder.displayName}
                selected={folderId === folder.id}
                onPress={() => {
                  haptics.selection();
                  setFolderPick(folder.id);
                  setChannelPick(null);
                }}
                testID={`ask-mac-folder-${folder.id}`}
              />
            ))}
          </GroupCard>
        ) : activeMac !== null && folderId === null ? (
          <SheetNotice
            headline={
              mode === 'work'
                ? projectFolders(activeMac).length === 0
                  ? '이 맥에 허용된 프로젝트 폴더가 없어요. 맥 앱에서 폴더를 추가해 주세요.'
                  : '프로젝트 폴더를 골라 주세요.'
                : '이 맥에서 쓸 폴더가 없어요. 맥 앱을 확인해 주세요.'
            }
            testID="ask-mac-no-folder"
          />
        ) : null}

        <GroupCard label="어느 채널에 남길까요" testID="ask-mac-channels">
          {channelOptions.length === 0 ? (
            <ListRow title="들어 있는 채널이 없어요" />
          ) : (
            channelOptions.map(channel => {
              const on = channelId !== null && uuidEq(channelId, channel.id);
              return (
                <ChoiceRow
                  key={channel.id}
                  title={`#${channel.name ?? '이름 없는 채널'}`}
                  detail={channelReach(channel)}
                  selected={on}
                  onPress={() => {
                    haptics.selection();
                    setChannelPick(channel.id);
                  }}
                  testID={`ask-mac-channel-${channel.name ?? channel.id}`}
                />
              );
            })
          )}
        </GroupCard>
      </SheetScroll>
    </>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 「보낼 곳」 카드의 안쪽.
    destination: {
      gap: space.xs,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    destinationValue: {
      fontSize: font.body,
      color: color.text,
      fontWeight: '600',
    },
    destinationPlace: {fontSize: font.label, color: color.textMuted},
    // 카드 밖의 한 문단(안내·각주).
    note: {
      paddingHorizontal: space.xs,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
    // 입력 한 칸의 묶음: 라벨 · 상자 · 실패 · 힌트 · 규칙.
    field: {gap: space.sm},
    hint: {
      paddingHorizontal: space.xs,
      fontSize: font.label,
      color: color.warn,
    },
    issue: {
      paddingHorizontal: space.xs,
      fontSize: font.label,
      color: color.dangerText,
    },
    rule: {
      paddingHorizontal: space.xs,
      fontSize: font.label,
      color: color.textMuted,
    },
  });
