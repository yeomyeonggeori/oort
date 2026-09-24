import {
  activateDeviceLinkSession,
  joinWithInvite,
  login,
  probeDeviceLinkAccess,
  redeemDeviceLink,
  type LoginResponse,
} from '@momo/core/lib/api';
import {
  joinFailureCopy,
  prefillFocus,
  signInFailureCopy,
  type ConnectFailure,
  type ConnectField,
  type ConnectMode,
} from '@momo/core/features/auth/connectModel';
import {
  DEVICE_LINK_ADDRESS_FALLBACK_LABEL,
  DEVICE_LINK_EXPIRED_COPY,
  DEVICE_LINK_PERMISSION_COPY,
  DEVICE_LINK_POLL_MS,
  DEVICE_LINK_QR_LABEL,
  DEVICE_LINK_RETRY_LABEL,
  DEVICE_LINK_SAS_WAIT_COPY,
  DEVICE_LINK_SETTINGS_LABEL,
  DEVICE_LINK_TTL_MS,
  DEVICE_LINK_UNREACHABLE_COPY,
  DeviceLinkFormatError,
  deviceLinkFailureCopy,
  deviceLinkSasDigits,
} from '@momo/core/features/auth/deviceLinkModel';
import type {DeviceLinkPrefill} from '@momo/core/features/auth/deepLink';
import {useCameraPermissions} from 'expo-camera';
import NetInfo from '@react-native-community/netinfo';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import {
  FailureBanner,
  NoticeBlock,
  OutlineButton,
  PrimaryButton,
  Screen,
  Sentence,
} from '../design/atoms';
import {font, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../design/tokens';
import {usePalette, useStyles} from '../design/theme';
import {
  arrivalFromDeviceLinkUrl,
  useDeviceLinkArrival,
} from '../deeplink/deviceLink';
import {useJoinPrefill} from '../deeplink/joinLink';
import {deviceLinkDevice} from '../features/deviceLink/deviceIdentity';
import {focusTextInput} from '../features/deviceLink/focusTextInput';
import {QrScannerSheet} from '../features/deviceLink/QrScannerSheet';
import {formRevealOffset, type RevealSpan} from '../lib/formReveal';
import {useReduceMotionRef} from '../lib/useReduceMotion';
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
// The one screen a signed-out person sees. Three jobs behind one form: signing
// in, redeeming an invite (`oort://join?server=…&code=…`), and consuming a
// device-link voucher (`oort://link?server=…&token=…`, ADR-0180 D7).
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
// ## With the keyboard up, the focused field and the button stay above it (#2678)
//
// Measured on an iPhone 13 mini (375×812, Release): with the address typed and
// the email field focused, the password field sat 26pt under the keyboard's top
// edge (468) and the 로그인 button 87pt under it. A Maestro `tapOn:
// password-input` landed on the keyboard, and the repo's login flow typed the
// password into the EMAIL field. At AX sizes a tap on the next field hit the
// keyboard outright (AX1: the email field 35pt under), and at AX5 the focused
// address field itself was 2pt under — the D6 class (ADR-0112): a control the
// keyboard reaches while the eye cannot.
//
// The viewport was right. `KeyboardAvoidingView` sized it exactly: the list's
// bottom edge stood on the keyboard's top edge (468 = 468). Its known trap —
// measuring its own frame in PARENT coordinates, see `ConversationLayout` — does
// not apply here, because this screen is the root of the tree (`App → Gate →
// ConnectScreen`) and `Screen` starts at the window's top, so parent coordinates
// ARE window coordinates. What was missing is the scroll: nothing moved the
// focused field into the viewport the keyboard left, and UIKit's own
// scroll-to-caret stops at the caret line (the password field was still 3pt
// under after it).
//
// So the form scrolls itself (`formReveal`): the focused field always, whole;
// the primary button too whenever field and button fit together, moving as
// little as possible. Everything is in content coordinates the list reports
// about itself — row `onLayout`, the list's own height, its offset — so there is
// no keyboard frame to reconcile. It runs when a field takes focus and whenever
// the list's height changes (the keyboard arriving, or changing type: the URL
// keyboard is 317pt, the email/password keyboard 344pt with its 암호 bar).
//
// **Why not the conversation's `KeyboardPane`.** The pane only translates: it
// lifts everything by the keyboard's height, and that is right where the content
// is bottom-anchored (the newest message on the composer). Here it would carry
// the TOP of the form under the clip — the address field (y 217) would go
// 344pt up, out of sight, at the very moment it is focused. A form needs the
// viewport to shrink and the focused row scrolled in; the pane has no such
// mode, and giving it one is native work. **Why not
// `automaticallyAdjustKeyboardInsets`:** it scrolls the caret line (+15pt) into
// view, not the button, and a second thing scrolling the same list is the
// fight #2604 spent a round untangling.
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
  const deviceLinkArrival = useDeviceLinkArrival();

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
  const [scannerOpen, setScannerOpen] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [linkFailure, setLinkFailure] = useState<ConnectFailure | null>(null);
  const [sasWait, setSasWait] = useState<{
    session: LoginResponse;
    sas: string;
    startedAt: number;
    expired: boolean;
    unreachable: boolean;
  } | null>(null);
  const consumedLink = useRef<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const fields = useRef<Partial<Record<ConnectField, TextInput | null>>>({});

  // ---- the keyboard's room (#2678, header) --------------------------------
  // Refs, not state: these change on every scroll frame and every keyboard
  // travel, and nothing on screen is drawn from them.
  const scrollRef = useRef<ScrollView>(null);
  const reduceMotionRef = useReduceMotionRef();
  const room = useRef<{
    /** The list's own height — the viewport the keyboard left. */
    viewport: number;
    offset: number;
    /** Each field's row and the primary button, in content coordinates. */
    rows: Partial<Record<ConnectField | 'action', RevealSpan>>;
  }>({viewport: 0, offset: 0, rows: {}});
  const focusedRef = useRef<ConnectField | null>(null);

  const reveal = useCallback(() => {
    const focused = focusedRef.current;
    if (focused === null) return;
    const {viewport, offset, rows} = room.current;
    const target = formRevealOffset({
      viewport,
      offset,
      field: rows[focused],
      action: rows.action,
      // The form's own row gap: the revealed block sits one row away from the
      // keyboard and from the top edge.
      margin: space.lg,
    });
    if (target === null) return;
    scrollRef.current?.scrollTo({y: target, animated: !reduceMotionRef.current});
  }, [reduceMotionRef]);

  /** Row `onLayout`s, one stable function per row. A row that moves re-reveals. */
  const rowLayout = useMemo(() => {
    const note = (key: ConnectField | 'action') => (event: LayoutChangeEvent) => {
      const {y, height} = event.nativeEvent.layout;
      room.current.rows[key] = {top: y, bottom: y + height};
      reveal();
    };
    return {
      server: note('server'),
      code: note('code'),
      email: note('email'),
      password: note('password'),
      action: note('action'),
    };
  }, [reveal]);

  const onFormLayout = useCallback(
    (event: LayoutChangeEvent) => {
      room.current.viewport = event.nativeEvent.layout.height;
      reveal();
    },
    [reveal],
  );

  const onFormScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      room.current.offset = event.nativeEvent.contentOffset.y;
    },
    [],
  );

  const focused = useCallback(
    (field: ConnectField) => {
      focusedRef.current = field;
      reveal();
    },
    [reveal],
  );

  const blurred = useCallback((field: ConnectField) => {
    if (focusedRef.current === field) focusedRef.current = null;
  }, []);

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
    focusTextInput(fields.current[target]);
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
      focusTextInput(fields.current.server);
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
    // The invite code row goes away with the join form and reports nothing as it
    // leaves; a stale row here would be revealed where nothing is.
    delete room.current.rows.code;
    if (focusedRef.current === 'code') focusedRef.current = null;
  }, []);

  const leaveSasToForm = useCallback(() => {
    consumedLink.current = null;
    setLinkFailure(null);
    setSasWait(null);
    setScannerOpen(false);
  }, []);

  const openScanner = useCallback(async () => {
    setLinkFailure(null);
    const current =
      cameraPermission?.granted === true
        ? cameraPermission
        : await requestCameraPermission();
    if (current.granted) {
      setPermissionDenied(false);
      setScannerOpen(true);
      return;
    }
    setScannerOpen(false);
    setPermissionDenied(true);
  }, [cameraPermission, requestCameraPermission]);

  const retryQr = useCallback(() => {
    leaveSasToForm();
    void openScanner();
  }, [leaveSasToForm, openScanner]);

  const redeemPrefill = useCallback(
    async (link: DeviceLinkPrefill) => {
      setScannerOpen(false);
      setLinkFailure(null);
      setPermissionDenied(false);
      const previousBase = getServerBase();
      const previousField = serverUrl;
      setServerBase(link.serverUrl);
      try {
        const result = await redeemDeviceLink(link.token, deviceLinkDevice());
        setServerUrl(link.serverUrl);
        if (!result.pendingSas) return;
        setSasWait({
          session: result.session,
          sas: result.sas ?? deviceLinkSasDigits(link.token),
          startedAt: Date.now(),
          expired: false,
          unreachable: false,
        });
      } catch (error) {
        setServerBase(previousBase);
        setServerUrl(previousField);
        setLinkFailure(deviceLinkFailureCopy(error));
      }
    },
    [serverUrl],
  );

  const applyArrival = useCallback(
    (arrival: {kind: 'prefill'; prefill: DeviceLinkPrefill} | {kind: 'malformed'}) => {
      if (arrival.kind === 'malformed') {
        setScannerOpen(false);
        setSasWait(null);
        setLinkFailure(deviceLinkFailureCopy(new DeviceLinkFormatError()));
        return;
      }
      const key = `${arrival.prefill.serverUrl}\0${arrival.prefill.token}`;
      if (consumedLink.current === key) return;
      consumedLink.current = key;
      void redeemPrefill(arrival.prefill);
    },
    [redeemPrefill],
  );

  useEffect(() => {
    if (!deviceLinkArrival) return;
    applyArrival(deviceLinkArrival);
  }, [deviceLinkArrival, applyArrival]);

  const onScan = useCallback(
    (data: string) => {
      const arrival = arrivalFromDeviceLinkUrl(data);
      if (!arrival) {
        applyArrival({kind: 'malformed'});
        return;
      }
      applyArrival(arrival);
    },
    [applyArrival],
  );

  const wasOnline = useRef(online);
  useEffect(() => {
    const becameOnline = online && !wasOnline.current;
    wasOnline.current = online;
    if (becameOnline) {
      setSasWait(current =>
        current && current.unreachable ? {...current, unreachable: false} : current,
      );
    }
  }, [online]);

  // Poll identity is the hold's start, not the unreachable flag — flipping that
  // flag must not cancel the timer (R2-H3). NetInfo coming back is a dep so a
  // radio edge restarts a tick immediately.
  const sasPollKey = sasWait
    ? `${sasWait.startedAt}:${sasWait.session.accessToken}:${sasWait.expired}`
    : '';

  useEffect(() => {
    if (!sasWait || sasWait.expired || !online) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = DEVICE_LINK_POLL_MS;
    const startedAt = sasWait.startedAt;
    const session = sasWait.session;
    const tick = async () => {
      if (Date.now() >= startedAt + DEVICE_LINK_TTL_MS) {
        setSasWait(current =>
          current ? {...current, expired: true, unreachable: false} : current,
        );
        return;
      }
      const outcome = await probeDeviceLinkAccess(
        session.accessToken,
        session.member.workspaceId,
      );
      if (cancelled) return;
      if (Date.now() >= startedAt + DEVICE_LINK_TTL_MS) {
        setSasWait(current =>
          current ? {...current, expired: true, unreachable: false} : current,
        );
        return;
      }
      if (outcome === 'active') {
        setSasWait(current =>
          current && current.unreachable
            ? {...current, unreachable: false}
            : current,
        );
        activateDeviceLinkSession(session);
        return;
      }
      if (outcome === 'unreachable') {
        setSasWait(current =>
          current && !current.unreachable
            ? {...current, unreachable: true}
            : current,
        );
        const wait = delay;
        delay = Math.min(delay * 2, DEVICE_LINK_POLL_MS * 4);
        timer = setTimeout(() => {
          void tick();
        }, wait);
        return;
      }
      setSasWait(current =>
        current && current.unreachable ? {...current, unreachable: false} : current,
      );
      delay = DEVICE_LINK_POLL_MS;
      timer = setTimeout(() => {
        void tick();
      }, DEVICE_LINK_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // sasPollKey, not sasWait: unreachable updates must not tear the loop down.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see sasPollKey
  }, [sasPollKey, online]);

  if (sasWait) {
    const sasFailure = sasWait.expired
      ? DEVICE_LINK_EXPIRED_COPY
      : sasWait.unreachable
        ? DEVICE_LINK_UNREACHABLE_COPY
        : null;
    return (
      <Screen>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.sas}
          keyboardShouldPersistTaps="handled"
          testID="device-link-sas">
          <Sentence style={styles.title}>기기 연결</Sentence>
          <Text
            style={styles.sasDigits}
            accessibilityLabel={`확인 번호 ${sasWait.sas.split('').join(', ')}`}
            testID="device-link-sas-digits">
            {sasWait.sas}
          </Text>
          {!online ? (
            <NoticeBlock
              headline="오프라인입니다."
              detail="네트워크가 연결되면 다시 시도하세요."
              testID="connect-offline"
            />
          ) : null}
          {sasFailure ? (
            <FailureBanner
              message={sasFailure}
              retryLabel={DEVICE_LINK_RETRY_LABEL}
              onRetry={retryQr}
              testID="device-link-failure"
            />
          ) : (
            <Sentence style={styles.subtitle}>{DEVICE_LINK_SAS_WAIT_COPY}</Sentence>
          )}
          {sasFailure ? null : (
            <OutlineButton
              label={DEVICE_LINK_RETRY_LABEL}
              onPress={retryQr}
              testID="device-link-sas-rescan"
            />
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={DEVICE_LINK_ADDRESS_FALLBACK_LABEL}
            onPress={leaveSasToForm}
            style={({pressed}) => [styles.toggle, pressed && styles.togglePressed]}
            testID="device-link-address-fallback">
            <Text style={styles.toggleLabel}>{DEVICE_LINK_ADDRESS_FALLBACK_LABEL}</Text>
          </Pressable>
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      {scannerOpen ? (
        <QrScannerSheet onClose={() => setScannerOpen(false)} onScan={onScan} />
      ) : null}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onLayout={onFormLayout}
          onScroll={onFormScroll}
          scrollEventThrottle={16}
          testID="connect-form">
          <Sentence style={styles.title}>
            {joining ? '워크스페이스에 참여' : 'oort에 연결'}
          </Sentence>
          <Sentence style={styles.subtitle}>
            {joining
              ? '초대 코드로 워크스페이스에 참여합니다.'
              : 'QR을 찍거나 서버 주소를 입력하세요.'}
          </Sentence>

          <OutlineButton
            label={DEVICE_LINK_QR_LABEL}
            onPress={() => void openScanner()}
            testID="qr-connect-button"
          />

          {permissionDenied ? (
            <NoticeBlock
              headline={DEVICE_LINK_PERMISSION_COPY}
              testID="qr-permission-denied"
            />
          ) : null}
          {permissionDenied ? (
            <OutlineButton
              label={DEVICE_LINK_ADDRESS_FALLBACK_LABEL}
              onPress={() => {
                focusTextInput(fields.current.server);
              }}
              testID="qr-permission-fallback"
            />
          ) : null}
          {permissionDenied ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={DEVICE_LINK_SETTINGS_LABEL}
              onPress={() => void Linking.openSettings()}
              style={({pressed}) => [styles.toggle, pressed && styles.togglePressed]}
              testID="qr-permission-settings">
              <Text style={styles.toggleLabel}>{DEVICE_LINK_SETTINGS_LABEL}</Text>
            </Pressable>
          ) : null}

          {linkFailure ? (
            <FailureBanner
              message={linkFailure.message}
              retryLabel={DEVICE_LINK_RETRY_LABEL}
              onRetry={retryQr}
              testID="device-link-failure"
            />
          ) : null}

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

          <Field
            label="서버 주소"
            hint="워크스페이스에 초대받은 주소"
            onLayout={rowLayout.server}>
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
              onFocus={() => focused('server')}
              onBlur={() => blurred('server')}
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
            <Field label="초대 코드" onLayout={rowLayout.code}>
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
                onFocus={() => focused('code')}
                onBlur={() => blurred('code')}
                testID="invite-code-input"
              />
            </Field>
          ) : null}

          <Field label="이메일" onLayout={rowLayout.email}>
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
              onFocus={() => focused('email')}
              onBlur={() => blurred('email')}
              testID="email-input"
            />
          </Field>

          <Field
            label="비밀번호"
            hint={
              joining
                ? '이 워크스페이스에서 쓸 비밀번호를 새로 정합니다'
                : undefined
            }
            onLayout={rowLayout.password}>
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
              onFocus={() => focused('password')}
              onBlur={() => blurred('password')}
              testID="password-input"
            />
          </Field>

          {/* A plain wrapper, only to report where the button is (#2678). One
              child in the content's gap chain, as the button alone was. */}
          <View onLayout={rowLayout.action}>
            <PrimaryButton
              label={joining ? '초대 코드로 참여' : '로그인'}
              busyLabel={joining ? '참여 중' : '로그인 중'}
              busy={phase.busy}
              disabled={!canSubmit}
              onPress={() => void onSubmit()}
              testID="submit-button"
            />
          </View>

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
  onLayout,
  children,
}: {
  label: string;
  hint?: string;
  /** Where this row is, for the keyboard reveal (#2678). */
  onLayout?: (event: LayoutChangeEvent) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.field} onLayout={onLayout}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint ? <Sentence style={styles.fieldHint}>{hint}</Sentence> : null}
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
  sas: {
    flex: 1,
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.xl,
    gap: space.lg,
  },
  sasDigits: {
    fontSize: font.display,
    fontWeight: '600',
    color: color.text,
  },
});
