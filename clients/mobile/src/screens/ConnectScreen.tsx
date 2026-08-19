import {joinWithInvite, login} from '@momo/core/lib/api';
import {
  joinFailureCopy,
  prefillFocus,
  signInFailureCopy,
  type ConnectFailure,
  type ConnectField,
  type ConnectMode,
} from '@momo/core/features/auth/connectModel';
import NetInfo from '@react-native-community/netinfo';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {FailureBanner, NoticeBlock, PrimaryButton, Screen} from '../design/atoms';
import {font, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../design/tokens';
import {usePalette, useStyles} from '../design/theme';
import {useJoinPrefill} from '../deeplink/joinLink';
import {isOnlineFromNetInfo} from '../query/queryClient';
import {SESSION_EXPIRED_NOTICE} from '../session/authGate';
import {
  normalizeServerUrl,
  SERVER_URL_PLACEHOLDER,
  setServerBase,
  getServerBase,
  requiresServerUrl,
} from '../storage/serverBase';

// =============================================================================
// The one screen a signed-out person sees. Two jobs behind one form: signing in,
// and redeeming an invite (`oort://join?server=…&code=…`).
//
// ## Everything that decides is in the core
//
// This file has no opinion about what went wrong. `signInFailureCopy` and
// `joinFailureCopy` (`@momo/core/features/auth/connectModel`) turn a status into
// a Korean sentence, whether it is retryable, and whether the answer is "you
// already joined — sign in instead"; `normalizeServerUrl` decides what a usable
// address is and writes the rejection; `prefillFocus` decides where the cursor
// lands after a link fills what it could. The web client calls exactly these
// four, and the two screens therefore cannot drift into telling one person two
// different stories about the same 409.
//
// The previous version of this file wrote its own titles ("로그인 정보가 맞지
// 않습니다"). That was correct for a wiring proof and wrong now: two clients,
// two vocabularies, one server.
//
// ## Spike constraint 1 (#837 gate 1 case D) — every field is synchronous
//
// Each `value` below is plain local `useState`, updated inside `onChangeText`.
// Nothing routes an input value through a store, a query or the network and back.
// One `setTimeout(…, 0)` in that path was enough on a physical iPhone to sever
// the iOS IME's composition state so that jamo stopped combining entirely
// (표준 produced `ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ` for 안녕하세요). The invite code and
// the server address are held to the same rule as the composer will be.
//
// ## What this screen does NOT do when it succeeds
//
// It does not navigate. `login()` and `joinWithInvite()` both end in
// `coreSession().applyLogin(...)`, the session store notifies, and the gate above
// swaps the tree. A screen that also pushed a route would be a second source of
// truth for "am I signed in", and the two would disagree the first time a token
// rotation failed.
// =============================================================================

interface Phase {
  busy: boolean;
  failure: ConnectFailure | null;
}

const IDLE: Phase = {busy: false, failure: null};

export default function ConnectScreen({
  sessionExpired = false,
}: {
  sessionExpired?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const prefill = useJoinPrefill();

  const [mode, setMode] = useState<ConnectMode>('signIn');
  // Synchronous local state. See the note above before changing any of these.
  // The address is seeded from the device's stored choice: someone who signed
  // out an hour ago should not have to retype the server they self-host.
  const [serverUrl, setServerUrl] = useState(() => getServerBase() ?? '');
  // Whether the value above is the PERSON's or the device's. An invite link may
  // overwrite a stored address but never something being typed, and the two are
  // indistinguishable by looking at the string.
  const [serverTyped, setServerTyped] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [phase, setPhase] = useState<Phase>(IDLE);
  const [online, setOnline] = useState(true);

  const fields = useRef<Partial<Record<ConnectField, TextInput | null>>>({});

  useEffect(() => {
    // The radio, not the server. Knowing there is no network turns a 15-second
    // deadline into an immediate, true sentence.
    const unsubscribe = NetInfo.addEventListener(state => {
      setOnline(isOnlineFromNetInfo(state));
    });
    return unsubscribe;
  }, []);

  // A link fills the form once, and only where the person has not already typed
  // their own value — a link arriving mid-edit must not overwrite what they are
  // in the middle of writing.
  const [prefillApplied, setPrefillApplied] = useState(false);
  useEffect(() => {
    if (!prefill || prefillApplied) return;
    setPrefillApplied(true);
    // The link wins over a SEEDED address, and loses to a typed one. Keeping a
    // stored server here is how an invite to workspace B gets redeemed against
    // workspace A and comes back as "유효하지 않은 초대 코드입니다" — copy that
    // blames the code for a server mismatch the person cannot see.
    const nextServer =
      prefill.serverUrl !== '' && !serverTyped ? prefill.serverUrl : serverUrl;
    if (nextServer !== serverUrl) setServerUrl(nextServer);
    if (prefill.inviteCode !== '') {
      setInviteCode(prefill.inviteCode);
      // An invite link is an instruction about which form this is.
      setMode('join');
    }
    setPhase(IDLE);
    // Where the cursor goes is the core's decision, not this screen's: land on
    // the first thing still missing rather than at the top of a half-filled form.
    const target = prefillFocus({
      serverUrl: nextServer,
      email,
      password,
      requiresServer: requiresServerUrl(),
    });
    fields.current[target]?.focus();
  }, [prefill, prefillApplied, serverTyped, serverUrl, email, password]);

  // Derived during render from the core, never stored. There is no second copy
  // of this answer to fall out of step with the field.
  const check = serverUrl.trim() === '' ? null : normalizeServerUrl(serverUrl);
  const joining = mode === 'join';

  const canSubmit =
    check?.ok === true &&
    email.trim() !== '' &&
    password !== '' &&
    (!joining || inviteCode.trim() !== '') &&
    !phase.busy &&
    online;

  const onSubmit = useCallback(async () => {
    const checked = normalizeServerUrl(serverUrl);
    if (!checked.ok) {
      // The core wrote this sentence; it is shown rather than paraphrased.
      setPhase({busy: false, failure: {message: checked.message, suggestSignIn: false, retryable: false}});
      fields.current.server?.focus();
      return;
    }
    setPhase({busy: true, failure: null});
    // Stored BEFORE the request: the core reads the base through the host port
    // when it builds the URL — `login()` has no server argument, by design.
    setServerBase(checked.base);
    try {
      if (joining) {
        await joinWithInvite(inviteCode.trim(), email.trim(), password);
      } else {
        await login(email.trim(), password);
      }
      // Success is not handled here on purpose — see the header note. The
      // session store has already notified and this tree is on its way out, so
      // the busy state is simply left standing rather than cleared into a screen
      // that is about to unmount.
    } catch (error) {
      const failure = joining ? joinFailureCopy(error) : signInFailureCopy(error);
      setPhase({busy: false, failure});
      // "이미 이 초대로 가입한 계정입니다. 로그인하세요." is an instruction, so
      // the form follows it instead of leaving the person to find the toggle.
      if (failure.suggestSignIn) setMode('signIn');
    }
  }, [email, inviteCode, joining, password, serverUrl]);

  const toggleMode = useCallback(() => {
    setMode(current => (current === 'join' ? 'signIn' : 'join'));
    setPhase(IDLE);
  }, []);

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag">
          <Text style={styles.title}>
            {joining ? '워크스페이스에 참여' : 'oort에 연결'}
          </Text>
          <Text style={styles.subtitle}>
            {joining
              ? '초대 코드로 워크스페이스에 참여합니다.'
              : 'oort는 셀프호스팅입니다. 연결할 서버 주소를 입력하세요.'}
          </Text>

          {sessionExpired ? (
            <NoticeBlock headline={SESSION_EXPIRED_NOTICE} testID="session-expired" />
          ) : null}

          {!online ? (
            <NoticeBlock
              headline="오프라인입니다."
              detail="네트워크가 연결되면 다시 시도하세요."
              testID="connect-offline"
            />
          ) : null}

          <Field label="서버 주소" hint="워크스페이스에 초대받은 주소">
            <TextInput
              ref={node => {
                fields.current.server = node;
              }}
              style={styles.input}
              value={serverUrl}
              onChangeText={next => {
                setServerTyped(true);
                setServerUrl(next);
              }}
              placeholder={SERVER_URL_PLACEHOLDER}
              placeholderTextColor={palette.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel="서버 주소"
              returnKeyType="next"
              // The keyboard's 다음 key moves to the next field, as it does in
              // every other iOS form. Without this it dismisses the keyboard and
              // the person has to reach back up and tap.
              onSubmitEditing={() =>
                (joining ? fields.current.code : fields.current.email)?.focus()
              }
              testID="server-url-input"
            />
          </Field>

          {/* The core's answer, rendered verbatim. */}
          {check !== null ? (
            <Text
              style={check.ok ? styles.hintOk : styles.hintBad}
              testID="server-url-hint">
              {check.ok ? `요청 주소: ${check.base}/v1/…` : check.message}
            </Text>
          ) : null}

          {joining ? (
            <Field label="초대 코드">
              <TextInput
                ref={node => {
                  fields.current.code = node;
                }}
                style={styles.input}
                value={inviteCode}
                onChangeText={setInviteCode}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                accessibilityLabel="초대 코드"
                returnKeyType="next"
                onSubmitEditing={() => fields.current.email?.focus()}
                testID="invite-code-input"
              />
            </Field>
          ) : null}

          <Field label="이메일">
            <TextInput
              ref={node => {
                fields.current.email = node;
              }}
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              accessibilityLabel="이메일"
              returnKeyType="next"
              onSubmitEditing={() => fields.current.password?.focus()}
              testID="email-input"
            />
          </Field>

          <Field
            label="비밀번호"
            hint={
              joining
                ? '이 워크스페이스에서 쓸 비밀번호를 새로 정합니다'
                : undefined
            }>
            <TextInput
              ref={node => {
                fields.current.password = node;
              }}
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel="비밀번호"
              returnKeyType="go"
              onSubmitEditing={() => {
                if (canSubmit) void onSubmit();
              }}
              testID="password-input"
            />
          </Field>

          <PrimaryButton
            label={joining ? '초대 코드로 참여' : '로그인'}
            busyLabel={joining ? '참여 중' : '로그인 중'}
            busy={phase.busy}
            disabled={!canSubmit}
            onPress={() => void onSubmit()}
            testID="submit-button"
          />

          {phase.failure ? (
            <FailureBanner
              message={phase.failure.message}
              // A retry is offered only where pressing again with the same input
              // could work — nothing answered, or the server faulted. A wrong
              // password or a spent invite needs the input to change first, and
              // a retry button there is an invitation to press it forever.
              onRetry={
                phase.failure.retryable && canSubmit
                  ? () => void onSubmit()
                  : undefined
              }
              testID="failure"
            />
          ) : null}

          <Pressable
            accessibilityRole="button"
            onPress={toggleMode}
            style={({pressed}) => [styles.toggle, pressed && styles.togglePressed]}
            testID="mode-toggle">
            <Text style={styles.toggleLabel}>
              {joining ? '로그인으로 전환' : '초대 코드로 참여'}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  flex: {flex: 1},
  content: {
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.xl,
    paddingBottom: space.xl * 2,
    gap: space.lg,
  },
  title: {fontSize: font.title, fontWeight: '600', color: color.text},
  subtitle: {fontSize: font.label, color: color.textMuted, lineHeight: 20},
  field: {gap: space.xs + 2},
  label: {fontSize: font.label, color: color.textMuted},
  fieldHint: {fontSize: font.meta, color: color.textFaint},
  input: {
    minHeight: TOUCH_TARGET,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    // 16 or larger, so iOS does not zoom the page when the field takes focus.
    fontSize: font.body,
    color: color.text,
    backgroundColor: color.surface,
  },
  hintOk: {fontSize: font.meta, color: color.accentText},
  hintBad: {fontSize: font.meta, color: color.danger},
  toggle: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.md,
  },
  togglePressed: {backgroundColor: color.surfacePressed},
  toggleLabel: {color: color.accentText, fontSize: font.label, fontWeight: '600'},
});
