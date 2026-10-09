import {NOT_DELIVERED} from '@momo/core/features/auth/signedControl';
import type {WorkSession} from '@momo/core/lib/api';
import type {WorkSessionEvent} from '@momo/core/features/work/workSessionModel';
import {ROW_STATE_LABEL} from '@momo/core/features/work/workSessionModel';
import {useQueryClient} from '@tanstack/react-query';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type RefreshControlProps,
} from 'react-native';
import {Sentence} from '../../design/atoms';
import {CONV_ICON_SIZE, CONV_ICONS} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  line,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {haptics} from '../../lib/haptics';
import {useReduceMotionRef} from '../../lib/useReduceMotion';
import {CONV} from '../conversation/convDesign';
import {ConversationLayout} from '../conversation/ConversationLayout';
import {
  buildConversation,
  followDecision,
  isNearBottom,
  TIME_BREAK_MS,
  type ChatItem,
  type PendingSend,
} from './conversation';
import {workSessionEventsKey, type SessionEventPage} from './queries';
import {
  PermissionCard,
  useSignedWorkSurface,
  type SigningFlag,
} from './SignedWorkControls';
import {permissionLapsed} from '@momo/core/features/workbench/agentPane';

// =============================================================================
// 작업 상세의 「대화」 모드 (N3 #3595, ADR-0198 증보 1).
//
// 별도 화면도 4번째 탭도 아니다. 작업 상세 안의 두 번째 보기이고, 같은 세션을 말풍선으로
// 읽는다: 내 지시(서명된 input)는 오른쪽, 에이전트의 답(N2 실시간 조각)은 왼쪽, 허락은
// 대화 사이에 끼는 카드다. 순서는 채널 seq(`conversation.ts`).
//
// ## 입력창이 하는 일과 하지 않는 일
// 보내기는 언제나 **서명된 input**이다(`actions.instruct`, Face ID). 서버가 서명 요구를
// 켜기 전에는 이 경로가 403(`signed instructions are not enabled on this instance`)이라
// 입력창은 닫혀 있고 이유를 말한다 - 닫힌 이유를 모른 채 쓴 글이 사라지게 두지 않는다.
// 서명 없는 평문 답글로 슬쩍 내려보내지 않는다(ADR-0146 D-5b).
//
// ## 햅틱은 보내기 탭 1회 (`lib/haptics.ts` 계약)
// 누름 핸들러 안에서 동기로 한 번. 답이 도착하거나 스크롤하거나 보기 전환에서는 부르지 않는다.
//
// ## 맨 아래 따라가기
// 맨 아래에 있으면 새 답이 와도 맨 아래에 머문다. **위로 올려 읽는 중이면 멈추고**
// 「새 답」 표지만 띄운다. 내가 방금 보낸 말은 어디서든 보이게 따라간다. 「동작 줄이기」면
// 부드럽게 미끄러지지 않고 바로 간다.
// =============================================================================

export const SIGNING_OFF_NOTICE =
  '이 서버는 아직 서명된 지시를 받지 않아요. 기기 서명 요구가 켜지면 허락과 지시를 여기서 보낼 수 있어요.';
export const SIGNING_LOADING_NOTICE = '서명 설정을 확인하는 중이에요.';
export const SIGNING_UNKNOWN_NOTICE =
  '서명 설정을 확인하지 못했어요. 잠시 뒤에 다시 열어 주세요.';
export const OWNER_ONLY_NOTICE = '담당자만 허락하고 지시를 보낼 수 있어요.';
export const ENDED_NOTICE = '끝난 작업이라 지시를 더 보낼 수 없어요.';
export const OFFLINE_NOTICE = '오프라인이라 지금은 보낼 수 없어요.';

export type ComposerGate =
  | {kind: 'ready'}
  /** 입력창은 보이지만 닫혀 있다. 이유를 말한다. */
  | {kind: 'closed'; notice: string}
  /** 입력창 자리가 없다(내 작업이 아니거나 끝난 작업). */
  | {kind: 'none'; notice: string};

