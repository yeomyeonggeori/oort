import {ApiError, login, type LoginResponse} from '@momo/core/lib/api';
import {NetworkError} from '@momo/core/lib/http';
import {normalizeServerUrl, SERVER_URL_PLACEHOLDER} from '@momo/core/lib/serverUrl';
import React, {useCallback, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {useJoinPrefill} from '../deeplink/joinLink';
import {setServerBase} from '../storage/serverBase';

// =============================================================================
// The connect screen — and this batch's proof that the app is ATTACHED to the
// core, not merely booting beside it.
//
// Four core entry points are exercised here, each doing real work:
//
//   normalizeServerUrl   on every keystroke, and its answer is what the screen
//                        renders. The line under the field is not a re-derived
//                        opinion; it is the core's `base` string.
//   login                the REST round trip, through the core's own transport
//                        (`fetchWithDeadline`), its wire decoder, and its
//                        `SessionPort` — so a successful sign-in here also
//                        writes the refresh token to the keychain.
//   ApiError             "the server answered and said no" (401, 400).
//   NetworkError         "nothing answered" (deadline blown, unreachable).
//
// The last two are shown as DIFFERENT things on purpose. The core's http.ts is
// explicit that they must never be conflated: a wrong password and an
// unreachable server call for different actions from the person, and a client
// that renders both as "로그인 실패" makes the second one unsolvable.
//
// UI completeness is not this batch's job (이행 순서 4 brings the v0 surfaces).
// What this screen owes is evidence that the wiring carries.
//
// ## Spike constraint 1 is honoured here, not deferred
//
// Every text field's `value` is plain local `useState`, updated SYNCHRONOUSLY in
// `onChangeText`. Spike #837 gate 1 case D measured that routing an input value
// through even a single `setTimeout(…, 0)` severs the iOS IME's composition
// state and Korean jamo stop combining entirely — 표준 produced
// `ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ` where `안녕하세요` was typed. Nothing on this screen
// routes an input value through a store, a query or the network and back.
// `__tests__/composerSync.test.tsx` fails if that changes.
// =============================================================================

type Phase =
  | {kind: 'idle'}
  | {kind: 'busy'}
  | {kind: 'failed'; title: string; detail: string}
  | {kind: 'connected'; response: LoginResponse};

export default function ConnectScreen(): React.JSX.Element {
  const prefill = useJoinPrefill();

  // Synchronous local state. See the note above before changing any of these.
  const [serverUrl, setServerUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<Phase>({kind: 'idle'});

  // A deep link fills the field once, and only while the person has not typed
  // their own value — a link arriving mid-edit must not overwrite what they are
  // in the middle of writing.
  const [prefillApplied, setPrefillApplied] = useState(false);
  if (prefill && !prefillApplied) {
    setPrefillApplied(true);
    if (prefill.serverUrl !== '' && serverUrl === '') {
      setServerUrl(prefill.serverUrl);
    }
  }

  // Derived during render from the core, not stored. There is no second copy of
  // this answer to fall out of step with the field.
  const check = serverUrl.trim() === '' ? null : normalizeServerUrl(serverUrl);

  const canSubmit =
    check?.ok === true &&
    email.trim() !== '' &&
    password !== '' &&
    phase.kind !== 'busy';

  const onSubmit = useCallback(async () => {
    const checked = normalizeServerUrl(serverUrl);
    if (!checked.ok) {
      setPhase({kind: 'failed', title: '주소를 확인하세요', detail: checked.message});
      return;
    }
    setPhase({kind: 'busy'});
    // Stored BEFORE the request, because the core reads the base through the
    // host port when it builds the URL — `login()` has no server argument by
    // design.
    setServerBase(checked.base);
    try {
      const response = await login(email.trim(), password);
      setPhase({kind: 'connected', response});
    } catch (error) {
      if (error instanceof NetworkError) {
        // Nothing answered. The core already wrote the Korean copy, including
        // the deadline in seconds, so it is shown rather than paraphrased.
        setPhase({kind: 'failed', title: '서버에 닿지 못했습니다', detail: error.message});
        return;
      }
      if (error instanceof ApiError) {
        setPhase({
          kind: 'failed',
          title: error.status === 401 ? '로그인 정보가 맞지 않습니다' : `서버가 거절했습니다 (${error.status})`,
          detail: error.message,
        });
        return;
      }
      setPhase({
        kind: 'failed',
        title: '예상치 못한 오류',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }, [email, password, serverUrl]);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>서버에 연결</Text>
      <Text style={styles.subtitle}>
        oort는 셀프호스팅입니다. 연결할 서버 주소를 입력하세요.
      </Text>

      <Field label="서버 주소">
        <TextInput
          style={styles.input}
          value={serverUrl}
          onChangeText={setServerUrl}
          placeholder={SERVER_URL_PLACEHOLDER}
          placeholderTextColor="#8a8f98"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          testID="server-url-input"
        />
      </Field>

      {/* The core's answer, rendered verbatim. This line is the visible
          evidence that @momo/core is running inside this app. */}
      {check !== null && (
        <Text
          style={check.ok ? styles.hintOk : styles.hintBad}
          testID="server-url-hint">
          {check.ok ? `요청 주소: ${check.base}/v1/…` : check.message}
        </Text>
      )}

      <Field label="이메일">
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          testID="email-input"
        />
      </Field>

      <Field label="비밀번호">
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          testID="password-input"
        />
      </Field>

      {prefill?.inviteCode ? (
        <Text style={styles.hintOk} testID="invite-hint">
          초대 링크를 읽었습니다. 초대 코드로 가입하는 화면은 다음 배치입니다.
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        disabled={!canSubmit}
        onPress={onSubmit}
        style={({pressed}) => [
          styles.button,
          !canSubmit && styles.buttonDisabled,
          pressed && canSubmit && styles.buttonPressed,
        ]}
        testID="submit-button">
        {phase.kind === 'busy' ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.buttonLabel}>연결</Text>
        )}
      </Pressable>

      {phase.kind === 'failed' && (
        <View style={styles.failure} testID="failure">
          <Text style={styles.failureTitle}>{phase.title}</Text>
          <Text style={styles.failureDetail}>{phase.detail}</Text>
        </View>
      )}

      {phase.kind === 'connected' && (
        <View style={styles.success} testID="success">
          <Text style={styles.successTitle}>연결됨</Text>
          <Text style={styles.successDetail}>
            {phase.response.member.displayName} (@{phase.response.member.handle})
          </Text>
          <Text style={styles.successDetail}>
            워크스페이스 {phase.response.member.workspaceId}
          </Text>
          <Text style={styles.successMuted}>
            리프레시 토큰은 iOS 키체인에 저장했습니다.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#0f1115'},
  content: {padding: 24, paddingTop: 64, gap: 16},
  title: {fontSize: 26, fontWeight: '600', color: '#f2f3f5'},
  subtitle: {fontSize: 14, color: '#9aa0a8', marginBottom: 8},
  field: {gap: 6},
  label: {fontSize: 13, color: '#9aa0a8'},
  input: {
    borderWidth: 1,
    borderColor: '#2a2f38',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    color: '#f2f3f5',
    backgroundColor: '#171a20',
  },
  hintOk: {fontSize: 12, color: '#6fa8dc'},
  hintBad: {fontSize: 12, color: '#e0777d'},
  button: {
    marginTop: 8,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#3b6fd4',
  },
  buttonDisabled: {backgroundColor: '#2a2f38'},
  buttonPressed: {backgroundColor: '#325ab3'},
  buttonLabel: {color: '#ffffff', fontSize: 16, fontWeight: '600'},
  failure: {
    borderRadius: 8,
    padding: 14,
    backgroundColor: '#2a1c1f',
    borderWidth: 1,
    borderColor: '#5a2f35',
    gap: 4,
  },
  failureTitle: {color: '#f0b4b8', fontSize: 14, fontWeight: '600'},
  failureDetail: {color: '#c9989c', fontSize: 13},
  success: {
    borderRadius: 8,
    padding: 14,
    backgroundColor: '#16241c',
    borderWidth: 1,
    borderColor: '#2c4a38',
    gap: 4,
  },
  successTitle: {color: '#93d3a8', fontSize: 14, fontWeight: '600'},
  successDetail: {color: '#c2d8c9', fontSize: 13},
  successMuted: {color: '#7f9488', fontSize: 12, marginTop: 4},
});
