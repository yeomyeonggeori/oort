import {
  fetchHumanControlSignatureRequired,
} from '@momo/core/features/auth/deviceKeys';
import {
  NOT_DELIVERED,
  rejectWithInstruction,
  signedAllow,
  signedInstruction,
  type Delivery,
  type HumanControlSigner,
  type PermissionScope,
  type RejectWithInstructionOutcome,
} from '@momo/core/features/auth/signedControl';
import {
  pendingPermission,
  permissionFailure,
  permissionLapsed,
  PERMISSION_LAPSED_LINE,
  permissionSentLine,
  rejectWithInstructionLine,
  type PendingPermission,
} from '@momo/core/features/workbench/agentPane';
import {
  PERMISSION_PREVIEW_KIND_LABEL,
  PERMISSION_PREVIEW_LOADING_LINE,
  permissionAllowGone,
  permissionGateAsk,
  permissionPreviewGate,
  permissionPreviewRows,
  type PermissionPreviewGate,
} from '@momo/core/features/workbench/permissionPreviewGate';
import type {PermissionPreview} from '@momo/core/features/workbench/permissionPreview';
import type {WorkSessionEvent} from '@momo/core/features/work/workSessionModel';
import {
  decideWorkPermission,
  fetchWorkPermissionPreview,
  type WorkSession,
} from '@momo/core/lib/api';
import {useQuery} from '@tanstack/react-query';
import React, {useEffect, useMemo, useState} from 'react';
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {PrimaryButton, SectionLabel, Sentence} from '../../design/atoms';
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
import {phoneSigner} from '../../deviceKey/signer';
import {useDeviceKey} from '../deviceKey/useDeviceKey';

// =============================================================================
// The phone's permission card and instruction box (#3028 R2-E8; ADR-0146 개정
// 2026-09-28 D-2 · D-5b · D-8 · D-11; ADR-0188 D3 · D4 · D5).
//
// Shown only to the session's owner, only while the server REQUIRES a device
// signature (the flag, D-11). With the flag closed the phone keeps today's
// read-only detail: nothing here renders.
//
// - Allow 「이번 한 번」 or 「이 세션 동안」 (R2 opens the latter on the phone,
//   0188 D5): Face ID signs the allow (control v3, #3128). The card first
//   reads the host's preview with the owner's `GET …/permission-requests/{id}`
//   and shows it verbatim; the allow buttons open only when
//   `checkPermissionPreview` passes (the hash this phone recomputes equals the
//   request's and the preview is whole), and that recomputed hash is what Face
//   ID signs. Nothing on this card is inferred from `agent.status` (#3118 H1):
//   the question comes from the checked preview's kind, or says no kind at all.
//   Face ID IS the confirmation.
// - Reject never signs (D-8). It asks once, with an optional instruction —
//   「거부 + 지시」: the instruction is a signed `input` sent after the reject.
// - Instruction: 「다음 차례로 보내기」 (queue, the default) or 「지금 끼어들기」
//   (interrupt, a separate button, D4).
// - A signed action that does not arrive says 「전달 안 됨」 with the reason and
//   keeps the text. It never quietly becomes a chat message (D-5b).
//
// All the flows are the shared core's (`signedControl.ts`); the desktop app
// runs the same ones with its shell as the signer.
// =============================================================================

export const SIGNING_REQUIRED_QUERY_KEY = (workspaceId: string) =>
  ['device-keys', workspaceId, 'signing-context', 'human-control-required'] as const;

/** Why this phone cannot sign right now, or null when it can. */
export type SignBlock = string | null;

export const PERMISSION_PREVIEW_QUERY_KEY = (
  workspaceId: string,
  sessionId: string,
  requestEventId: string,
) => ['work-permission-preview', workspaceId, sessionId, requestEventId] as const;

type CheckedPreview = {preview: PermissionPreview; sha256: string};

export interface SignedWorkActions {
  allow: (
    permission: PendingPermission,
    scope: PermissionScope,
    preview: CheckedPreview,
  ) => Promise<void>;
  reject: (permission: PendingPermission) => Promise<void>;
  rejectWithInstruction: (
    permission: PendingPermission,
    text: string,
  ) => Promise<RejectWithInstructionOutcome>;
  instruct: (text: string, mode: 'queue' | 'interrupt') => Promise<Delivery>;
}

