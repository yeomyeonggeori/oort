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
  DEVICE_LINK_EXPIRED_COPY,
  DEVICE_LINK_POLL_MS,
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
import {displayNameFromEmail} from '@momo/core/lib/api';
import NetInfo from '@react-native-community/netinfo';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Keyboard,
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
import {FailureBanner, NoticeBlock, Sentence} from '../design/atoms';
import {font, space, TOUCH_TARGET, type Palette} from '../design/tokens';
import {usePalette, useStyles, useTheme} from '../design/theme';
import {
  arrivalFromDeviceLinkUrl,
  useDeviceLinkArrival,
} from '../deeplink/deviceLink';
import {useJoinPrefill} from '../deeplink/joinLink';
import {deviceLinkDevice} from '../features/deviceLink/deviceIdentity';
import {focusTextInput} from '../features/deviceLink/focusTextInput';
import {QrScannerSheet} from '../features/deviceLink/QrScannerSheet';
import {KomettoGuide, OnboardingCanvas} from '../features/onboarding/KomettoGuide';
import {
  OnboardingButton,
  OnboardingGhostButton,
  OnboardingLink,
  OnboardingLinkRow,
  OnboardingPhoneScreen,
  OnboardingSpinner,
  OnboardingTopBar,
  PHONE_OB,
  QrGlyph,
} from '../features/onboarding/OnboardingControls';
import {
  ADDRESS_LOGIN_LABEL,
  CAMERA_DENIED_DETAIL,
  CAMERA_DENIED_LINE,
  LINK_FAILED_LINE,
  noteConnectRoute,
  OFFLINE_LINE,
  phoneOnboardingDots,
  SAS_CANCEL_LABEL,
  SAS_DETAIL,
  SAS_LINE,
  SAS_MISMATCH_LABEL,
  SIGN_IN_LINE,
  WELCOME_DETAIL,
  WELCOME_LINE,
  WELCOME_QR_LABEL,
  WELCOME_TAGLINE,
} from '../features/onboarding/phoneFlow';
import {formRevealOffset, type RevealSpan} from '../lib/formReveal';
import {useReduceMotionRef} from '../lib/useReduceMotion';
import {isOnlineFromNetInfo} from '../query/queryClient';
import {SESSION_EXPIRED_NOTICE} from '../session/authGate';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
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
// ## One flow, split into screens (#2819 OB2-13, ADR-0193 D7·D11, ADR-0185 §6)
//
// The form used to be one sheet: QR + address + code + email + password. It is
// now the same flow cut into the screens of the onboarding 2.0 mockup. Nothing
// new is asked, and every path below is one this file already had:
//
//   M0  welcome     QR is the lead. Small links under it: 초대 링크로 참여 ·
//                   주소로 로그인. A camera refusal turns Kometto flustered and
//                   points at the address path (M1 거부).
//   M1  scanner     `QrScannerSheet`, unchanged (camera is the lead, one read).
//   M2  SAS         Kometto thinking + the four digits; 취소 and 번호가 달라요 drop
//                   the voucher and return to M0. Poll, TTL 120s and the expiry
//                   banner are untouched.
//   M-b sign in     the old form in signIn mode (address + email + password).
//   M-a join        the old form in join mode, plus 「팀에서 보일 이름」. When an
//                   invite link filled the address AND the code, both show as one
//                   chip instead of two fields (desktop D1′ says the same).
//
// A `oort://join` link skips M0 (ADR-0193 D7). A device-link voucher skips it
// too (it lands on M2 or straight in the app). A session that expired opens on
// M-b: the stored address and the notice are what that person needs.
//
// M3 (알림 미리 안내, #2820) is not here: it stands after the session does, over
// the shell (`NotificationPrimer`). This file only tells it which route led
// there (`noteConnectRoute`), so its progress dots continue this row.
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
// no keyboard frame to reconcile. It runs when a field takes focus, when a row
// moves (the address hint appears on the first keystroke and pushes the rows
// below it down), when the list reports a new height, and once more when the
// keyboard has ARRIVED. The last two are both needed, and the device decided
// which covers what (the note at the `keyboardDidShow` listener).
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

