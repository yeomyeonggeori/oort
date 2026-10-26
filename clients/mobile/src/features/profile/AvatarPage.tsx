import {memberAvatarRemoveError} from '@momo/core/features/settings/memberAvatarCopy';
import {memberFor, type Directory} from '@momo/core/features/workspace/directory';
import {removeMyAvatar, type RosterMember} from '@momo/core/lib/api';
import {useQueryClient} from '@tanstack/react-query';
import React, {useRef, useState} from 'react';
import {Linking, StyleSheet, View} from 'react-native';

import {NoticeBlock, Sentence} from '../../design/atoms';
import {GroupCard} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {font, line, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
import {Avatar} from '../conversation/Avatar';
import {useOnline} from '../inbox/useOnline';
import {workspaceKeys} from '../workspace/queries';
import {
  avatarFailureCopy,
  changeAvatarPhoto,
  withMyAvatar,
  type AvatarPhotoPorts,
  type AvatarSource,
} from './avatarPhoto';
import {nativeAvatarPhotoPorts} from './avatarPhotoNative';
import {PROFILE_FACE, useFaceRing} from './ProfileFace';
import {ActionRow} from './settingsRows';

// =============================================================================
// 프로필 사진 — 설정 페이지 위의 안쪽 장 (#4384, owner 10-25; #4457 에서 시트 안의 장 → 안쪽 장).
//
// 「모바일에서 프로필 이미지를 바꿀 수 있는 수단이 없다」. 머리의 큰 얼굴(또는 그 밑의 「사진
// 바꾸기」)이 이 장을 연다. 시트 위에 시트를 겹치지 않는다(테마·기한 장과 같은 안쪽 장 문법, 머리는 ‹) —
// 이슈의 「사진 고르기 · 사진 찍기 · 사진 지우기(있을 때)」 세 줄이 이 장이다.
//
// 고르면 시스템 편집기가 정사각으로 자르게 하고(가운데 기본, 끌어 조정), 512 로 줄여 올린다
// (`avatarPhoto.ts`). 끝나면 roster 의 내 행만 바뀌어 사이드바·대화·프로필이 곧바로 새 얼굴이
// 된다. 지우기는 있을 때만 줄이 서고, 없으면 줄이 아예 없다(없는 것을 눌러 보게 하지 않는다).
//
// 연결이 끊긴 동안은 세 줄을 잠그고 이유를 말한다 — 올리다 멈춘 채 도는 스피너를 만들지 않는다.
// 거절된 권한은 문장 + 「설정 열기」다(카메라와 사진은 설정에서 다른 행이라 문장이 구분해 말한다).
// =============================================================================

export const AVATAR_PAGE_OFFLINE = '연결이 끊겨 있어요. 연결되면 프로필 사진을 바꿀 수 있어요.';

type Busy = AvatarSource | 'remove' | null;

export function AvatarPage({
  workspaceId,
  selfId,
  directory,
  onDone,
  ports = nativeAvatarPhotoPorts,
}: {
  workspaceId: string;
  selfId: string;
  directory: Directory;
  /** 바뀌었거나 지워졌으면 부른다 — 이 장이 걷히고 설정 페이지로 돌아간다. */
  onDone: () => void;
  /** 시험이 바꿔 끼운다. 앱은 네이티브 포트다. */
  ports?: AvatarPhotoPorts;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const faceRing = useFaceRing();
  const client = useQueryClient();
  const online = useOnline();
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<{text: string; settings: boolean} | null>(null);
  // 같은 줄을 연달아 눌러 편집기가 두 번 뜨는 것을 막는다(상태 갱신보다 빠른 두 번째 탭).
  const running = useRef(false);

  const self: RosterMember | undefined = memberFor(directory, selfId) ?? undefined;
  const hasPhoto = self?.avatarUrl !== undefined;
  // 카메라를 못 여는 기기(시뮬레이터 등)에는 줄을 세우지 않는다 — 눌러서 막히는 줄을 두지 않는다.
  const cameraAvailable = ports.cameraAvailable();
  const locked = busy !== null || !online;

  const settle = (avatarUrl: string | undefined) => {
    client.setQueryData<RosterMember[]>(workspaceKeys.roster(workspaceId), rows =>
      withMyAvatar(rows, selfId, avatarUrl),
    );
    // 서버의 답으로 다시 맞춘다(낙관값이 틀렸다면 여기서 바로잡힌다).
    void client.invalidateQueries({queryKey: workspaceKeys.roster(workspaceId)});
  };

  const run = async (kind: Exclude<Busy, null>, work: () => Promise<boolean>) => {
    if (running.current || !online) return;
    running.current = true;
    setFailure(null);
    setBusy(kind);
    try {
      if (await work()) onDone();
    } finally {
      running.current = false;
      setBusy(null);
    }
  };

  const choose = (source: AvatarSource) =>
    void run(source, async () => {
      const outcome = await changeAvatarPhoto(workspaceId, source, ports);
      if (outcome.ok) {
        settle(outcome.avatarUrl);
        return true;
      }
      if (!outcome.cancelled) {
        const denied = outcome.failure.kind === 'denied';
        setFailure({text: avatarFailureCopy(outcome.failure), settings: denied});
      }
      return false;
    });

  const remove = () =>
    void run('remove', async () => {
      try {
        await removeMyAvatar(workspaceId);
      } catch {
        setFailure({text: memberAvatarRemoveError(), settings: false});
        return false;
      }
      settle(undefined);
      return true;
    });

  return (
    <View style={styles.page} testID="avatar-page">
      <View style={styles.preview}>
        {/* 설정 본 페이지의 머리와 같은 크기·같은 링 — 맨몸이면 다크에서 얼굴이 바탕과 1.04:1 로 사라진다. */}
        <View style={faceRing} testID="avatar-page-face">
          <Avatar directory={directory} memberId={selfId} size={PROFILE_FACE} />
        </View>
        <Sentence style={styles.caption} testID="avatar-page-description">
          정사각으로 잘려 모든 대화에 보여요. 위치 정보는 지워지고 올라가요.
        </Sentence>
      </View>

      {online ? null : (
        <View accessibilityLiveRegion="polite">
          <NoticeBlock headline={AVATAR_PAGE_OFFLINE} testID="avatar-page-offline" />
        </View>
      )}

      <GroupCard testID="avatar-card">
        <ActionRow
          title="사진 고르기"
          detail="사진 보관함에서 골라요"
          chevron
          pending={busy === 'library'}
          disabled={locked}
          onPress={() => choose('library')}
          testID="avatar-choose-library"
        />
        {cameraAvailable ? (
          <ActionRow
            title="사진 찍기"
            detail="카메라로 지금 찍어요"
            chevron
            pending={busy === 'camera'}
            disabled={locked}
            onPress={() => choose('camera')}
            testID="avatar-choose-camera"
          />
        ) : null}
      </GroupCard>

      {/* 파괴 행은 따로 선 카드다(`phone-sheets.md` §5, 설정의 「로그아웃」·상태 시트의 「상태 지우기」와 같다). */}
      {hasPhoto ? (
        <GroupCard testID="avatar-remove-card">
          <ActionRow
            title="사진 지우기"
            detail="이름의 첫 글자로 돌아가요"
            tone="danger"
            pending={busy === 'remove'}
            disabled={locked}
            onPress={remove}
            testID="avatar-remove"
          />
        </GroupCard>
      ) : null}

      {failure ? (
        <View style={styles.failureBlock}>
          <Sentence
            accessibilityLiveRegion="polite"
            style={styles.failure}
            testID="avatar-page-failure">
            {failure.text}
          </Sentence>
          {failure.settings ? (
            <GroupCard>
              <ActionRow
                title="설정 열기"
                chevron
                tone="accent"
                onPress={() => void Linking.openSettings()}
                testID="avatar-open-settings"
              />
            </GroupCard>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 카드는 폭 전체로 서고 가로 여백은 호스트가 진다(`GroupCard`) — 이 장이 진다. 카드 사이 16(설정 본 페이지와 같다).
    page: {gap: space.lg, paddingHorizontal: SAFE_GUTTER},
    preview: {alignItems: 'center', gap: space.md},
    caption: {
      fontSize: font.label,
      color: color.textMuted,
      lineHeight: line.label,
      textAlign: 'center',
    },
    failureBlock: {gap: space.md},
    failure: {
      fontSize: font.label,
      color: color.dangerText,
      lineHeight: line.label,
    },
  });