export function signedWorkActions(
  workspaceId: string,
  session: Pick<WorkSession, 'id' | 'hostId'>,
  signer: HumanControlSigner,
): SignedWorkActions {
  return {
    allow: (permission, scope, preview) =>
      signedAllow({
        workspaceId,
        session,
        requestEventId: permission.requestEventId,
        optionId: permission.allow!.optionId,
        scope,
        preview,
        signer,
      }),
    reject: async permission => {
      await decideWorkPermission(workspaceId, session.id, {
        requestEventId: permission.requestEventId,
        optionId: permission.reject!.optionId,
        kind: 'reject_once',
      });
    },
    rejectWithInstruction: (permission, text) =>
      rejectWithInstruction({
        workspaceId,
        session,
        requestEventId: permission.requestEventId,
        optionId: permission.reject!.optionId,
        text,
        signer,
      }),
    instruct: (text, mode) =>
      signedInstruction({workspaceId, session, text, mode, signer}),
  };
}

/** The server's flag (D-11): `true` only when it says signatures are required. */
export function useSigningRequired(workspaceId: string, enabled: boolean): boolean {
  const flag = useQuery({
    queryKey: SIGNING_REQUIRED_QUERY_KEY(workspaceId),
    queryFn: () => fetchHumanControlSignatureRequired(workspaceId),
    enabled,
    staleTime: 5 * 60_000,
  });
  return flag.data === true;
}

/**
 * The owner's read of the host's preview for the open request, through the
 * shared gate (#3128). Read once per request; a failed read says so and can be
 * retried by reopening, it never falls back to an inferred preview.
 */
export function usePermissionPreviewGate(
  workspaceId: string,
  sessionId: string,
  permission: PendingPermission | null,
  enabled: boolean,
): PermissionPreviewGate {
  const requestEventId = permission?.requestEventId ?? '';
  const read = useQuery({
    queryKey: PERMISSION_PREVIEW_QUERY_KEY(workspaceId, sessionId, requestEventId),
    queryFn: () =>
      fetchWorkPermissionPreview(workspaceId, sessionId, requestEventId),
    enabled: enabled && permission !== null,
    staleTime: Infinity,
    retry: 1,
    // A failed read tries again on its own (the card's sentence says so).
    refetchInterval: query => (query.state.status === 'error' ? 15_000 : false),
  });
  return permissionPreviewGate(
    permission?.previewSha256 ?? null,
    read.data
      ? {status: 'ok', data: read.data}
      : read.isError
        ? {status: 'error'}
        : {status: 'loading'},
  );
}

/** Product container: the flag, this phone's key, the signer. */
export function SignedWorkControls({
  workspaceId,
  memberId,
  session,
  events,
  online,
}: {
  workspaceId: string;
  memberId: string;
  session: WorkSession;
  events: readonly WorkSessionEvent[];
  online: boolean;
}): React.JSX.Element | null {
  const owner = session.memberId.toLowerCase() === memberId.toLowerCase();
  const required = useSigningRequired(workspaceId, owner);
  const key = useDeviceKey(workspaceId, {poll: false});
  const deviceKeyId =
    key.view.kind === 'approved' ? key.view.row.id : null;
  const actions = useMemo(
    () =>
      deviceKeyId === null
        ? null
        : signedWorkActions(
            workspaceId,
            session,
            phoneSigner({workspaceId, memberId, deviceKeyId}),
          ),
    [deviceKeyId, workspaceId, session, memberId],
  );
  const permission = pendingPermission(events, session);
  const preview = usePermissionPreviewGate(
    workspaceId,
    session.id,
    permission,
    owner && required,
  );
  // D-11: nothing changes unless the server says signatures are required.
  if (!owner || !required) return null;
  const block: SignBlock =
    key.view.kind === 'approved'
      ? key.view.biometryOff
        ? 'Face ID가 꺼져 있어 허락과 지시에 서명할 수 없어요. 설정에서 oort의 Face ID를 켜 주세요.'
        : null
      : key.view.kind === 'loading'
        ? '이 폰의 지시 서명 키를 확인하는 중이에요.'
        : key.view.kind === 'reconnect'
          ? '로그인이 끝나 이 폰의 지시 키를 다시 연결해야 해요. 프로필 › 지시 기기에서 다시 연결해 주세요.'
          : '이 폰은 아직 지시 기기가 아니에요. 프로필 › 지시 기기에서 등록하고 맥의 승인을 받아 주세요.';
  return (
    <SignedWorkControlsView
      permission={permission}
      preview={preview}
      ended={session.status !== 'running' && session.status !== 'idle'}
      online={online}
      block={block}
      actions={actions}
      fallbackReject={
        actions === null
          ? async open => {
              await decideWorkPermission(workspaceId, session.id, {
                requestEventId: open.requestEventId,
                optionId: open.reject!.optionId,
                kind: 'reject_once',
              });
            }
          : null
      }
    />
  );
}

