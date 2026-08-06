import {
  avatarIdentity,
  avatarCarriesIdentityColor,
  AVATAR_SHAPE,
  AVATAR_SIZE,
  type AvatarIdentity,
} from '@momo/core/features/workspace/avatar';
import {memberFor, type Directory} from '@momo/core/features/workspace/directory';
import React, {useMemo} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {color, font, radius, space} from '../../design/tokens';
import {apiBase} from '../../storage/serverBase';

// =============================================================================
// 폰의 아바타 (감사 H-11 · goal U4-6M)
//
// 감사가 실측한 것 중 이 파일이 닫는 것: *"폰에는 아바타가 정말 없다 —
// `features/conversation/` 에 `Image`/`require(` 0건. 캡처 `m-07`/`m-09` 가 그대로
// 보여준다."* 그래서 폰의 그룹 머리는 이름 · 핸들 · 태그 · 관리자 · 시각 다섯
// 조각의 **글자만**이었고, 훑는 눈이 붙잡을 것이 없었다.
//
// ## 판정은 하나도 여기 없다
//
// 무엇을 이니셜로 삼는가, 어떤 주소를 이미지로 믿는가, 크기가 몇인가, 사람과
// 에이전트를 무엇으로 가르는가 — 전부 코어
// `@momo/core/features/workspace/avatar` 가 답한다. 그 판정들이 클라마다 있으면
// 각자 다르게 틀리고, 그중 CSP 판정은 **틀리는 방식이 조용하다**(깨진 상자만
// 남는다). 이 파일은 그 답을 칠하기만 한다.
//
// ## 다만 폰에는 코어가 답할 수 없는 조각이 하나 있다 — **오리진**
//
// 코어의 `renderableAvatarUrl` 은 `img-src 'self' data:` 아래에서 실을 수 있는
// 것만 통과시키고, 상대 경로(`/media/…`)는 「정의상 self」라 그대로 돌려준다.
// 웹에서는 그것으로 끝이다. **폰에서는 아니다**: RN 의 `Image` 에는 문서 오리진이
// 없어서 `/media/…` 는 어디도 가리키지 않는다.
//
// 그래서 이 파일이 그 한 조각을 잇는다 — 이 기기가 고른 서버 주소
// (`storage/serverBase.ts`)를 앞에 붙인다. 그 파일이 이미 같은 사실을 자기
// 머리말에 적어 두었다: *"A native app has no origin."* 그것이 여기서 아바타에
// 대해 한 번 더 참이다.
//
// 서버를 아직 안 골랐으면(`apiBase() === ''`) 상대 주소는 **이미지가 아니다**.
// 아무 데도 안 가리키는 주소로 `Image` 를 세우면 회색 상자가 남고, 사람은
// 「아바타가 없는 사람」과 「주소를 못 만든 앱」을 구별할 수 없다. 이니셜이 선다.
//
// ## 어디에 서는가 — 왼쪽 칸 (`MessageRow` 의 `rowAvatarReserve`)
//
// 작성자 줄 **안**에 넣는 안을 버렸다. 감사 M-3 이 그 줄을 이미 「5조각 과적재」로
// 세었고, 여섯 번째 조각을 얹는 것은 이름 붙은 결함을 키우는 것이다. 그리고
// 32pt 짜리가 13pt 글자 옆 흐름에 들어오면 머리 행이 한 줄만큼 자란다.
//
// 대신 시각 칸(`rowTime`)의 **거울**로 세운다: 그릇이 왼쪽을 예약하고, 아바타는
// 절대 배치로 그 칸에 앉는다. 세로 비용 0 이고, 한 묶음의 모든 행이 같은 x 에서
// 시작한다 — 시각 칸이 오른쪽에 대해 사 온 것과 같은 성질을 왼쪽에서 산다.
// =============================================================================

/**
 * 코어가 통과시킨 주소를 **이 기기가 실제로 실을 수 있는 주소**로.
 *
 * `null` 은 「이미지가 없다」이고, 그 자리는 언제나 폴백이 선다.
 */
