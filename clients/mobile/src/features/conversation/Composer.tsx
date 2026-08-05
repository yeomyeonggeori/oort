import type {RosterMember} from '@momo/core/lib/api';
import {attachParticle} from '@momo/core/lib/koreanParticle';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useMemo, useRef, useState} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import {color, font, radius, SAFE_GUTTER, space, TOUCH_TARGET} from '../../design/tokens';
import {
  applyMention,
  caretAfterChange,
  matchMembers,
  mentionQueryAt,
} from './mentionQuery';
import type {QuoteDraft} from '@momo/core/features/timeline/quote';
import {QuoteDraftBar} from './Quote';

// =============================================================================
// The composer.
//
// ## The one rule this file exists to keep: `value` is SYNCHRONOUS
//
// Spike #837 gate 1, measured on 성재's iPhone 17 (iOS 26.5.1). Five composer
// shapes were typed by hand with the standard and the 10-key Korean keyboards.
// Four produced `안녕하세요`. The fifth — identical except that it applied the
// value one tick late, `setTimeout(() => setValue(next), 0)` — produced
// `ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ` on the standard keyboard and `ㅇ|·ㄴㄴ··|ㅇㅎ|·ㅅ·`
// on the 10-key. The deferred write severs iOS's composition session, and the
// jamo never combine at all.
//
// So: `onChangeText` calls `setText` and nothing else may come between a
// keystroke and the rendered value. No queue, no store round trip, no network,
// no debounce, no `useDeferredValue`. The send path is deliberately a SEPARATE
// rail — `onSend` is fired and never awaited, and the message's fate is the
// pending row's business, not this input's.
//
// The mention list is safe under that rule and was measured to be: gate 1 case
// C re-filtered and re-rendered a 60-member list on every keystroke DURING
// composition and still produced `안녕하세요`. Controlled input was never the
// problem; deferred value was.
//
// A guard is not enough to keep this true, so `__tests__/composerHangul.test.tsx`
// replays the exact keystroke transitions captured on the device and asserts the
// rendered `value` after each one, synchronously, with no act() flush between.
// An implementation that deferred the write fails it.
//
// **`onTyping` is the second thing to obey that rule** (ADR-0149). 「작성 중」 is
// a per-keystroke signal, which is exactly the shape that could break composition
// — so it is fired the way `onSend` is: AFTER the value is written, never
// awaited, and never allowed to decide anything about `value`. What it costs a
// keystroke is one function call; everything expensive (the grant, the 3s
// republish cadence, the POST) lives in the surface that owns the channel, for
// the same reason the send does.
//
// ## Enter is a newline here, and there is a send button
//
// The core's `composerKeyIntent` exists so the web client can send on Enter
// without stealing the Enter that commits an IME composition. Its own contract
// says a phone passes `enterSends: false`: a software keyboard has no
// Shift+Enter, so sending on Enter would delete multi-line writing entirely.
// With Enter never sending, the IME-Enter collision cannot arise on this
// client, so the hook is not wired — the button is the only send.
// =============================================================================

/** Rows the input may grow to before it scrolls internally. */
const MAX_HEIGHT = 120;