/**
 * A starting state for the capture lane (`measure/surfaces.tsx`), which cannot
 * tap a simulator. The product never passes it.
 */
export interface SignedWorkInitial {
  asking?: boolean;
  rejectNote?: string;
  outcome?: CardOutcome;
  text?: string;
  note?: {failed: boolean; text: string};
}

/** Presentational: everything above is data. */
export function SignedWorkControlsView({
  permission,
  preview,
  ended,
  online,
  block,
  actions,
  fallbackReject,
  now = Date.now,
  initial,
}: {
  permission: PendingPermission | null;
  /** The host's preview through the shared gate (#3128). */
  preview: PermissionPreviewGate;
  ended: boolean;
  online: boolean;
  block: SignBlock;
  actions: SignedWorkActions | null;
  /** Reject without a key (reject is never signed, D-8). */
  fallbackReject: ((permission: PendingPermission) => Promise<void>) | null;
  now?: () => number;
  initial?: SignedWorkInitial;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  // 닿지 않은 「거부 + 지시」의 글을 지시 칸으로 옮긴다(버리지 않는다, D-5b).
  const [seed, setSeed] = useState<{text: string} | null>(null);
  return (
    <View testID="work-signed-controls">
      {block ? (
        <View style={styles.blockWrap}>
          <Sentence style={styles.blockText} testID="work-signed-block">
            {block}
          </Sentence>
        </View>
      ) : null}
      {permission ? (
        <PermissionCard
          key={permission.requestEventId}
          permission={permission}
          preview={preview}
          online={online}
          block={block}
          actions={actions}
          fallbackReject={fallbackReject}
          lapsed={permissionLapsed(permission, now())}
          initial={initial}
          onUndelivered={text => setSeed({text})}
        />
      ) : null}
      {ended ? null : (
        <InstructionBox
          quiet={permission !== null}
          seed={seed}
          online={online}
          block={block}
          actions={actions}
          initial={initial}
        />
      )}
    </View>
  );
}

export type CardOutcome = {tone: 'sent' | 'closed' | 'partial'; text: string} | null;

function PermissionCard({
  permission,
  preview,
  online,
  block,
  actions,
  fallbackReject,
  lapsed,
  initial,
  onUndelivered,
}: {
  onUndelivered: (text: string) => void;
  permission: PendingPermission;
  preview: PermissionPreviewGate;
  online: boolean;
  block: SignBlock;
  actions: SignedWorkActions | null;
  fallbackReject: ((permission: PendingPermission) => Promise<void>) | null;
  lapsed: boolean;
  initial?: SignedWorkInitial;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const [busy, setBusy] = useState<'once' | 'session' | 'reject' | null>(null);
  const [asking, setAsking] = useState(initial?.asking ?? false);
  const [note, setNote] = useState(initial?.rejectNote ?? '');
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CardOutcome>(
    lapsed
      ? {tone: 'closed', text: PERMISSION_LAPSED_LINE}
      : initial?.outcome ?? null,
  );
  // #3118 H1: the question comes from the checked preview, never agent.status.
  const ask = permissionGateAsk(preview);
  const checked = preview.state === 'ready' ? preview : null;
  // No allow can come back for this request: 거부 is the one action (design-review M1).
  const allowGone = permissionAllowGone(preview);
  const blockLine =
    preview.state === 'loading'
      ? PERMISSION_PREVIEW_LOADING_LINE
      : preview.state === 'blocked'
        ? preview.line
        : null;
  // VoiceOver has no live regions: say the reason when it changes (design-review L3).
  useEffect(() => {
    if (blockLine && preview.state === 'blocked' && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(blockLine);
    }
  }, [blockLine, preview.state]);
  const shown =
    preview.state === 'ready'
      ? preview.preview
      : preview.state === 'blocked'
        ? preview.preview
        : null;
  const allowable =
    online &&
    block === null &&
    actions !== null &&
    checked !== null &&
    permission.allow !== null;
  const rejectable =
    online && permission.reject !== null && (actions !== null || fallbackReject !== null);

  const allow = async (scope: PermissionScope) => {
    if (!allowable || busy || !checked) return;
    setBusy(scope);
    setError(null);
    try {
      await actions!.allow(permission, scope, {
        preview: checked.preview,
        sha256: checked.sha256,
      });
      setOutcome({tone: 'sent', text: permissionSentLine('allow_once', scope)});
    } catch (err) {
      const failure = permissionFailure(err);
      if (failure.closed) setOutcome({tone: 'closed', text: failure.text});
      else setError(failure.text);
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (!rejectable || busy) return;
    const text = note.trim();
    setBusy('reject');
    setError(null);
    try {
      if (text !== '' && actions && block === null) {
        const out = await actions.rejectWithInstruction(permission, text);
        if (out.state === 'not_sent') {
          setError(`${NOT_DELIVERED} · ${out.text}`);
          return;
        }
        if (out.state === 'reject_failed') throw out.error;
        const delivered = out.instruction.state === 'sent';
        if (!delivered) onUndelivered(text);
        setOutcome({
          tone: delivered ? 'sent' : 'partial',
          text: rejectWithInstructionLine(
            delivered,
            out.instruction.state === 'not_delivered' ? out.instruction.text : undefined,
          ),
        });
        return;
      }
      await (actions ? actions.reject(permission) : fallbackReject!(permission));
      setOutcome({tone: 'sent', text: permissionSentLine('reject_once')});
    } catch (err) {
      const failure = permissionFailure(err);
      if (failure.closed) setOutcome({tone: 'closed', text: failure.text});
      else setError(failure.text);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.card} testID="work-permission-card">
      <SectionLabel label="권한 요청" />
      <View style={styles.cardBody}>
        <Sentence style={styles.ask} accessibilityRole="header">
          {ask}
        </Sentence>
        {/* Why the allow is shut, right under the question: a long preview
            would push it below the fold (#3128). Hidden once decided. */}
        {outcome ? null : preview.state === 'loading' ? (
          <Sentence style={styles.hint} testID="work-permission-preview-loading">
            {PERMISSION_PREVIEW_LOADING_LINE}
          </Sentence>
        ) : preview.state === 'blocked' ? (
          <Sentence
            style={styles.hint}
            testID="work-permission-preview-blocked"
            accessibilityLiveRegion="polite">
            {preview.line}
          </Sentence>
        ) : null}
        {shown ? (
          // The host's preview, whole and verbatim (0188 D5; design-review
          // B1): the hash Face ID signs is over exactly these characters, so
          // nothing here is sanitised, clipped or reflowed. The page scrolls,
          // not the box.
          <View style={styles.previewBox} testID="work-permission-preview">
            <Text style={styles.previewKind}>
              {PERMISSION_PREVIEW_KIND_LABEL[shown.kind]}
            </Text>
            {permissionPreviewRows(shown).map(row => (
              // The gutter rule is on the text only: a label never has it, so
              // a line break inside a field cannot pass for a label (H2).
              <View key={row.key} style={styles.previewRow}>
                <Text style={styles.previewLabel}>{row.label}</Text>
                <Text
                  selectable
                  style={styles.preview}
                  testID={`work-permission-preview-${row.key}`}>
                  {row.text}
                </Text>
              </View>
            ))}
          </View>
        ) : preview.state === 'loading' && !outcome ? (
          // Holds the card's height while the read runs, so 거부 does not jump
          // when the preview lands (design-review M2).
          <View
            style={[styles.previewBox, styles.previewReserve]}
            testID="work-permission-preview-reserve"
          />
        ) : null}
        {outcome ? (
          <Sentence
            accessibilityLiveRegion="polite"
            style={[styles.outcome, outcome.tone === 'partial' && styles.dangerText]}
            testID="work-permission-outcome">
            {outcome.text}
          </Sentence>
        ) : (
          <>
            {!online ? (
              <Sentence style={styles.hint}>
                오프라인이라 지금은 결정할 수 없어요.
              </Sentence>
            ) : null}
            {asking ? null : (
              <>
                {allowGone ? (
                  <SecondaryButton
                    label="이번 한 번 허락"
                    disabled
                    onPress={() => {}}
                    testID="work-permission-allow"
                  />
                ) : (
                  <PrimaryButton
                    label="이번 한 번 허락"
                    busyLabel="Face ID 확인 중"
                    busy={busy === 'once'}
                    disabled={!allowable || (busy !== null && busy !== 'once')}
                    onPress={() => void allow('once')}
                    testID="work-permission-allow"
                  />
                )}
                <SecondaryButton
                  label="이 세션 동안 허락"
                  disabled={!allowable || busy !== null}
                  onPress={() => void allow('session')}
                  testID="work-permission-allow-session"
                />
              </>
            )}
            {asking ? (
              <View style={styles.rejectBox} testID="work-permission-reject-confirm">
                <Text style={styles.fieldLabel} nativeID="reject-note-label">
                  거부하면서 보낼 지시 (비우면 거부만 보내요)
                </Text>
                <TextInput
                  lineBreakStrategyIOS="hangul-word"
                  style={styles.input}
                  value={note}
                  onChangeText={setNote}
                  multiline
                  editable={busy === null && block === null && actions !== null}
                  placeholder={
                    block === null && actions !== null
                      ? '예: 그 파일 말고 테스트만 고쳐 줘'
                      : '이 폰에서는 거부만 보낼 수 있어요'
                  }
                  placeholderTextColor={palette.textFaint}
                  accessibilityLabel="거부하면서 보낼 지시"
                  accessibilityLabelledBy="reject-note-label"
                  testID="work-permission-reject-note"
                />
                <Sentence style={styles.hint}>
                  지시는 Face ID로 서명해 다음 차례에 전달돼요.
                </Sentence>
                <DangerButton
                  label={note.trim() !== '' ? '거부하고 지시 보내기' : '거부 보내기'}
                  disabled={!rejectable || busy !== null}
                  onPress={() => void reject()}
                  testID="work-permission-reject-commit"
                />
                <SecondaryButton
                  label="취소"
                  disabled={busy !== null}
                  onPress={() => setAsking(false)}
                  testID="work-permission-reject-cancel"
                />
              </View>
            ) : (
              <SecondaryButton
                label="거부"
                disabled={!rejectable || busy !== null}
                onPress={() => {
                  setError(null);
                  setAsking(true);
                }}
                testID="work-permission-reject"
              />
            )}
            {error ? (
              <Sentence
                accessibilityRole="alert"
                style={[styles.hint, styles.dangerText]}
                testID="work-permission-error">
                {error}
              </Sentence>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

function InstructionBox({
  quiet,
  seed,
  online,
  block,
  actions,
  initial,
}: {
  online: boolean;
  block: SignBlock;
  actions: SignedWorkActions | null;
  initial?: SignedWorkInitial;
  seed: {text: string} | null;
  /** A permission card is waiting above: its allow is the one filled button. */
  quiet: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const [text, setText] = useState(initial?.text ?? '');
  useEffect(() => {
    // A draft already in the box is kept: the undelivered text goes after it.
    if (seed) {
      setText(current =>
        current.trim() === '' ? seed.text : `${current.trimEnd()}\n${seed.text}`,
      );
    }
  }, [seed]);
  const [busy, setBusy] = useState<'queue' | 'interrupt' | null>(null);
  const [note, setNote] = useState<{failed: boolean; text: string} | null>(
    initial?.note ?? null,
  );
  const ready = online && block === null && actions !== null;
  const send = async (mode: 'queue' | 'interrupt') => {
    const body = text.trim();
    if (!ready || body === '' || busy) return;
    setBusy(mode);
    setNote(null);
    const out = await actions!.instruct(body, mode);
    setBusy(null);
    if (out.state === 'not_delivered') {
      // The text stays: the person can send it again as it is.
      setNote({failed: true, text: `${NOT_DELIVERED} · ${out.text}`});
      return;
    }
    setText('');
    setNote({
      failed: false,
      text: mode === 'queue' ? '다음 차례에 전달돼요.' : '지금 차례에 끼어들었어요.',
    });
  };
  return (
    <View style={styles.card} testID="work-instruction-box">
      <SectionLabel label="다음 지시" />
      <View style={styles.cardBody}>
        <TextInput
          lineBreakStrategyIOS="hangul-word"
          style={styles.input}
          value={text}
          onChangeText={value => {
            setText(value);
            setNote(null);
          }}
          multiline
          editable={ready && busy === null}
          placeholder={ready ? '다음 지시를 적어요' : '지금은 지시를 보낼 수 없어요'}
          placeholderTextColor={palette.textFaint}
          accessibilityLabel="다음 지시"
          testID="work-instruction-input"
        />
        {quiet ? (
          <SecondaryButton
            label={busy === 'queue' ? 'Face ID 확인 중' : '다음 차례로 보내기'}
            disabled={!ready || text.trim() === '' || busy !== null}
            onPress={() => void send('queue')}
            testID="work-instruction-queue"
          />
        ) : (
          <PrimaryButton
            label="다음 차례로 보내기"
            busyLabel="Face ID 확인 중"
            busy={busy === 'queue'}
            disabled={!ready || text.trim() === '' || busy === 'interrupt'}
            onPress={() => void send('queue')}
            testID="work-instruction-queue"
          />
        )}
        <SecondaryButton
          label="지금 끼어들기"
          disabled={!ready || text.trim() === '' || busy !== null}
          onPress={() => void send('interrupt')}
          testID="work-instruction-interrupt"
        />
        <Sentence
          accessibilityRole={note?.failed ? 'alert' : undefined}
          style={[styles.hint, note?.failed && styles.dangerText]}
          testID="work-instruction-note">
          {note?.text ??
            '기본은 다음 차례 예약이에요. 보낼 때마다 Face ID로 서명해요.'}
        </Sentence>
      </View>
    </View>
  );
}

function SecondaryButton({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{disabled: disabled === true}}
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.secondary,
        disabled && styles.inert,
        pressed && !disabled && styles.pressed,
      ]}
      testID={testID}>
      <Text style={styles.secondaryLabel}>{label}</Text>
    </Pressable>
  );
}

function DangerButton({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{disabled: disabled === true}}
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.danger,
        disabled && styles.inert,
        pressed && !disabled && styles.dangerPressed,
      ]}
      testID={testID}>
      <Text style={styles.dangerLabel}>{label}</Text>
    </Pressable>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    blockWrap: {paddingHorizontal: SAFE_GUTTER, paddingTop: space.md},
    blockText: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    card: {paddingBottom: space.sm},
    cardBody: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    ask: {
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
      fontWeight: '600',
    },
    previewBox: {
      gap: space.sm,
      backgroundColor: color.surface,
      borderRadius: ds2Radius.row,
      borderWidth: 1,
      borderColor: color.border,
      padding: space.sm,
    },
    previewKind: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.text,
      fontWeight: '600',
    },
    previewRow: {gap: space.xs},
    previewReserve: {minHeight: TOUCH_TARGET * 3},
    previewLabel: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    preview: {
      fontFamily: 'Menlo',
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.text,
      borderLeftWidth: 2,
      borderLeftColor: color.textFaint,
      paddingLeft: space.sm,
    },
    outcome: {fontSize: font.label, lineHeight: line.label, color: color.text},
    hint: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    dangerText: {color: color.dangerText},
    fieldLabel: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    rejectBox: {gap: space.sm},
    input: {
      minHeight: TOUCH_TARGET * 2,
      borderRadius: ds2Radius.row,
      borderWidth: 1,
      borderColor: color.textFaint,
      backgroundColor: color.surface,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
      textAlignVertical: 'top',
    },
    secondary: {
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: ds2Radius.row,
      borderWidth: 1,
      borderColor: color.textFaint,
      backgroundColor: color.surface,
      paddingHorizontal: space.md,
    },
    secondaryLabel: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
      fontWeight: '600',
    },
    danger: {
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: ds2Radius.row,
      backgroundColor: color.dangerFill,
      paddingHorizontal: space.md,
    },
    dangerLabel: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.onDangerFill,
      fontWeight: '600',
    },
    inert: {opacity: 0.5},
    dangerPressed: {opacity: 0.85},
    pressed: {backgroundColor: color.surfacePressed},
  });