export function avatarImageSource(
  identity: AvatarIdentity,
  base: string,
): string | null {
  const url = identity.imageUrl;
  if (url === null) return null;
  // 코어가 이미 `data:image/` 만 통과시켰다. 그대로 실린다.
  if (url.startsWith('data:')) return url;
  if (url.startsWith('/')) return base === '' ? null : `${base}${url}`;
  // 남는 것은 이 서버의 절대 주소뿐 — 오리진 확인은 코어가 했다.
  return url;
}

/**
 * 한 사람(또는 에이전트)의 아바타.
 *
 * **보조기술에는 나가지 않는다.** 행은 접근성 원소 하나이고 그 라벨은 이미
 * 작성자 이름을 말한다 — 아바타는 눈으로 훑을 때의 표지이지 소리로 들을 것이
 * 아니다. 웹이 같은 이유로 `aria-hidden` 을 건다.
 */
export function Avatar({
  directory,
  memberId,
}: {
  directory: Directory;
  memberId: string;
}): React.JSX.Element {
  const identity = useMemo(
    () => avatarIdentity(memberFor(directory, memberId), apiBase()),
    [directory, memberId],
  );
  const source = avatarImageSource(identity, apiBase());
  const carriesColor = avatarCarriesIdentityColor(identity.kind);
  const round = AVATAR_SHAPE[identity.kind] === 'round';

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.box,
        round ? styles.round : styles.roundedSquare,
        !carriesColor && styles.unknown,
        carriesColor && identity.kind === 'agent' && styles.agent,
        carriesColor && identity.kind === 'human' && styles.human,
      ]}
      testID={`avatar-${identity.kind}`}>
      {source !== null ? (
        <Image
          source={{uri: source}}
          style={[styles.image, round ? styles.round : styles.roundedSquare]}
          testID="avatar-image"
        />
      ) : identity.fallback.kind === 'initial' ? (
        <Text
          style={[styles.initial, identity.kind === 'agent' && styles.initialAgent]}
          testID="avatar-initial">
          {identity.fallback.text}
        </Text>
      ) : (
        // 「모른다」에는 글자를 그리지 않는다. 코어가 이 갈래를 따로 둔 이유가
        // 그것이다 — uuid 첫 글자를 이니셜인 척 그리면 읽는 사람은 그것을
        // 이름으로 읽는다 (H-11 3번).
        null
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    // 겹치는 글자가 없도록 넘치는 이미지를 자른다.
    overflow: 'hidden',
  },
  /** 사람에게는 사진이 들어갈 자리이고, 원은 그 자리의 관례다. */
  round: {borderRadius: AVATAR_SIZE / 2},
  /**
   * 에이전트는 앞으로도 「얼굴」이 아니라 표식이다. 모양이 색과 **함께** 정체를
   * 나르므로, 색각 이상이 있는 사람에게도 구분이 남는다 (코어 `AVATAR_SHAPE`).
   */
  roundedSquare: {borderRadius: radius.md},
  human: {backgroundColor: color.surface},
  agent: {backgroundColor: color.agentSurface},
  /**
   * 모르는 작성자. 사람 쪽 **모양은 빌리되 정체 색은 안 쓴다** — 색까지 주면
   * 화면이 「이 사람은 사람이다」를 확인된 사실처럼 말하게 된다.
   * 채움 대신 테두리 하나: 자리는 지키되 아무것도 주장하지 않는다.
   */
  unknown: {borderWidth: 1, borderColor: color.border},
  image: {width: AVATAR_SIZE, height: AVATAR_SIZE},
  initial: {
    fontSize: font.label,
    fontWeight: '600',
    color: color.text,
    // 이니셜은 한 글자다 — 줄 상자를 선언해 상자 가운데에 앉힌다.
    lineHeight: font.label + space.xs,
  },
  initialAgent: {color: color.agent},
});