export function Composer({
  channelLabel,
  directory,
  dmAgent,
  disabled,
  onSend,
  onTyping,
  quote,
  onCancelQuote,
  placeholder,
  sendLabel = '보내기',
  inputRef: externalInputRef,
}: {
  channelLabel: string;
  directory: Directory;
  /** Overrides the derived "…에 메시지 보내기". A thread is not a channel. */
  placeholder?: string;
  /** Overrides 보내기. A reply says what it is. */
  sendLabel?: string;
  /** The agent a DM answers without an @mention, if this is that kind of DM. */
  dmAgent?: RosterMember | null;
  /** The rail is down: the composer says so rather than failing silently. */
  disabled?: boolean;
  onSend: (body: string) => void;
  /**
   * 자판이 눌렸다 (ADR-0149 「작성 중」).
   *
   * 한 글자마다 한 번, **동기 쓰기 뒤에** 불린다. 얼마나 자주 실제로 보낼지는
   * 여기서 정하지 않는다 — 재전송 주기는 서버가 grant 응답으로 내려보내는 값이고
   * (`republishIntervalMs`), 그것을 지키는 것은 채널을 아는 화면의 일이다. 이
   * 파일이 아는 것은 「방금 무언가 쳤다」뿐이다.
   *
   * 「입력을 멈추면 송신이 멈춘다」는 따로 배선하지 않아도 성립한다: 재전송을
   * 미는 것이 키스트로크이므로, 키스트로크가 멎으면 재전송도 멎고 TTL 이 나머지를
   * 한다. **stop 신호가 없는 것이 계약이다.**
   */
  onTyping?: () => void;
  /**
   * 지금 인용을 걸고 쓰는 중이면 그 원문 (ADR-0148). `null`/`undefined` 면 없다.
   */
  quote?: QuoteDraft | null;
  /** 인용을 무른다. 인용이 있는데 이것이 없으면 나가는 길이 없다. */
  onCancelQuote?: () => void;
  /**
   * The text field itself. Exposed so a caller can put the caret here — the
   * empty-state "첫 메시지 쓰기" affordance wants it, and `measure/` uses it to
   * raise the real software keyboard without a tap (a simulator cannot be
   * tapped by a script, so a harness that needed one could not run at all).
   */
  inputRef?: React.MutableRefObject<TextInput | null>;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(true);
  const ownInputRef = useRef<TextInput | null>(null);
  const inputRef = externalInputRef ?? ownInputRef;
  // Mirrors `text` for the caret derivation below without making `onChangeText`
  // depend on it — a changing identity there would rebuild the handler on every
  // keystroke, which is exactly the churn this file is careful about.
  const currentTextRef = useRef('');

  // Derived during render, not in an effect: an effect would compute the list
  // one commit after the keystroke that opened it, which is the same lateness
  // this file bans for `value` — and the candidate list riding one keystroke
  // behind is how a person accepts the wrong member.
  const query = mentionOpen ? mentionQueryAt(text, caret) : null;
  const candidates = useMemo(
    () => (query ? matchMembers(directory.members, query.text) : []),
    [query, directory.members],
  );
  const showMentions = candidates.length > 0;

  // `onTyping` 을 의존성으로 들지 않기 위한 거울. 호출자가 핸들러 동일성을
  // 흘리면 `onChangeText` 가 키스트로크마다 새로 만들어지고, 그것은 이 파일이
  // 가장 조심하는 종류의 흔들림이다.
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;

  const onChangeText = useCallback((next: string) => {
    // SYNCHRONOUS. See the header. The caret is derived from the edit itself
    // rather than read from `onSelectionChange`, because that event arrives on
    // its own schedule and a mention query computed from a stale caret offers
    // candidates for a token the person already finished typing. Deriving it
    // costs one string compare and is exact for an insertion, a deletion, and
    // for an IME replacing the composing tail.
    setCaret(caretAfterChange(currentTextRef.current, next));
    currentTextRef.current = next;
    setText(next);
    setMentionOpen(true);
    // LAST, and on a separate rail. Everything above is the value; this is a
    // signal about the person, and it must never be able to reorder itself in
    // front of the write (see the header's 「작성 중」 note).
    onTypingRef.current?.();
  }, []);

  const onSelectionChange = useCallback(
    (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      // Only a caret MOVE (tapping elsewhere). Text edits already set the caret
      // synchronously above; taking this event's value as well would let a late
      // selection event overwrite the fresh position with the old one.
      const {start, end} = event.nativeEvent.selection;
      if (start === end && currentTextRef.current === text) setCaret(start);
    },
    [text],
  );

  const accept = useCallback(
    (member: RosterMember) => {
      if (!query) return;
      const next = applyMention(text, query, caret, member.handle);
      // Same synchronous write as a keystroke, and note what is NOT done here:
      // the `selection` prop is never set. Controlling selection on iOS resets
      // the input's composition state, which is the very failure this file is
      // built around — so the caret is tracked, and the OS keeps ownership of it.
      currentTextRef.current = next.text;
      setText(next.text);
      setCaret(next.caret);
      setMentionOpen(false);
    },
    [query, text, caret],
  );

  const submit = useCallback(() => {
    const body = text.trim();
    if (body === '') return;
    // Clear first, send second. The echo row carries the message from here on,
    // including its failure state and its retry; a composer that stays full
    // while its message is visible below reads as if nothing happened.
    currentTextRef.current = '';
    setText('');
    setCaret(0);
    setMentionOpen(false);
    onSend(body);
  }, [text, onSend]);

  const canSend = text.trim() !== '';

  return (
    <View style={styles.root}>
      {showMentions ? (
        <View style={styles.mentions} testID="mention-list">
          <ScrollView
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}>
            {candidates.map(member => (
              <Pressable
                key={member.id}
                accessibilityRole="button"
                accessibilityLabel={`${member.displayName} @${member.handle}`}
                onPress={() => accept(member)}
                style={({pressed}) => [
                  styles.mentionRow,
                  pressed && styles.pressed,
                ]}
                testID="mention-option">
                <Text
                  style={[
                    styles.mentionName,
                    member.kind === 'agent' && styles.mentionNameAgent,
                  ]}
                  numberOfLines={1}>
                  {member.displayName}
                </Text>
                <Text style={styles.mentionHandle} numberOfLines={1}>
                  {`@${member.handle}`}
                </Text>
                {member.kind === 'agent' ? (
                  <Text style={styles.mentionKind}>에이전트</Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {dmAgent && text.trim() === '' ? (
        <Text style={styles.hint}>
          {/* 이 자리에 병기형을 적는 것은 번역이 아니라 **기계가 사람 앞에서
              결정을 미루는 것**이다 (goal RN-B4c / #1027). 규칙은 마지막 음절
              하나로 전부 결정되고, 그 규칙은 이 레포에 이미 있다 —
              `@momo/core/lib/koreanParticle`. 라틴·숫자로 끝나는 이름은 열린
              형태를 받는다: 「Hermes가」, 「루나가」, 「김인턴이」. */}
          {`멘션 없이 바로 말하면 ${attachParticle(
            dmAgent.displayName,
            'subject',
          )} 답합니다.`}
        </Text>
      ) : null}

      {disabled ? (
        <Text style={styles.offline}>
          연결이 끊겼습니다. 보낸 메시지는 연결이 돌아오면 다시 시도할 수 있습니다.
        </Text>
      ) : null}

      {/* 입력창 **바로 위**. 지금 쓰고 있는 글이 무엇을 가리키는지는 그 글을
          쓰는 자리에 붙어 있어야 하고, 취소도 거기 있어야 한다 — 들어가는 길만
          있고 나오는 길이 없으면 안 된다(ADR-0148 미결 3). */}
      {quote && onCancelQuote ? (
        <QuoteDraftBar
          block={quote.block}
          directory={directory}
          onCancel={onCancelQuote}
        />
      ) : null}

      <View style={styles.bar}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={text}
          onChangeText={onChangeText}
          onSelectionChange={onSelectionChange}
          placeholder={placeholder ?? `${channelLabel}에 메시지 보내기`}
          placeholderTextColor={color.textFaint}
          accessibilityLabel={placeholder ?? `${channelLabel}에 보낼 메시지`}
          multiline
          // Enter inserts a newline (see the header). `blurOnSubmit` false keeps
          // the keyboard up, because on a phone the return key is the only line
          // break there is.
          blurOnSubmit={false}
          textAlignVertical="top"
          testID="composer-input"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={sendLabel}
          accessibilityState={{disabled: !canSend}}
          disabled={!canSend}
          onPress={submit}
          style={({pressed}) => [
            styles.send,
            !canSend && styles.sendDisabled,
            pressed && canSend && styles.sendPressed,
          ]}
          testID="composer-send">
          <Text style={[styles.sendLabel, !canSend && styles.sendLabelDisabled]}>
            {sendLabel}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    backgroundColor: color.bg,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.sm,
  },
  input: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    maxHeight: MAX_HEIGHT,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    // 16 is where iOS stops zooming a focused field; anything smaller makes the
    // whole screen lurch the first time someone taps to type.
    fontSize: font.body,
    color: color.text,
    lineHeight: 21,
  },
  send: {
    minHeight: TOUCH_TARGET,
    minWidth: 64,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accent,
  },
  sendDisabled: {backgroundColor: color.border},
  sendPressed: {backgroundColor: color.accentPressed},
  sendLabel: {color: color.onAccent, fontSize: font.label, fontWeight: '700'},
  sendLabelDisabled: {color: color.textFaint},
  mentions: {
    maxHeight: 180,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  mentionRow: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: SAFE_GUTTER,
  },
  mentionName: {fontSize: font.label, fontWeight: '600', color: color.text},
  mentionNameAgent: {color: color.agent},
  mentionHandle: {flex: 1, fontSize: font.meta, color: color.textFaint},
  mentionKind: {fontSize: font.meta, color: color.agent},
  hint: {
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.sm,
    fontSize: font.meta,
    color: color.textFaint,
  },
  offline: {
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.sm,
    fontSize: font.meta,
    color: color.warn,
  },
  pressed: {backgroundColor: color.surfacePressed},
});