/** 입력창이 열리는 조건 - 순서가 곧 우선순위다. */
export function composerGate(input: {
  owner: boolean;
  ended: boolean;
  flag: SigningFlag;
  block: string | null;
  online: boolean;
  hasActions: boolean;
}): ComposerGate {
  if (!input.owner) return {kind: 'none', notice: OWNER_ONLY_NOTICE};
  if (input.ended) return {kind: 'none', notice: ENDED_NOTICE};
  if (input.flag === 'loading') return {kind: 'closed', notice: SIGNING_LOADING_NOTICE};
  if (input.flag === 'unknown') return {kind: 'closed', notice: SIGNING_UNKNOWN_NOTICE};
  if (input.flag === 'off') return {kind: 'closed', notice: SIGNING_OFF_NOTICE};
  if (input.block !== null || !input.hasActions) {
    return {kind: 'closed', notice: input.block ?? SIGNING_LOADING_NOTICE};
  }
  if (!input.online) return {kind: 'closed', notice: OFFLINE_NOTICE};
  return {kind: 'ready'};
}

export type ConversationMode = 'detail' | 'chat';

/**
 * 「상세 | 대화」 - 같은 세션의 두 보기. 4번째 탭도 별도 화면도 아니다. 값이 한 칸
 * 넘어가는 일이라 눌러서 바뀌는 것만 하고, 햅틱은 쓰지 않는다(햅틱은 보내기 1회).
 */
export function ModeSwitch({
  mode,
  onChange,
}: {
  mode: ConversationMode;
  onChange: (next: ConversationMode) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const option = (value: ConversationMode, label: string) => (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{selected: mode === value}}
      onPress={() => {
        if (mode !== value) onChange(value);
      }}
      style={[styles.segment, mode === value && styles.segmentOn]}
      testID={`work-mode-${value}`}>
      <Text style={[styles.segmentLabel, mode === value && styles.segmentLabelOn]}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View style={styles.switchWrap}>
      <View accessibilityRole="tablist" style={styles.switchTrack} testID="work-mode-switch">
        {option('detail', '상세')}
        {option('chat', '대화')}
      </View>
    </View>
  );
}

export type SendOutcome = {ok: true} | {ok: false; text: string};

const TIME = new Intl.DateTimeFormat('ko-KR', {hour: 'numeric', minute: '2-digit'});

/** 입력창이 자라는 상한(줄 수). */
const COMPOSER_MAX_ROWS = 5;

// ---- 표시 -----------------------------------------------------------------------

export interface WorkConversationViewProps {
  items: readonly ChatItem[];
  /** 에이전트 말풍선 위에 붙는 이름(도구 이름). */
  agentName: string;
  nameOf: (memberId: string) => string;
  gate: ComposerGate;
  onSend: (text: string, mode: 'queue' | 'interrupt') => Promise<SendOutcome>;
  /** 허락 카드 자리. 카드가 그려질 때만 호출한다. */
  renderPermission: () => React.ReactNode;
  /** 닿지 않은 「거부 + 지시」 글을 입력창으로 옮긴다. */
  seed?: {text: string} | null;
  refreshControl?: React.ReactElement<RefreshControlProps>;
  /** 캡처 하네스 전용: 처음부터 이 글이 입력창에 들어 있다. */
  initialText?: string;
  autoFocus?: boolean;
}

