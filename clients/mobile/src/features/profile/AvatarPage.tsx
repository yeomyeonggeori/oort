import {memberAvatarRemoveError} from '@momo/core/features/settings/memberAvatarCopy';
import {memberFor, type Directory} from '@momo/core/features/workspace/directory';
import {removeMyAvatar, type RosterMember} from '@momo/core/lib/api';
import {useQueryClient} from '@tanstack/react-query';
import React, {useRef, useState} from 'react';
import {ActivityIndicator, Linking, StyleSheet, View} from 'react-native';

import {GroupRow, GroupSection, NoticeBlock, Sentence} from '../../design/atoms';
import {usePalette, useStyles} from '../../design/theme';
import {font, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
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

// =============================================================================
// 프로필 사진 — 프로필 시트 안의 한 장 (#4384, owner 10-25).
//
// 「모바일에서 프로필 이미지를 바꿀 수 있는 수단이 없다」. 머리의 큰 얼굴(또는 그 밑의 「사진
// 바꾸기」)이 이 장을 연다. 시트 위에 시트를 겹치지 않는다(테마·상태 글·기한 장과 같은 문법) —
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
  /** 바뀌었거나 지워졌으면 부른다 — 시트가 프로필로 돌아간다. */
  onDone: () => void;
  /** 시험이 바꿔 끼운다. 앱은 네이티브 포트다. */
  ports?: AvatarPhotoPorts;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
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

  const spinner = (
    <ActivityIndicator
      color={palette.textMuted}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );

  return (
    <View style={styles.page} testID="avatar-page">
      <View style={styles.preview}>
        <Avatar directory={directory} memberId={selfId} size={PREVIEW_AVATAR} />
        <Sentence style={styles.caption} testID="avatar-page-description">
          정사각으로 잘려 모든 대화에 보여요. 위치 정보는 지워지고 올라가요.
        </Sentence>
      </View>

      {online ? null : (
        <View accessibilityLiveRegion="polite">
          <NoticeBlock headline={AVATAR_PAGE_OFFLINE} testID="avatar-page-offline" />
        </View>
      )}

      <GroupSection>
        <GroupRow
          title="사진 고르기"
          detail="사진 보관함에서 골라요"
          chevron={busy !== 'library'}
          disabled={locked}
          onPress={() => choose('library')}
          trailing={busy === 'library' ? spinner : undefined}
          testID="avatar-choose-library"
        />
        {cameraAvailable ? (
          <GroupRow
            title="사진 찍기"
            detail="카메라로 지금 찍어요"
            chevron={busy !== 'camera'}
            separated
            disabled={locked}
            onPress={() => choose('camera')}
            trailing={busy === 'camera' ? spinner : undefined}
            testID="avatar-choose-camera"
          />
        ) : null}
        {hasPhoto ? (
          <GroupRow
            title="사진 지우기"
            detail="이름의 첫 글자로 돌아가요"
            tone="danger"
            separated
            disabled={locked}
            onPress={remove}
            trailing={busy === 'remove' ? spinner : undefined}
            testID="avatar-remove"
          />
        ) : null}
      </GroupSection>

      {failure ? (
        <View style={styles.failureBlock}>
          <Sentence
            accessibilityLiveRegion="polite"
            style={styles.failure}
            testID="avatar-page-failure">
            {failure.text}
          </Sentence>
          {failure.settings ? (
            <GroupSection>
              <GroupRow
                title="설정 열기"
                chevron
                tone="accent"
                onPress={() => void Linking.openSettings()}
                testID="avatar-open-settings"
              />
            </GroupSection>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** 이 장의 큰 얼굴. 머리의 80 보다 한 단 크다 — 지금 무엇이 올라가 있는지 보이는 자리다. */
const PREVIEW_AVATAR = 96;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    page: {gap: space.xl},
    preview: {alignItems: 'center', gap: space.md, paddingHorizontal: SAFE_GUTTER},
    caption: {
      fontSize: font.label,
      color: color.textMuted,
      lineHeight: 18,
      textAlign: 'center',
    },
    failureBlock: {gap: space.md},
    failure: {
      fontSize: font.label,
      color: color.dangerText,
      lineHeight: 18,
      paddingHorizontal: SAFE_GUTTER,
    },
  });