/** The form's rows: the core's four fields and the invite screen's name. */
type FormRow = ConnectField | 'name';

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
  // M0 or the form (#2819). The SAS wait (M2) is drawn over both by `sasWait`.
  const [step, setStep] = useState<'welcome' | 'form'>(() =>
    sessionExpired ? 'form' : 'welcome',
  );
  // An invite link filled the address and the code: they show as one chip.
  const [linkFilled, setLinkFilled] = useState(false);
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
  const [displayName, setDisplayName] = useState('');
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

  const fields = useRef<Partial<Record<FormRow, TextInput | null>>>({});
  // A focus asked for before the form is on screen (a link arriving on M0, the
  // camera-refusal fallback). Taken by the effect below once the field exists.
  const pendingFocus = useRef<FormRow | null>(null);

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
    rows: Partial<Record<FormRow | 'action', RevealSpan>>;
  }>({viewport: 0, offset: 0, rows: {}});
  const focusedRef = useRef<FormRow | null>(null);
  // The same answer as state, for the focus ring only (시안 `.input.focus`).
  // Focus is a tap, not a keystroke: re-rendering here does not touch the IME.
  const [focusRow, setFocusRow] = useState<FormRow | null>(null);

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
    const note = (key: FormRow | 'action') => (event: LayoutChangeEvent) => {
      const {y, height} = event.nativeEvent.layout;
      room.current.rows[key] = {top: y, bottom: y + height};
      reveal();
    };
    return {
      server: note('server'),
      code: note('code'),
      email: note('email'),
      password: note('password'),
      name: note('name'),
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
    (field: FormRow) => {
      focusedRef.current = field;
      setFocusRow(field);
      reveal();
    },
    [reveal],
  );

  const blurred = useCallback((field: FormRow) => {
    if (focusedRef.current === field) focusedRef.current = null;
    setFocusRow(current => (current === field ? null : current));
  }, []);

  // Two moments the keyboard gives, and the device showed each one failing alone.
  //
  //   - **The list's new height** (`onFormLayout`) is the moment for a keyboard
  //     that changes IN PLACE — tapping from the address to the email field swaps
  //     the URL keyboard for the email one with no animation, and the probe saw
  //     `keyboardDidShow` arrive first and the new height (418) after it. Without
  //     this, the button stayed 10pt under.
  //   - **`keyboardDidShow`** is the moment for a keyboard that TRAVELS. The new
  //     height is final in JS as soon as it starts to move, but
  //     `KeyboardAvoidingView` animates the real frame along with it (383ms), and
  //     a `scrollTo` issued meanwhile is clamped by UIKit to the old, taller frame
  //     — a no-op whenever the form fits it (a returning person's stored address:
  //     the button stayed 60pt under). Moving to the password field makes it the
  //     common case: iOS lowers and raises the keyboard for a secure field, the
  //     reveal to 103.7 vanished into the clamp, and UIKit then scrolled only the
  //     caret in — the field's bottom on the keyboard's edge, the 로그인 button
  //     61pt under. `keyboardDidShow` comes once the frame is final and after
  //     UIKit has started that caret scroll, so this reveal is the one that stands.
  useEffect(() => {
    const arrived = Keyboard.addListener('keyboardDidShow', reveal);
    return () => arrived.remove();
  }, [reveal]);

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
      // The chip stands only for what the LINK decided. An address the person
      // typed over it stays a field they can see and fix.
      setLinkFilled(prefill.serverUrl !== '' && nextServer === prefill.serverUrl);
    }
    // A link skips M0 (ADR-0193 D7).
    setStep('form');
    setPhase(IDLE);
    // Where the cursor goes is the core's decision, not this screen's: land on
    // the first thing still missing rather than at the top of a half-filled form.
    const target = prefillFocus({
      serverUrl: nextServer,
      email,
      password,
      requiresServer: requiresServerUrl(),
    });
    pendingFocus.current = target;
  }, [prefill, prefillApplied, serverTyped, serverUrl, email, password]);

  useEffect(() => {
    if (step !== 'form' || pendingFocus.current === null) return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    focusTextInput(fields.current[target]);
  });

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
    // Which row of progress dots M3 continues (#2820). Said before the request:
    // success unmounts this screen from inside `applyLogin`.
    noteConnectRoute(joining ? 'join' : 'signIn');
    try {
      if (joining) {
        await joinWithInvite(
          inviteCode.trim(),
          email.trim(),
          password,
          displayName,
        );
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
  }, [displayName, email, inviteCode, joining, password, serverUrl]);

  // A failure is also SAID, once, when it arrives (#2678 R1) — the web banner is
  // `role="alert"`. On the phone that is `announceForAccessibility`, as in the
  // attachment tray and the approval card: `accessibilityLiveRegion` is
  // Android-only and would be a second reading there. Keyed on the failure
  // object, which `onSubmit` creates once per answer, so a re-render (the mode
  // following "로그인하세요") does not say it again.
  useEffect(() => {
    if (phase.failure) AccessibilityInfo.announceForAccessibility(phase.failure.message);
  }, [phase.failure]);

  /** Rows that leave with the join form report nothing as they go. */
  const forgetJoinRows = useCallback(() => {
    // A stale row here would be revealed where nothing is.
    delete room.current.rows.code;
    delete room.current.rows.name;
    if (focusedRef.current === 'code' || focusedRef.current === 'name') {
      focusedRef.current = null;
    }
  }, []);

  /** M-a → M-b (「이미 이 서버 계정이 있나요? 로그인」). */
  const toggleMode = useCallback(() => {
    setMode(current => (current === 'join' ? 'signIn' : 'join'));
    setPhase(IDLE);
    forgetJoinRows();
  }, [forgetJoinRows]);

  /** M0 → M-b / M-a. */
  const openForm = useCallback(
    (next: ConnectMode, focus?: FormRow) => {
      setMode(next);
      setPhase(IDLE);
      setLinkFailure(null);
      if (next === 'signIn') forgetJoinRows();
      if (focus) pendingFocus.current = focus;
      setStep('form');
    },
    [forgetJoinRows],
  );

  /** The form → M0. What was typed stays: coming back should not cost it. */
  const backToWelcome = useCallback(() => {
    Keyboard.dismiss();
    setPhase(IDLE);
    setLinkFilled(false);
    focusedRef.current = null;
    setFocusRow(null);
    room.current = {viewport: 0, offset: 0, rows: {}};
    setStep('welcome');
  }, []);

  /** M2 → M0 (취소 · 번호가 달라요): the voucher is dropped, nothing is kept. */
  const leaveSas = useCallback(() => {
    consumedLink.current = null;
    setLinkFailure(null);
    setSasWait(null);
    setScannerOpen(false);
    setStep('welcome');
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
    leaveSas();
    void openScanner();
  }, [leaveSas, openScanner]);

  const redeemPrefill = useCallback(
    async (link: DeviceLinkPrefill) => {
      setScannerOpen(false);
      setLinkFailure(null);
      setPermissionDenied(false);
      noteConnectRoute('qr');
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

  const {scheme} = useTheme();
  const insets = useSafeAreaInsets();
  const scanner = scannerOpen ? (
    <QrScannerSheet onClose={() => setScannerOpen(false)} onScan={onScan} />
  ) : null;

  // ---- M2 확인 번호 -----------------------------------------------------------
  if (sasWait) {
    const sasFailure = sasWait.expired
      ? DEVICE_LINK_EXPIRED_COPY
      : sasWait.unreachable
        ? DEVICE_LINK_UNREACHABLE_COPY
        : null;
    const host = hostOf(serverUrl);
    return (
      <OnboardingPhoneScreen
        testID="device-link-sas"
        mainStyle={styles.mainWide}
        top={
          <OnboardingTopBar
            left={
              <OnboardingGhostButton
                label={SAS_CANCEL_LABEL}
                onPress={leaveSas}
                accessibilityHint="이 연결을 그만두고 첫 화면으로 돌아갑니다."
                testID="device-link-sas-cancel"
              />
            }
            dots={phoneOnboardingDots('qr', 'sas')}
          />
        }
        bottom={
          <>
            {sasFailure ? null : (
              <View style={styles.sys} testID="device-link-sas-wait">
                <OnboardingSpinner color={palette.textMuted} />
                <Sentence style={styles.sysText}>{DEVICE_LINK_SAS_WAIT_COPY}</Sentence>
              </View>
            )}
            <OnboardingButton
              kind="secondary"
              label={SAS_MISMATCH_LABEL}
              onPress={leaveSas}
              accessibilityHint="이 연결 코드를 버리고 첫 화면으로 돌아갑니다."
              testID="device-link-sas-mismatch"
            />
          </>
        }>
        {scanner}
        <KomettoGuide
          expression={sasFailure || !online ? 'flustered' : 'thinking'}
          line={SAS_LINE}
          detail={SAS_DETAIL}
          header
        />
        <View
          style={styles.sasRow}
          accessible
          accessibilityRole="text"
          accessibilityLabel={`확인 번호 ${sasWait.sas.split('').join(', ')}`}
          testID="device-link-sas-digits">
          {sasWait.sas.split('').map((digit, index) => (
            <View key={index} style={styles.sasTile}>
              <Text style={styles.sasDigit} maxFontSizeMultiplier={SAS_MAX_SCALE}>
                {digit}
              </Text>
            </View>
          ))}
        </View>
        {host ? (
          <View style={styles.chipRow}>
            <View style={styles.chip} testID="device-link-sas-server">
              <Text style={styles.chipText} numberOfLines={1}>
                {host}
              </Text>
            </View>
          </View>
        ) : null}
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
        ) : null}
      </OnboardingPhoneScreen>
    );
  }

  // ---- M0 환영 -----------------------------------------------------------------
  if (step === 'welcome') {
    const dark = scheme === 'dark';
    // 한 번에 한 상태. 거부 > 연결 실패 > 오프라인 > 기다림 (D11 표정-상태 1:1).
    const guide = permissionDenied
      ? {expression: 'flustered' as const, line: CAMERA_DENIED_LINE, detail: CAMERA_DENIED_DETAIL}
      : linkFailure
        ? {expression: 'flustered' as const, line: LINK_FAILED_LINE, detail: undefined}
        : !online
          ? {expression: 'flustered' as const, line: OFFLINE_LINE, detail: '네트워크가 연결되면 QR을 찍어요.'}
          : {expression: 'idle' as const, line: WELCOME_LINE, detail: WELCOME_DETAIL};
    const guideTestID = permissionDenied
      ? 'qr-permission-denied'
      : !linkFailure && !online
        ? 'connect-offline'
        : 'welcome-guide';
    return (
      <OnboardingPhoneScreen
        testID="connect-welcome"
        mainStyle={styles.welcomeMain}
        decoration={dark ? <Stars /> : null}
        bottom={
          <>
            {permissionDenied ? (
              <OnboardingButton
                label={ADDRESS_LOGIN_LABEL}
                onPress={() => openForm('signIn', 'server')}
                testID="qr-permission-fallback"
              />
            ) : (
              <OnboardingButton
                label={WELCOME_QR_LABEL}
                icon={<QrGlyph color={palette.onPrimary} />}
                onPress={() => void openScanner()}
                accessibilityHint="카메라로 데스크탑의 QR을 찍습니다."
                testID="qr-connect-button"
              />
            )}
            <OnboardingLinkRow>
              {permissionDenied ? (
                <OnboardingLink
                  label={DEVICE_LINK_SETTINGS_LABEL}
                  onPress={() => void Linking.openSettings()}
                  accessibilityHint="iOS 설정의 이 앱 화면을 엽니다."
                  testID="qr-permission-settings"
                />
              ) : null}
              <OnboardingLink
                label={INVITE_LINK_LABEL}
                onPress={() => openForm('join')}
                testID="welcome-invite"
              />
              {permissionDenied ? null : (
                <OnboardingLink
                  label={ADDRESS_LOGIN_LABEL}
                  onPress={() => openForm('signIn')}
                  testID="welcome-address"
                />
              )}
            </OnboardingLinkRow>
          </>
        }>
        {scanner}
        <View testID={guideTestID}>
          <KomettoGuide
            size="hero"
            expression={guide.expression}
            line={guide.line}
            detail={guide.detail}
            header
            faceSide={dark ? WELCOME_DARK_HERO : undefined}
            faceBadge={dark}
            style={styles.welcomeGuide}
            bubbleStyle={styles.welcomeBubble}
            between={
              <>
                <Text
                  style={[styles.wordmark, dark && styles.wordmarkAfterBadge]}
                  accessibilityRole="header">
                  oort
                </Text>
                <Sentence style={styles.tagline}>{WELCOME_TAGLINE}</Sentence>
              </>
            }
          />
        </View>
        {linkFailure ? (
          <FailureBanner
            message={linkFailure.message}
            retryLabel={DEVICE_LINK_RETRY_LABEL}
            onRetry={retryQr}
            testID="device-link-failure"
          />
        ) : null}
      </OnboardingPhoneScreen>
    );
  }

  // ---- M-b 로그인 · M-a 초대 ----------------------------------------------------
  const route = joining ? 'join' : 'signIn';
  const derivedName = email.trim() === '' ? '' : displayNameFromEmail(email.trim().toLowerCase());
  return (
    <OnboardingCanvas>
      {scanner}
      <View style={[styles.flex, {paddingTop: insets.top}]}>
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
            <OnboardingTopBar
              left={
                <OnboardingGhostButton
                  label="뒤로"
                  onPress={backToWelcome}
                  accessibilityHint="QR 연결이 있는 첫 화면으로 돌아갑니다."
                  testID="connect-back"
                />
              }
              dots={phoneOnboardingDots(route, joining ? 'join' : 'sign-in')}
            />

            <KomettoGuide
              expression={
                phase.failure || !online ? 'flustered' : joining ? 'happy' : 'idle'
              }
              line={joining ? JOIN_LINE : SIGN_IN_LINE}
              detail={joining && linkFilled ? JOIN_DETAIL : undefined}
              header
            />

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

            {joining && linkFilled ? (
              <View style={styles.chipStart}>
                <View style={styles.chip} testID="invite-link-chip">
                  <Text style={styles.chipText} numberOfLines={1}>
                    {hostOf(serverUrl) ?? serverUrl}
                  </Text>
                </View>
              </View>
            ) : (
              <Field
                label="서버 주소"
                hint="워크스페이스에 초대받은 주소"
                onLayout={rowLayout.server}>
                <TextInput
                  ref={node => {
                    fields.current.server = node;
                  }}
                  style={[styles.input, focusRow === 'server' && styles.inputFocus]}
                  value={serverUrl}
                  onChangeText={next => {
                    setServerTyped(true);
                    setServerUrl(next);
                  }}
                  placeholder={SERVER_URL_PLACEHOLDER}
                  placeholderTextColor={palette.textMuted}
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
            )}

            {/* The core's answer, rendered verbatim. */}
            {check !== null && !(joining && linkFilled) ? (
              <Text
                style={check.ok ? styles.hintOk : styles.hintBad}
                testID="server-url-hint">
                {check.ok ? `요청 주소: ${check.base}/v1/…` : check.message}
              </Text>
            ) : null}

            {joining && !linkFilled ? (
              <Field label={INVITE_CODE_LABEL} onLayout={rowLayout.code}>
                <TextInput
                  ref={node => {
                    fields.current.code = node;
                  }}
                  style={[styles.input, focusRow === 'code' && styles.inputFocus]}
                  value={inviteCode}
                  onChangeText={setInviteCode}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  accessibilityLabel={INVITE_CODE_LABEL}
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
                style={[styles.input, focusRow === 'email' && styles.inputFocus]}
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
                  ? '이 워크스페이스에서 쓸 비밀번호를 새로 정합니다.'
                  : undefined
              }
              onLayout={rowLayout.password}>
              <TextInput
                ref={node => {
                  fields.current.password = node;
                }}
                style={[styles.input, focusRow === 'password' && styles.inputFocus]}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                accessibilityLabel="비밀번호"
                returnKeyType={joining ? 'next' : 'go'}
                onSubmitEditing={() => {
                  if (joining) {
                    fields.current.name?.focus();
                    return;
                  }
                  if (canSubmit) void onSubmit();
                }}
                onFocus={() => focused('password')}
                onBlur={() => blurred('password')}
                testID="password-input"
              />
            </Field>

            {joining ? (
              <Field
                label="팀에서 보일 이름"
                hint="비워 두면 이메일 앞부분을 이름으로 씁니다."
                onLayout={rowLayout.name}>
                <TextInput
                  ref={node => {
                    fields.current.name = node;
                  }}
                  style={[styles.input, focusRow === 'name' && styles.inputFocus]}
                  value={displayName}
                  onChangeText={setDisplayName}
                  placeholder={derivedName}
                  placeholderTextColor={palette.textMuted}
                  autoCorrect={false}
                  textContentType="name"
                  accessibilityLabel="팀에서 보일 이름"
                  returnKeyType="go"
                  onSubmitEditing={() => {
                    if (canSubmit) void onSubmit();
                  }}
                  onFocus={() => focused('name')}
                  onBlur={() => blurred('name')}
                  testID="display-name-input"
                />
              </Field>
            ) : null}

            {/* ABOVE the button, as on the web (`ConnectPage` puts the failure over
                its submit), and that is the #2678 R1 fix, not taste. The button
                is pressed with the keyboard up, and the row after it is the
                keyboard's top edge: rendered below, this sentence arrived behind
                the keyboard (iPhone 13 mini: banner 468–514, keyboard 468). Here it
                sits between the focused field and the button — inside the block
                the reveal keeps above the keyboard — and its arrival pushes the
                button's row down, which is itself a reveal trigger. A direct child
                of the content, like every row: the button's `onLayout` reports
                content coordinates only because its parent is the content. */}
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

            {/* A plain wrapper, only to report where the button is (#2678). One
                child in the content's gap chain, as the button alone was. */}
            <View onLayout={rowLayout.action}>
              <OnboardingButton
                label={joining ? JOIN_SUBMIT_LABEL : '로그인'}
                busyLabel={joining ? '참여 중' : '로그인 중'}
                busy={phase.busy}
                disabled={!canSubmit}
                onPress={() => void onSubmit()}
                testID="submit-button"
              />
            </View>

            {joining ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="이미 이 서버 계정이 있나요? 로그인"
                onPress={toggleMode}
                style={({pressed}) => [styles.reentry, pressed && styles.reentryPressed]}
                testID="mode-toggle">
                <Text style={styles.reentryText}>
                  이미 이 서버 계정이 있나요? <Text style={styles.reentryLink}>로그인</Text>
                </Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </OnboardingCanvas>
  );
}

// ---- 이 화면의 문장 (「초대」는 이 파일에만 산다, #1584) ------------------------
const INVITE_LINK_LABEL = '초대 링크로 참여';
const INVITE_CODE_LABEL = '초대 코드';
const JOIN_LINE = '초대받은 팀에 들어가요.';
const JOIN_DETAIL = '세 칸만 채우면 바로 들어가요.';
const JOIN_SUBMIT_LABEL = '팀에 들어가기';

/** 다크 M0 히어로(시안 `.phone.T.dark .hero-k{width:176px;margin-bottom:10px}`). */
const WELCOME_DARK_HERO = 176;
/** SAS 숫자는 이미 크다(40). 큰 글씨에서 네 칸이 375 폭을 넘지 않게 멈춘다. */
const SAS_MAX_SCALE = 1.35;

/** 시안 M0·M2 값. */
const WELCOME = {
  /** `.wordmark{font-size:36px;font-weight:800;letter-spacing:-.045em;line-height:1}` */
  wordmark: 36,
  wordmarkTracking: -1.62,
  /** 다크 `margin-bottom:10px` (배지 아래) */
  badgeGap: 10,
  /** `.tagline{font-size:15px}` */
  tagline: 15,
  /** `.bubble{margin-top:10px}` (M0 인라인) */
  bubbleTop: 10,
} as const;
const SAS = {
  /** `.sas{gap:10px}` · `.sas i{width:62px;height:78px;border-radius:14px;font:600 40px/1 mono}` */
  tileGap: 10,
  width: 62,
  height: 78,
  radius: 14,
  digit: 40,
  /** `.chip{height:28px;padding:0 10px;font-size:13px;gap:6px}` */
  chip: 28,
  chipPadH: 10,
  chipFont: 13,
} as const;

/** 주소의 호스트(칩). 읽을 수 없으면 null. */
function hostOf(url: string): string | null {
  const checked = url.trim() === '' ? null : normalizeServerUrl(url);
  if (!checked || !checked.ok) return null;
  try {
    return new URL(checked.base).host;
  } catch {
    return null;
  }
}

/** 다크 M0의 옅은 별(시안 `.stars`). 장식이다. */
const STAR_POINTS: ReadonlyArray<{x: string; y: string; size: number; tint: string}> = [
  {x: '12%', y: '18%', size: 1, tint: 'rgba(255,255,255,0.55)'},
  {x: '72%', y: '12%', size: 1, tint: 'rgba(255,255,255,0.45)'},
  {x: '86%', y: '34%', size: 1.5, tint: 'rgba(255,220,190,0.6)'},
  {x: '28%', y: '44%', size: 1, tint: 'rgba(255,255,255,0.35)'},
  {x: '55%', y: '26%', size: 1, tint: 'rgba(255,255,255,0.4)'},
  {x: '8%', y: '70%', size: 1, tint: 'rgba(255,255,255,0.3)'},
  {x: '92%', y: '76%', size: 1.5, tint: 'rgba(255,255,255,0.35)'},
];

const starStyles = StyleSheet.create({star: {position: 'absolute'}});

function Stars(): React.JSX.Element {
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
      testID="welcome-stars">
      {STAR_POINTS.map((star, index) => (
        <View
          key={index}
          style={[
            starStyles.star,
            {
              left: star.x as `${number}%`,
              top: star.y as `${number}%`,
              width: star.size,
              height: star.size,
              borderRadius: star.size / 2,
              backgroundColor: star.tint,
            },
          ]}
        />
      ))}
    </View>
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
    paddingHorizontal: PHONE_OB.gutter,
    paddingBottom: space.xl * 2,
    gap: PHONE_OB.formGap,
  },
  // `.field{gap:6px}` · `label{13px/600 ink2}` · `.hint{12.5px ink2}` (D1′ 시안)
  field: {gap: PHONE_OB.fieldGap},
  label: {fontSize: PHONE_OB.labelFont, fontWeight: '600', color: color.textMuted},
  fieldHint: {fontSize: PHONE_OB.hintFont, color: color.textMuted},
  input: {
    minHeight: PHONE_OB.input,
    borderWidth: 1,
    // `.input{border:1px solid var(--lineStrong)}` — 입력 그릇의 테두리는 컨트롤이라 3:1.
    borderColor: color.textFaint,
    borderRadius: PHONE_OB.inputRadius,
    paddingHorizontal: PHONE_OB.inputPadH,
    paddingVertical: space.sm,
    fontSize: font.body,
    color: color.text,
    // 입력 그릇만 surface(D11).
    backgroundColor: color.surface,
  },
  // 신호색은 진행 점과 포커스뿐(D11): 확인된 주소의 메아리는 흐린 잉크다.
  // `.input.focus{box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--signal)}`
  inputFocus: {boxShadow: `0 0 0 2px ${color.surface}, 0 0 0 4px ${color.accent}`},
  hintOk: {fontSize: font.meta, color: color.textMuted},
  hintBad: {fontSize: font.meta, color: color.danger},
  reentry: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    alignItems: 'center',
  },
  reentryPressed: {opacity: 0.6},
  // `.reentry{font-size:12.5px;color:ink2;text-align:center}` · `.link{signal-text 600 underline}`
  reentryText: {fontSize: PHONE_OB.hintFont, color: color.textMuted, textAlign: 'center'},
  reentryLink: {
    color: color.accentText,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  welcomeMain: {alignItems: 'stretch', gap: PHONE_OB.heroGap},
  welcomeGuide: {alignSelf: 'stretch'},
  // 시안 `.p-main{align-items:center}`: 말풍선은 글자만큼이다.
  welcomeBubble: {marginTop: WELCOME.bubbleTop, alignSelf: 'center'},
  wordmark: {
    fontSize: WELCOME.wordmark,
    fontWeight: '800',
    letterSpacing: WELCOME.wordmarkTracking,
    color: color.text,
    textAlign: 'center',
  },
  wordmarkAfterBadge: {marginTop: WELCOME.badgeGap},
  tagline: {fontSize: WELCOME.tagline, color: color.textMuted, textAlign: 'center'},
  mainWide: {gap: PHONE_OB.mainGapWide},
  sasRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: SAS.tileGap,
  },
  sasTile: {
    minWidth: SAS.width,
    minHeight: SAS.height,
    borderRadius: SAS.radius,
    backgroundColor: color.surface,
    boxShadow: color.elevationRest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sasDigit: {
    fontSize: SAS.digit,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: color.text,
  },
  chipRow: {flexDirection: 'row', justifyContent: 'center'},
  chipStart: {flexDirection: 'row'},
  chip: {
    minHeight: SAS.chip,
    paddingHorizontal: SAS.chipPadH,
    borderRadius: SAS.chip / 2,
    backgroundColor: color.surfaceMuted,
    justifyContent: 'center',
    maxWidth: '100%',
  },
  chipText: {fontSize: SAS.chipFont, color: color.text, fontWeight: '600'},
  sys: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  sysText: {fontSize: PHONE_OB.sysFont, color: color.textMuted, flexShrink: 1},
});