export function WorkConversationView(
  props: WorkConversationViewProps,
): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const scrollRef = useRef<ScrollView>(null);
  const reduce = useReduceMotionRef();
  const following = useRef(true);
  const mineJustSent = useRef(false);
  const firstLayout = useRef(true);
  const lastHeight = useRef(0);
  const [unseen, setUnseen] = useState(false);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const {contentOffset, layoutMeasurement, contentSize} = event.nativeEvent;
      const near = isNearBottom(
        contentOffset.y,
        layoutMeasurement.height,
        contentSize.height,
      );
      following.current = near;
      if (near) setUnseen(false);
    },
    [],
  );

  const onContentSizeChange = useCallback((_width: number, height: number) => {
    const grew = height > lastHeight.current;
    lastHeight.current = height;
    const decision = followDecision({
      following: following.current,
      mineJustSent: mineJustSent.current,
    });
    if (decision === 'scroll' || firstLayout.current) {
      // 처음 자리 잡을 때와 「동작 줄이기」에서는 미끄러지지 않고 바로 간다.
      scrollRef.current?.scrollToEnd({
        animated: !firstLayout.current && !reduce.current,
      });
      mineJustSent.current = false;
      following.current = true;
      firstLayout.current = false;
      return;
    }
    if (grew) setUnseen(true);
  }, [reduce]);

  const jumpToEnd = useCallback(() => {
    following.current = true;
    setUnseen(false);
    scrollRef.current?.scrollToEnd({animated: !reduce.current});
  }, [reduce]);

  const onSendProp = props.onSend;
  const send = useCallback(
    (text: string, mode: 'queue' | 'interrupt') => {
      mineJustSent.current = true;
      return onSendProp(text, mode);
    },
    [onSendProp],
  );

  return (
    <ConversationLayout
      list={
        <View style={styles.listWrap}>
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.listBody}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onContentSizeChange={onContentSizeChange}
            refreshControl={props.refreshControl}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            testID="work-chat-scroll">
            {props.items.length === 0 ? (
              <Sentence style={styles.empty} testID="work-chat-empty">
                아직 주고받은 말이 없어요.
              </Sentence>
            ) : null}
            {props.items.map((item, index) => (
              <ChatRow
                key={item.id}
                item={item}
                previous={index > 0 ? props.items[index - 1] : null}
                agentName={props.agentName}
                nameOf={props.nameOf}
                renderPermission={props.renderPermission}
              />
            ))}
          </ScrollView>
          {unseen ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="새 답이 왔어요. 맨 아래로 이동"
              onPress={jumpToEnd}
              style={({pressed}) => [styles.unseen, pressed && styles.unseenPressed]}
              testID="work-chat-unseen">
              <Text style={styles.unseenLabel}>새 답 ↓</Text>
            </Pressable>
          ) : null}
        </View>
      }
      composer={
        <ChatComposer
          gate={props.gate}
          onSend={send}
          seed={props.seed ?? null}
          initialText={props.initialText}
          autoFocus={props.autoFocus}
        />
      }
    />
  );
}

function timeLabel(atMs: number): string {
  return TIME.format(new Date(atMs));
}

