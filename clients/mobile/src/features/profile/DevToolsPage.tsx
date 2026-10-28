import {devAccessError} from '@momo/core/features/auth/devAccess';
import {
  DEV_LIST_SCOPE_LABELS,
  DEV_NOTICES,
  devAccessErrorText,
  devAccessGate,
  devCredentialRow,
  type DevCredentialRow,
} from '@momo/core/features/auth/devAccessModel';
import React, {useEffect, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {Sentence} from '../../design/atoms';
import {ConfirmStep, GroupCard, ListRow} from '../../design/sheetParts';
import {usePalette, useStyles} from '../../design/theme';
import {
  font,
  line,
  SAFE_GUTTER,
  SHEET,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useNow} from '../../lib/useNow';
import {SheetNotice} from '../../shell/sheetForm';
import {useOnline} from '../inbox/useOnline';
import {
  useDevAccessPolicy,
  useMyDevCredentials,
  useRevokeDevCredential,
} from './devTools';
import {ActionRow, SettingsNote, SettingsSection} from './settingsRows';

// =============================================================================
// 「명령줄·AI 도구」: 설정 페이지 위의 안쪽 장 (#4663, ADR-0216 D6·D7).
//
// 폰은 **목록과 폐기만** 한다. 토큰을 붙여 넣을 터미널이 폰에 없고, 비밀번호를 다시 치는 일과 한 번만 보이는 비밀을 폰
// 화면에 띄울 까닭도 없다(비밀이 화면에 서는 면만 늘어난다). 대신 노트북을 잃어버렸거나 수상한 도구를 봤을 때 **폰에서
// 바로 끊을 수** 있어야 한다. 새 연결은 컴퓨터의 설정이 만든다고 한 줄로 말한다.
//
// ## 한 줄이 말하는 것
//
// 이름 · (도구 또는 로그인 세션) · 범위 · (기기: 로그인 세션만) · 마지막 사용 · 만료 · 「지우기」. 카드 토큰에는 기기 이름이
// 없다(서버가 안 준다). 그 칸은 비워 두지 않고 **줄째 서지 않는다**: 지어낸 값도 빈 칸도 사실이 아니다. 도구는 만든 사람이
// 고른 이름표일 뿐이라 아래 문장이 그렇게 말한다.
//
// ## 지우기는 한 번 더 묻는다
//
// 되돌릴 수 없고 그 도구는 바로 끊긴다. 확인은 대화 정보 페이지의 「채널 나가기」와 같은 문법이다: 페이지 안에서 목록 대신
// 공용 `ConfirmStep` 이 선다. 확인 전에는 요청이 나가지 않는다. 끊긴 동안에는 단추가 잠기고 이유를 말한다.
//
// ## 내 것만
//
// 소유자·관리자도 이 장은 내 연결만 보인다(남의 행에는 지우기가 없다). 팀 전체는 컴퓨터의 설정에서 본다.
// =============================================================================

export const DEV_TOOLS_TITLE = '명령줄·AI 도구';
export const DEV_TOOLS_ROW_HINT = '내가 만든 연결을 보고 지워요.';
/** 내가 만들 수 있을 때의 안내. 만들 수 없으면 코어의 `devAccessGate` 문장이 대신 선다. */
export const DEV_TOOLS_CREATE_ON_COMPUTER =
  '새 연결은 컴퓨터의 설정 › 명령줄·AI 도구에서 만들어요.';
export const DEV_TOOLS_ADMIN_NOTE =
  '관리자는 컴퓨터의 설정에서 팀 전체의 연결을 볼 수 있어요.';
export const DEV_TOOLS_LOADING = '불러오는 중이에요';
export const DEV_TOOLS_LOAD_FAILED = '연결 목록을 불러오지 못했어요';
export const DEV_TOOLS_RETRY = '다시 불러오기';
export const DEV_TOOLS_EMPTY = '만든 연결이 없어요';
export const DEV_TOOLS_OFFLINE =
  '인터넷 연결이 끊겨 있어요. 다시 연결되면 지울 수 있어요.';
export const DEV_TOOLS_REVOKE_LABEL = '지우기';
export const DEV_TOOLS_REVOKE_HINT = '지우기 전에 한 번 더 물어요.';
export const DEV_TOOLS_REVOKE_PENDING = '지우는 중…';
export const DEV_TOOLS_REVOKED_RECEIPT = '연결을 지웠어요.';

/** 설정 페이지 행의 오른쪽 값. 연결이 하나도 없으면 값을 달지 않는다. */
export function devToolsCountLabel(count: number): string {
  return `${count}개`;
}

interface Piece {
  /** testID 의 끝과 React 키. */
  key: string;
  text: string;
}

type Target = {id: string; name: string};

export function DevToolsPage({
  workspaceId,
  selfId,
  onTop,
}: {
  workspaceId: string;
  /** 내 멤버 id. 목록은 이 사람의 연결만 남긴다. */
  selfId: string;
  /** 확인 단계가 서면 부른다. 목록 중간까지 내려 본 사람의 확인 카드가 화면 밖에 서지 않게 호스트가 맨 위로 올린다. */
  onTop?: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const online = useOnline();
  const now = useNow();
  const policy = useDevAccessPolicy(workspaceId);
  const list = useMyDevCredentials(workspaceId, selfId);
  const revoke = useRevokeDevCredential(workspaceId);
  const [target, setTarget] = useState<Target | null>(null);
  // 같은 단추를 연달아 눌러 요청이 두 번 나가는 것을 막는다. 질의 라이브러리의 「보내는 중」은 다음 틱에야 서서 한 프레임
  // 안의 두 번째 탭은 그것으로 못 막는다(`AvatarPage` 의 `running` 과 같은 이유).
  const sending = useRef(false);

  // 확인 단계가 서는 순간: 맨 위로 올리고, 무엇을 묻는지 읽어 준다(눌렀던 행이 사라져 보조기술의 초점이 갈 곳을 잃는다).
  const askedName = target?.name;
  useEffect(() => {
    if (askedName === undefined) return;
    onTop?.();
    AccessibilityInfo.announceForAccessibility(confirmHeadline(askedName));
  }, [askedName, onTop]);

  const failure = revoke.isError
    ? devAccessErrorText(devAccessError(revoke.error), 'revoke')
    : null;

  const ask = (row: DevCredentialRow) => {
    if (!online) return;
    revoke.reset();
    setTarget({id: row.id, name: row.name});
  };
  const cancel = () => {
    // 요청이 가는 중이면 그 결과(성공이면 줄이 사라지고, 실패면 목록 밑에 이유가 선다)는 그대로 둔다.
    if (!revoke.isPending) revoke.reset();
    setTarget(null);
  };
  const confirm = () => {
    if (target === null || sending.current || !online) return;
    sending.current = true;
    revoke.mutate(target.id, {
      onSuccess: () => {
        setTarget(null);
        AccessibilityInfo.announceForAccessibility(DEV_TOOLS_REVOKED_RECEIPT);
      },
      onSettled: () => {
        sending.current = false;
      },
    });
  };

  if (target !== null) {
    return (
      <View style={styles.page} testID="dev-tools-page">
        <ConfirmStep
          testID="dev-revoke-confirm"
          headline={confirmHeadline(target.name)}
          detail={DEV_NOTICES.revokeWarning}
          error={online ? failure : DEV_TOOLS_OFFLINE}
          errorTestID="dev-revoke-error"
          confirmLabel={DEV_TOOLS_REVOKE_LABEL}
          pendingLabel={DEV_TOOLS_REVOKE_PENDING}
          pending={revoke.isPending}
          onCancel={cancel}
          onConfirm={confirm}
          cancelTestID="dev-revoke-cancel"
          confirmTestID="dev-revoke-confirm-button"
        />
      </View>
    );
  }

  const gate = policy.data ? devAccessGate(policy.data) : null;
  // 정책을 못 읽었으면 만들 수 있는지 모르는 것이다. 모르는 것을 약속하지 않고 이 줄만 뺀다(지우는 길은 그대로다).
  const intro =
    gate === null
      ? null
      : gate.state === 'open'
        ? DEV_TOOLS_CREATE_ON_COMPUTER
        : gate.text;
  const rows = list.data?.map(credential => devCredentialRow(credential, {now})) ?? null;

  return (
    <View style={styles.page} testID="dev-tools-page">
      <View style={styles.intro}>
        {intro !== null ? (
          <SettingsNote testID="dev-tools-intro">{intro}</SettingsNote>
        ) : null}
        <SettingsNote testID="dev-tools-logout-note">
          {DEV_NOTICES.logoutKeepsConnections}
        </SettingsNote>
      </View>

      {online ? null : (
        // 끊긴 이유는 나타나는 순간 읽힌다. 단추를 잠그는 것은 아래 각 줄이다.
        <View accessibilityLiveRegion="polite">
          <SheetNotice headline={DEV_TOOLS_OFFLINE} testID="dev-tools-offline" />
        </View>
      )}

      <SettingsSection>
        <GroupCard label={DEV_LIST_SCOPE_LABELS.mine} testID="dev-tools-list">
          {rows === null
            ? list.isError
              ? [
                  <ListRow
                    key="error"
                    title={DEV_TOOLS_LOAD_FAILED}
                    detail={devAccessErrorText(devAccessError(list.error), 'list')}
                    testID="dev-tools-error"
                  />,
                  <ActionRow
                    key="retry"
                    title={DEV_TOOLS_RETRY}
                    tone="accent"
                    pending={list.isFetching}
                    onPress={() => void list.refetch()}
                    testID="dev-tools-retry"
                  />,
                ]
              : (
                  <ListRow
                    key="loading"
                    title={DEV_TOOLS_LOADING}
                    trailing={
                      <ActivityIndicator
                        color={palette.textMuted}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                      />
                    }
                    testID="dev-tools-loading"
                  />
                )
            : rows.length === 0
              ? (
                  <ListRow key="empty" title={DEV_TOOLS_EMPTY} testID="dev-tools-empty" />
                )
              : rows.map(row => (
                  <CredentialRow key={row.id} row={row} offline={!online} onRevoke={ask} />
                ))}
        </GroupCard>
        {failure !== null ? (
          // 확인 단계를 닫은 뒤에 끝난 요청의 이유. 확인 단계가 열려 있는 동안에는 그 안에서 말한다.
          <SettingsNote tone="danger" testID="dev-revoke-failure">
            {failure}
          </SettingsNote>
        ) : null}
        <SettingsNote testID="dev-tools-notes">
          {[DEV_NOTICES.passwordChangeEndsAll, DEV_NOTICES.toolIsOnlyALabel].join(' ')}
        </SettingsNote>
        {policy.data?.canManageAll === true ? (
          <SettingsNote testID="dev-tools-admin-note">{DEV_TOOLS_ADMIN_NOTE}</SettingsNote>
        ) : null}
      </SettingsSection>
    </View>
  );
}

/**
 * 이름은 사람이 쓴 글(80자, 괄호도 올 수 있다)이라 바로 뒤에 조사를 붙이지 않는다: 「…」 뒤의 조사는 줄 머리로 떨어진다
 * (`ConfirmStep` 머리말).
 */
function confirmHeadline(name: string): string {
  return `${name} 연결을 지울까요?`;
}

/**
 * 연결 한 줄: 이름과 「지우기」, 그 밑에 무엇인지·범위·기기·마지막 사용·만료. 줄 전체는 눌리지 않는다(스크롤하다
 * 지우는 일이 없게): 지우는 것은 「지우기」 단추 하나다. 보조기술에는 글 덩어리가 한 요소로 읽히고 단추가 따로 선다.
 */
function CredentialRow({
  row,
  offline,
  onRevoke,
}: {
  row: DevCredentialRow;
  offline: boolean;
  onRevoke: (row: DevCredentialRow) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const base = `dev-credential-${row.id}`;
  // 도구가 없는 줄(로그인 세션)은 종류가 그 자리에 선다. 도구를 지어내지 않는다.
  const what: Piece =
    row.toolLabel !== undefined
      ? {key: 'tool', text: row.toolLabel}
      : {key: 'kind', text: row.kindLabel};
  const first: Piece[] = [what, {key: 'scope', text: row.scopeLabel}];
  const usage: Piece[] = [
    {
      key: 'last-used',
      text: row.neverUsed ? row.lastUsedLabel : `마지막 사용 ${row.lastUsedLabel}`,
    },
    {key: 'expiry', text: row.expired ? row.expiryLabel : `${row.expiryLabel} 만료`},
  ];
  const spoken = [
    row.name,
    ...first.map(piece => piece.text),
    row.deviceName !== undefined ? `기기 ${row.deviceName}` : null,
    row.scopeDetail ?? null,
    ...usage.map(piece => piece.text),
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  return (
    <View style={styles.row} testID={base}>
      <View
        accessible
        accessibilityLabel={spoken}
        style={styles.rowText}
        testID={`${base}-info`}>
        <Text
          lineBreakStrategyIOS="hangul-word"
          style={styles.name}
          testID={`${base}-name`}>
          {row.name}
        </Text>
        <MetaLine pieces={first} base={base} />
        {row.scopeDetail !== undefined ? (
          <Sentence style={styles.meta} testID={`${base}-scope-detail`}>
            {row.scopeDetail}
          </Sentence>
        ) : null}
        {row.deviceName !== undefined ? (
          <Sentence style={styles.meta} testID={`${base}-device`}>
            {`기기 ${row.deviceName}`}
          </Sentence>
        ) : null}
        <MetaLine pieces={usage} base={base} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${row.name} ${DEV_TOOLS_REVOKE_LABEL}`}
        accessibilityHint={DEV_TOOLS_REVOKE_HINT}
        accessibilityState={{disabled: offline}}
        disabled={offline}
        onPress={() => onRevoke(row)}
        style={({pressed}) => [
          styles.revoke,
          pressed && styles.revokePressed,
          offline && styles.revokeDisabled,
        ]}
        testID={`${base}-revoke`}>
        <Text style={styles.revokeLabel}>{DEV_TOOLS_REVOKE_LABEL}</Text>
      </Pressable>
    </View>
  );
}

/** 점으로 이은 한 줄. 조각마다 testID 가 있어 값을 따로 읽을 수 있다. */
function MetaLine({
  pieces,
  base,
}: {
  pieces: readonly Piece[];
  base: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Sentence style={styles.meta}>
      {pieces.map((piece, index) => (
        <React.Fragment key={piece.key}>
          {index > 0 ? ' · ' : ''}
          <Text testID={`${base}-${piece.key}`}>{piece.text}</Text>
        </React.Fragment>
      ))}
    </Sentence>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 카드는 폭 전체로 서고 가로 여백은 호스트가 진다(`GroupCard`): 이 장이 진다. 블록 사이 16 은 설정 본 페이지와 같다.
    page: {gap: space.lg, paddingHorizontal: SAFE_GUTTER},
    intro: {gap: space.xs},
    // 행 모양은 `ListRow` 와 같은 상자(같은 토큰)다. 오른쪽의 「지우기」는 글 덩어리의 높이와 상관없이 가운데에 선다.
    row: {
      minHeight: SHEET.rowMinHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    rowText: {flex: 1, gap: space.xs},
    name: {
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
      fontWeight: '600',
    },
    meta: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    // 눌림 영역 44. 글자는 카드 안쪽 가로 여백의 오른쪽 끝에 맞추려고 단추의 안쪽 여백만큼 밖으로 뺀다.
    revoke: {
      minWidth: TOUCH_TARGET,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: space.md,
      marginRight: -space.md,
    },
    revokePressed: {opacity: 0.6},
    revokeDisabled: {opacity: 0.55},
    revokeLabel: {fontSize: font.body, fontWeight: '600', color: color.danger},
  });