function ChatRow({
  item,
  previous,
  agentName,
  nameOf,
  renderPermission,
}: {
  item: ChatItem;
  previous: ChatItem | null;
  agentName: string;
  nameOf: (memberId: string) => string;
  renderPermission: () => React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const showTime =
    previous === null || item.atMs - previous.atMs >= TIME_BREAK_MS;
  const sameSide = previous !== null && previous.kind === item.kind && !showTime;
  return (
    <View>
      {showTime ? (
        <Text style={styles.timeBreak} testID="work-chat-time">
          {timeLabel(item.atMs)}
        </Text>
      ) : null}
      {item.kind === 'mine' ? (
        <View style={[styles.rowMine, sameSide && styles.rowTight]}>
          <View
            accessible
            accessibilityLabel={`나, ${timeLabel(item.atMs)}, ${item.text}${
              item.mode === 'interrupt' ? ', 끼어들기' : ''
            }${
              item.delivery === 'sending'
                ? ', 보내는 중'
                : ''
            }`}
            style={[
              styles.bubble,
              styles.bubbleMine,
              item.delivery === 'sending' && styles.bubbleSending,
            ]}
            testID="work-chat-mine">
            <Text selectable style={styles.textMine}>
              {item.text}
            </Text>
          </View>
          {item.mode === 'interrupt' || item.delivery === 'sending' ? (
            <Text style={styles.caption} testID="work-chat-mine-caption">
              {item.delivery === 'sending'
                ? 'Face ID 확인 중'
                : '끼어들었어요'}
            </Text>
          ) : null}
        </View>
      ) : item.kind === 'agent' || item.kind === 'other' ? (
        <View style={[styles.rowOther, sameSide && styles.rowTight]}>
          {sameSide ? null : (
            <Text style={styles.speaker}>
              {item.kind === 'agent' ? agentName : nameOf(item.authorMemberId)}
            </Text>
          )}
          <View
            accessible
            accessibilityLabel={`${
              item.kind === 'agent' ? agentName : nameOf(item.authorMemberId)
            }, ${timeLabel(item.atMs)}, ${item.text}${
              item.kind === 'agent' && item.streaming ? ', 작성 중' : ''
            }`}
            style={[styles.bubble, styles.bubbleOther]}
            testID={item.kind === 'agent' ? 'work-chat-agent' : 'work-chat-other'}>
            <Text selectable style={styles.textOther}>
              {item.text}
            </Text>
          </View>
          {item.kind === 'agent' && item.streaming ? (
            <Text style={styles.caption} testID="work-chat-writing">
              작성 중
            </Text>
          ) : null}
        </View>
      ) : item.kind === 'permission' ? (
        <View style={styles.permissionWrap} testID="work-chat-permission">
          {renderPermission()}
        </View>
      ) : (
        <Text
          style={styles.systemLine}
          accessibilityLabel={`${item.text}${
            item.state === 'done' ? '' : `, ${ROW_STATE_LABEL[item.state]}`
          }`}
          testID="work-chat-system">
          {item.text}
          {item.state === 'done' ? '' : ` · ${ROW_STATE_LABEL[item.state]}`}
        </Text>
      )}
    </View>
  );
}

// ---- 입력창 ---------------------------------------------------------------------

function ChatComposer({
  gate,
  onSend,
  seed,
  initialText,
  autoFocus,
}: {
  gate: ComposerGate;
  onSend: (text: string, mode: 'queue' | 'interrupt') => Promise<SendOutcome>;
  seed: {text: string} | null;
  initialText?: string;
  autoFocus?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const [text, setText] = useState(initialText ?? '');
  const [interrupt, setInterrupt] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    // 입력창에 이미 있는 초안은 지키고, 닿지 않은 글은 그 뒤에 붙인다.
    if (seed) {
      setText(current =>
        current.trim() === '' ? seed.text : `${current.trimEnd()}\n${seed.text}`,
      );
    }
  }, [seed]);

  const ready = gate.kind === 'ready';
  const canSend = ready && text.trim() !== '' && !sending;

  const submit = () => {
    const body = text.trim();
    if (!ready || body === '' || sending) return;
    // 시각과 같은 프레임, 누름 핸들러 안에서 동기로 한 번 (haptics.ts 계약).
    haptics.light();
    const mode = interrupt ? 'interrupt' : 'queue';
    setText('');
    setNote(null);
    setInterrupt(false);
    setSending(true);
    void onSend(body, mode).then(outcome => {
      if (!alive.current) return;
      setSending(false);
      if (outcome.ok) return;
      // 보낸 글을 잃지 않는다. 그 사이에 쓴 글이 있으면 그 앞에 되돌린다.
      setText(current =>
        current.trim() === '' ? body : `${body}\n${current.trimStart()}`,
      );
      setInterrupt(mode === 'interrupt');
      setNote(outcome.text);
    });
  };

  if (gate.kind === 'none') {
    return (
      <View style={styles.dock} testID="work-chat-dock">
        <Sentence style={styles.dockNotice} testID="work-chat-notice">
          {gate.notice}
        </Sentence>
      </View>
    );
  }

  const maxHeight = line.body * COMPOSER_MAX_ROWS + space.sm * 2;
  return (
    <View style={styles.dock} testID="work-chat-dock">
      {gate.kind === 'closed' ? (
        <Sentence style={styles.dockNotice} testID="work-chat-notice">
          {gate.notice}
        </Sentence>
      ) : (
        <View style={styles.modeRow}>
          <Sentence style={styles.modeHint} testID="work-chat-mode-hint">
            {interrupt
              ? '지금 차례에 끼어들어요.'
              : '다음 차례에 전달돼요. 보낼 때마다 Face ID로 서명해요.'}
          </Sentence>
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel="지금 끼어들기"
            accessibilityState={{checked: interrupt, disabled: sending}}
            disabled={sending}
            hitSlop={(TOUCH_TARGET - CONV.composerSend) / 2}
            onPress={() => setInterrupt(value => !value)}
            style={[styles.chip, interrupt && styles.chipOn]}
            testID="work-chat-interrupt">
            <Text style={[styles.chipLabel, interrupt && styles.chipLabelOn]}>
              끼어들기
            </Text>
          </Pressable>
        </View>
      )}
      {note ? (
        <Sentence
          accessibilityRole="alert"
          style={styles.failure}
          testID="work-chat-failure">
          {note}
        </Sentence>
      ) : null}
      <View style={styles.pill}>
        <TextInput
          lineBreakStrategyIOS="hangul-word"
          style={[styles.input, {maxHeight}]}
          value={text}
          onChangeText={value => {
            setText(value);
            setNote(null);
          }}
          multiline
          editable={ready}
          autoFocus={autoFocus}
          placeholder={ready ? '다음 지시를 적어요' : '지금은 지시를 보낼 수 없어요'}
          placeholderTextColor={palette.textFaint}
          accessibilityLabel="다음 지시"
          blurOnSubmit={false}
          textAlignVertical="top"
          testID="work-chat-input"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={sending ? 'Face ID 확인 중' : '지시 보내기'}
          accessibilityState={{disabled: !canSend}}
          disabled={!canSend}
          hitSlop={(TOUCH_TARGET - CONV.composerSend) / 2}
          onPress={submit}
          style={({pressed}) => [
            styles.send,
            !canSend && styles.sendDisabled,
            pressed && canSend && styles.sendPressed,
          ]}
          testID="work-chat-send">
          <Image
            source={CONV_ICONS.up}
            style={[
              styles.sendGlyph,
              {tintColor: canSend ? palette.onPrimary : palette.textFaint},
            ]}
          />
        </Pressable>
      </View>
    </View>
  );
}

// ---- 컨테이너 -------------------------------------------------------------------

export function WorkConversation({
  workspaceId,
  memberId,
  session,
  events,
  page,
  online,
  agentName,
  nameOf,
  refreshControl,
}: {
  workspaceId: string;
  memberId: string;
  session: WorkSession;
  /** 이 세션 것만, 읽은 것과 꼬리를 합친 이벤트. */
  events: readonly WorkSessionEvent[];
  page: SessionEventPage | undefined;
  online: boolean;
  agentName: string;
  nameOf: (memberId: string) => string;
  refreshControl?: React.ReactElement<RefreshControlProps>;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const surface = useSignedWorkSurface(workspaceId, memberId, session, events);
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [seed, setSeed] = useState<{text: string} | null>(null);
  const counter = useRef(0);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const ended = session.status !== 'running' && session.status !== 'idle';
  const gate = composerGate({
    owner: surface.owner,
    ended,
    flag: surface.flag,
    block: surface.block,
    online,
    hasActions: surface.actions !== null,
  });
  // 버튼 없는 카드는 만들지 않는다: 카드는 소유자 + 서명 요구가 켜진 뒤에만 선다.
  const cardAllowed = surface.owner && surface.required && surface.permission !== null;

  const items = useMemo(
    () =>
      buildConversation({
        events,
        session,
        truncated: page?.truncated ?? false,
        replies: page?.replies ?? [],
        selfMemberId: memberId,
        pending,
        permissionRequestId: cardAllowed
          ? (surface.permission?.requestEventId ?? null)
          : null,
      }),
    [events, session, page, memberId, pending, cardAllowed, surface.permission],
  );

  const eventsKey = workSessionEventsKey(
    workspaceId,
    session.channelId,
    session.rootMessageId ?? '',
  );

  const send = useCallback(
    async (text: string, mode: 'queue' | 'interrupt'): Promise<SendOutcome> => {
      const actions = surface.actions;
      if (actions === null) {
        return {ok: false, text: `${NOT_DELIVERED} · ${SIGNING_LOADING_NOTICE}`};
      }
      counter.current += 1;
      const localId = `pending-${counter.current}`;
      setPending(list => [
        ...list,
        {localId, text, mode, startedAtMs: Date.now(), status: 'sending'},
      ]);
      const out = await actions.instruct(text, mode);
      if (out.state === 'not_delivered') {
        if (alive.current) setPending(list => list.filter(p => p.localId !== localId));
        return {ok: false, text: `${NOT_DELIVERED} · ${out.text}`};
      }
      if (alive.current) {
        setPending(list =>
          list.map(p => (p.localId === localId ? {...p, status: 'sent'} : p)),
        );
      }
      // 내 지시는 서버가 같은 트랜잭션으로 스레드에 남긴다 - 읽기를 한 번 다시 하면 온다.
      void queryClient.invalidateQueries({queryKey: eventsKey}).then(() => {
        if (!alive.current) return;
        if (queryClient.getQueryState(eventsKey)?.status === 'error') return;
        setPending(list => list.filter(p => p.localId !== localId));
      });
      return {ok: true};
    },
    [surface.actions, queryClient, eventsKey],
  );

  const renderPermission = useCallback(
    () =>
      surface.permission === null ? null : (
        <PermissionCard
          key={surface.permission.requestEventId}
          permission={surface.permission}
          preview={surface.preview}
          online={online}
          block={surface.block}
          actions={surface.actions}
          fallbackReject={surface.fallbackReject}
          lapsed={permissionLapsed(surface.permission, Date.now())}
          onUndelivered={text => setSeed({text})}
        />
      ),
    [surface, online],
  );

  return (
    <WorkConversationView
      items={items}
      agentName={agentName}
      nameOf={nameOf}
      gate={gate}
      onSend={send}
      renderPermission={renderPermission}
      seed={seed}
      refreshControl={refreshControl}
    />
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    switchWrap: {paddingHorizontal: SAFE_GUTTER, paddingVertical: space.sm},
    switchTrack: {
      flexDirection: 'row',
      padding: space.xs / 2,
      borderRadius: ds2Radius.row,
      backgroundColor: color.surfaceMuted,
    },
    segment: {
      flex: 1,
      minHeight: TOUCH_TARGET - space.sm,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: ds2Radius.row - space.xs / 2,
    },
    segmentOn: {backgroundColor: color.surface},
    segmentLabel: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
      fontWeight: '600',
    },
    segmentLabelOn: {color: color.text},
    listWrap: {flex: 1},
    listBody: {
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.md,
      paddingBottom: space.lg,
      gap: space.sm,
    },
    empty: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
      textAlign: 'center',
      paddingVertical: space.xl,
    },
    timeBreak: {
      alignSelf: 'center',
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontVariant: ['tabular-nums'],
      paddingVertical: space.xs,
    },
    rowMine: {alignItems: 'flex-end', gap: space.xs},
    rowOther: {alignItems: 'flex-start', gap: space.xs},
    // 같은 쪽이 이어질 때는 간격을 좁혀 한 덩이로 읽힌다.
    rowTight: {marginTop: -space.xs},
    bubble: {
      maxWidth: '84%',
      borderRadius: ds2Radius.card,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
    },
    bubbleMine: {backgroundColor: color.primary},
    bubbleSending: {opacity: 0.6},
    bubbleOther: {
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.border,
    },
    textMine: {fontSize: font.body, lineHeight: line.body, color: color.onPrimary},
    textOther: {fontSize: font.body, lineHeight: line.body, color: color.text},
    speaker: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontWeight: '600',
      paddingHorizontal: space.xs,
    },
    caption: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      paddingHorizontal: space.xs,
    },
    systemLine: {
      alignSelf: 'center',
      textAlign: 'center',
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      paddingHorizontal: space.md,
    },
    permissionWrap: {
      marginHorizontal: -SAFE_GUTTER + space.sm,
      paddingTop: space.sm,
      borderRadius: ds2Radius.card,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    unseen: {
      position: 'absolute',
      alignSelf: 'center',
      bottom: space.md,
      minHeight: CONV.composerSend,
      justifyContent: 'center',
      paddingHorizontal: space.lg,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.primary,
    },
    unseenPressed: {opacity: 0.8},
    unseenLabel: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.onPrimary,
      fontWeight: '600',
    },
    dock: {
      paddingHorizontal: CONV.composerInset,
      paddingTop: space.sm,
      gap: space.xs,
    },
    dockNotice: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
      paddingHorizontal: space.xs,
      paddingBottom: space.xs,
    },
    modeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.xs,
    },
    modeHint: {
      flex: 1,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    chip: {
      minHeight: CONV.composerSend - space.sm,
      justifyContent: 'center',
      paddingHorizontal: space.md,
      borderRadius: ds2Radius.pill,
      borderWidth: 1,
      borderColor: color.textFaint,
      backgroundColor: color.surface,
    },
    chipOn: {backgroundColor: color.primary, borderColor: color.primary},
    chipLabel: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.text,
      fontWeight: '600',
    },
    chipLabelOn: {color: color.onPrimary},
    failure: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.dangerText,
      paddingHorizontal: space.xs,
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: space.sm,
      minHeight: TOUCH_TARGET,
      paddingLeft: space.md,
      paddingRight: (TOUCH_TARGET - CONV.composerSend) / 2,
      paddingVertical: (TOUCH_TARGET - CONV.composerSend) / 2,
      borderRadius: ds2Radius.composer,
      borderWidth: 1,
      borderColor: color.textFaint,
      backgroundColor: color.surface,
    },
    input: {
      flex: 1,
      minHeight: CONV.composerSend,
      paddingVertical: space.sm,
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
    },
    send: {
      width: CONV.composerSend,
      height: CONV.composerSend,
      borderRadius: CONV.composerSend / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.primary,
    },
    sendGlyph: {width: CONV_ICON_SIZE.up, height: CONV_ICON_SIZE.up},
    sendDisabled: {backgroundColor: color.surfaceMuted},
    sendPressed: {opacity: 0.8},
  });
