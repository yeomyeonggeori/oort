import React, {useState} from 'react';
import {
  AccessibilityInfo,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  resolvePreset,
  resolveSignal,
  SIGNAL_ADJUSTED_COPY,
  SIGNAL_PRESET_IDS,
  SIGNAL_PRESETS,
  SIGNAL_REJECTION_COPY,
  type SignalPresetId,
} from '@momo/core/design/signal';
import {contrast} from '@momo/core/design/color';
import {GroupRow, OutlineButton, Sentence} from './atoms';
import {
  BACKGROUND_FALLBACK_COPY,
  NO_BACKGROUND,
  PRESET_IDS,
  PRESETS,
  SOLID_IDS,
  SOLIDS,
  type PresetId,
  type SolidId,
} from './background/model';
import {IMPORT_FAILURE_COPY, type PhotoPorts} from './background/photo';
import {backgroundPhotoUri, chooseBackgroundPhoto} from './background/store';
import {THEMES, THEME_IDS, type ThemeId} from './ds2Tokens';
import {
  normalizeCustomHex,
  THEME_CHOICES,
  themeChoiceLabel,
  themeIdLabel,
  usePalette,
  useStyles,
  useTheme,
  type ThemeChoice,
} from './theme';
import {ds2Radius, font, radius, space, type Palette} from './tokens';

// =============================================================================
// 「테마」 — 폰에서 스킴을 고르는 유일한 자리 (U2 → #2702).
//
// ## 어디에 서는가
//
// 프로필 시트의 「테마 ›」 줄이 여는 한 장이다(#2702). U2 에서는 대화 목록 발치의
// 세그먼트 세 칸이었는데, 성재가 그 발치를 「UI랑 UX가 너무 구리다」고 짚었다:
// 목록 아래에 계정·로그아웃·테마가 붙박여 목록을 가리고, 한 번 고르면 다시 볼
// 일이 없는 설정이 매일 보는 화면의 한 줄을 차지하고 있었다. 설정 화면은 여전히
// 폰에 없다(ADR-0137 D5) — 이것은 새 화면이 아니라 내 계정 시트 안의 한 장이다.
//
// ## 세 값이고 두 값이 아니다
//
// 토글(라이트↔다크)로 만들면 「시스템을 따른다」를 표현할 방법이 사라진다. 그것이
// 기본값이자 대부분의 사람이 원하는 상태이므로, 토글은 첫 탭에서 그 상태를 **잃게**
// 만든다. 웹 설정(`clients/web/src/features/settings/AppearanceSection.tsx`)도
// 같은 이유로 세 값이고, 값 이름(system/light/dark)과 기본값이 두 클라에서 같다.
// 「시스템」 줄은 그 칸이 **지금** 무엇을 뜻하는지를 설명 줄로 적는다 — 웹이
// 설명 줄에 적는 그 문장이고, 보조기술에게는 힌트로도 간다.
//
// ## 라디오지 탭이 아니다
//
// 세 줄은 서로 배타적인 **설정값**이지 세 개의 장소가 아니다. `radio` +
// `radiogroup` 은 "선택됨"과 "3개 중"을 함께 읽고, 그것이 이 컨트롤이 실제로
// 하는 일이다. 고른 줄은 체크 표시·글자색·굵기 **셋**이 함께 바뀐다 — 체크 하나만
// 바꾸면 손가락이 그것을 덮는 동안 신호가 없다.
// =============================================================================

// =============================================================================
// 테마와 강조색 (#2719 · ADR-0189 D3 · 성재 2026-10-16 「열기 (추천)」).
//
// 세 묶음이다: 화면 모드(시스템·라이트·다크) / 테마(새벽하늘·흑연·노을띠) / 강조색
// (기본·프리셋 4종·직접 입력). 미리보기는 따로 그리지 않는다 — 고르는 순간 프로바이더가
// 앱 전체를 다시 칠하므로 지금 보고 있는 이 화면이 곧 미리보기다. 테마 타일과
// 강조색 점은 **다른 선택지의 모습**을 보이려는 것이고, 그 값은 core 표에서 읽는다.
//
// 강조색은 `signal` 네 값만 바꾼다. 주 버튼(잉크)은 그대로다(D3 「주 버튼 검정」).
// 직접 입력은 core 규칙을 그대로 따른다 — 보정되면 「대비를 위해 조정됨」, 이 테마에서
// 읽기 쉬운 대비를 만들 수 없거나 에이전트·오류색과 너무 가까우면 거절하고 이유를 한
// 줄로 말한다. 거절된 입력은 저장하지 않는다.
// =============================================================================


export function ThemeControl({
  photoPorts,
}: {
  /** 시험이 사진 고르기·줄이기를 바꿔 끼우는 자리. 앱은 넘기지 않는다. */
  photoPorts?: PhotoPorts;
}): React.JSX.Element {
  return (
    <View style={buildLayout.root} testID="appearance-control">
      <SchemeGroup />
      <ThemeGroup />
      <SignalGroup />
      <BackgroundGroup photoPorts={photoPorts} />
    </View>
  );
}

const buildLayout = StyleSheet.create({root: {gap: space.lg}});

/** 머리글 + 내용. 시트가 이미 좌우 여백을 주므로 `GroupSection` 의 거터는 쓰지 않는다. */
function GroupSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionLabel}>
        {label}
      </Text>
      {children}
    </View>
  );
}

function SchemeGroup(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {choice, systemScheme, setChoice} = useTheme();
  // **`scheme` 이 아니라 `systemScheme` 이다** (U2 리뷰 H-1). 풀린 스킴으로 이
  // 문장을 만들면 다크를 **고른** 동안에는 시스템이 라이트여도 「시스템은
  // 다크입니다」라고 말한다 — 이 문장이 있는 이유가 「고르지 않으면 무엇이
  // 되는가」인데, 고른 사람에게 그 답을 자기 선택으로 되돌려 주는 거짓말이 된다.
  const systemNow = `지금 이 기기의 시스템은 ${systemScheme === 'dark' ? '다크' : '라이트'}예요.`;
  return (
    <GroupSection label="화면 모드">
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="화면 모드"
        style={styles.card}
        testID="theme-control">
        {THEME_CHOICES.map((value, index) => (
          <Choice
            key={value}
            value={value}
            selected={value === choice}
            separated={index > 0}
            onSelect={setChoice}
            detail={value === 'system' ? systemNow : undefined}
          />
        ))}
      </View>
    </GroupSection>
  );
}

function Choice({
  value,
  selected,
  separated,
  onSelect,
  detail,
}: {
  value: ThemeChoice;
  selected: boolean;
  separated: boolean;
  onSelect: (choice: ThemeChoice) => void;
  detail?: string;
}): React.JSX.Element {
  return (
    <GroupRow
      title={themeChoiceLabel(value)}
      detail={detail}
      tone={selected ? 'accent' : 'default'}
      separated={separated}
      onPress={() => onSelect(value)}
      accessibilityRole="radio"
      accessibilityState={{selected}}
      accessibilityLabel={themeChoiceLabel(value)}
      accessibilityHint={detail}
      trailing={<Check selected={selected} testID={`theme-${value}-check`} />}
      testID={`theme-${value}`}
    />
  );
}

function Check({selected, testID}: {selected: boolean; testID: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Text
      style={[styles.check, !selected && styles.checkHidden]}
      importantForAccessibility="no"
      testID={selected ? testID : undefined}>
      ✓
    </Text>
  );
}

// ---- 테마 --------------------------------------------------------------------

/**
 * 한 테마를 **라이트·다크 두 반쪽**으로 보이는 작은 타일: 반쪽마다 바닥 세 정지점, 표면
 * 조각, 신호 점. 현재 모드만 그리면 다크에서 새벽하늘과 노을띠가 거의 같아 보인다(리뷰
 * M-1) — 두 반쪽이 있으면 모드를 바꾸지 않고도 테마의 차이가 보인다(웹 증보 1 D3 의 쌍
 * 미리보기와 같은 뜻).
 */
function ThemeSwatch({id}: {id: ThemeId}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.swatch}
      testID={`appearance-swatch-${id}`}>
      {(['light', 'dark'] as const).map(mode => {
        const t = THEMES[id][mode];
        const [top, mid, bottom] = t.canvas;
        return (
          <View
            key={mode}
            style={[
              styles.swatchHalf,
              {
                experimental_backgroundImage: `linear-gradient(180deg, ${top} 0%, ${mid} 50%, ${bottom} 100%)`,
              },
            ]}
            testID={`appearance-swatch-${id}-${mode}`}>
            <View style={[styles.swatchSurface, {backgroundColor: t.color.surface}]} />
            <View style={[styles.swatchDot, {backgroundColor: t.color.signal}]} />
          </View>
        );
      })}
    </View>
  );
}

/** 노을띠의 남색 띠는 폰에서 그리지 않는다(ADR-0189 증보 1 「폰 구현」). 고르는 사람이 알도록 말한다. */
const THEME_DETAIL: Partial<Record<ThemeId, string>> = {
  noeul: '폰에서는 남색 띠 없이 평평한 바닥으로 보여요.',
};

function ThemeGroup(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {themeId, setTheme} = useTheme();
  return (
    <GroupSection label="테마">
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="테마"
        style={styles.card}
        testID="appearance-theme-group">
        {THEME_IDS.map((id, index) => {
          const selected = id === themeId;
          return (
            <GroupRow
              key={id}
              title={themeIdLabel(id)}
              detail={THEME_DETAIL[id]}
              tone={selected ? 'accent' : 'default'}
              separated={index > 0}
              onPress={() => setTheme(id)}
              accessibilityRole="radio"
              accessibilityState={{selected}}
              accessibilityLabel={themeIdLabel(id)}
              leading={<ThemeSwatch id={id} />}
              trailing={<Check selected={selected} testID={`appearance-theme-${id}-check`} />}
              testID={`appearance-theme-${id}`}
            />
          );
        })}
      </View>
    </GroupSection>
  );
}

// ---- 강조색 ------------------------------------------------------------------

function Dot({color, testID}: {color: string; testID: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.dot, {backgroundColor: color}]}
      testID={testID}
    />
  );
}

function SignalGroup(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const {themeId, scheme, signal, signalState, setSignal} = useTheme();
  const [draft, setDraft] = useState(signal && 'custom' in signal ? signal.custom : '');
  // 직접 입력이 **거절된** 이유(저장하지 않았다). 보정 안내는 저장된 상태에서 읽는다.
  const [error, setError] = useState<string | null>(null);

  const usingDefault = signal == null;
  const presetId = signal && 'preset' in signal ? signal.preset : null;
  const custom = signal && 'custom' in signal;

  const apply = () => {
    const hex = normalizeCustomHex(draft);
    if (hex == null) {
      reject(SIGNAL_REJECTION_COPY['invalid-hex']);
      return;
    }
    const result = resolveSignal(hex, themeId, scheme);
    if (!result.ok) {
      reject(result.message);
      return;
    }
    setDraft(hex);
    setError(null);
    setSignal({custom: hex});
  };

  /** 눈으로도 귀로도 알린다 — VoiceOver 는 화면에 새로 생긴 글을 스스로 읽지 않는다. */
  const reject = (message: string) => {
    setError(message);
    AccessibilityInfo.announceForAccessibility?.(message);
  };

  const pick = (next: SignalPresetId | null) => {
    setError(null);
    setSignal(next == null ? null : {preset: next});
  };

  // 지금 테마·모드에서 저장된 선택이 거절돼 기본 신호로 그려지는 경우(다른 테마에서
  // 고른 hex). 입력 칸의 알림과 달리 **상태**이므로 항상 보인다.
  const standing =
    signalState.kind === 'rejected'
      ? `이 테마에서는 고른 강조색을 쓸 수 없어 기본 색으로 보여요. ${signalState.message}`
      : null;
  // 보정 안내는 입력 바로 아래 **한 곳**에 둔다. 저장된 상태에서 읽으므로 다시 열어도 남는다.
  const adjusted = signalState.kind === 'custom' && signalState.adjusted ? SIGNAL_ADJUSTED_COPY : null;
  const notice = error ?? adjusted;

  return (
    <GroupSection label="강조색">
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="강조색"
        style={styles.card}
        testID="appearance-signal-group">
        <GroupRow
          title="기본"
          tone={usingDefault ? 'accent' : 'default'}
          onPress={() => pick(null)}
          accessibilityRole="radio"
          accessibilityState={{selected: usingDefault}}
          accessibilityLabel="기본, 강조색"
          leading={<Dot color={THEMES[themeId][scheme].color.signal} testID="appearance-dot-default" />}
          trailing={<Check selected={usingDefault} testID="appearance-signal-default-check" />}
          testID="appearance-signal-default"
        />
        {SIGNAL_PRESET_IDS.map(id => {
          const selected = presetId === id;
          const solved = resolvePreset(id, themeId, scheme);
          return (
            <GroupRow
              key={id}
              title={SIGNAL_PRESETS[id].label}
              tone={selected ? 'accent' : 'default'}
              separated
              onPress={() => pick(id)}
              accessibilityRole="radio"
              accessibilityState={{selected}}
              accessibilityLabel={`${SIGNAL_PRESETS[id].label}, 강조색`}
              leading={
                <Dot
                  color={solved.ok ? solved.values.signal : SIGNAL_PRESETS[id][scheme]}
                  testID={`appearance-dot-${id}`}
                />
              }
              trailing={<Check selected={selected} testID={`appearance-signal-${id}-check`} />}
              testID={`appearance-signal-${id}`}
            />
          );
        })}
      </View>

      <View style={[styles.card, styles.customCard]} testID="appearance-signal-custom">
        <View style={styles.customHead}>
          <Text style={[styles.customLabel, custom && styles.customLabelSelected]}>직접 입력</Text>
          <Check selected={!!custom} testID="appearance-signal-custom-check" />
        </View>
        <View style={styles.customRow}>
          <TextInput
            value={draft}
            onChangeText={text => {
              setDraft(text);
              setError(null);
            }}
            onSubmitEditing={apply}
            placeholder="#RRGGBB"
            placeholderTextColor={palette.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={7}
            returnKeyType="done"
            accessibilityLabel={custom ? '강조색 직접 입력, 사용 중, 여섯 자리 색 코드' : '강조색 직접 입력, 여섯 자리 색 코드'}
            style={[styles.input, custom && styles.inputSelected, error != null && styles.inputError]}
            testID="appearance-signal-input"
          />
          <OutlineButton label="적용" onPress={apply} testID="appearance-signal-apply" />
        </View>
        {notice ? (
          <Sentence
            style={[styles.notice, error != null && styles.noticeError]}
            accessibilityLiveRegion="polite"
            testID="appearance-signal-notice">
            {notice}
          </Sentence>
        ) : null}
      </View>

      <Preview />
      {standing ? (
        <Sentence style={styles.caption} testID="appearance-signal-state">
          {standing}
        </Sentence>
      ) : null}
    </GroupSection>
  );
}

// ---- 배경 (ADR-0189 증보 2 · 성재 2026-10-16 「내 사진까지」) -------------------------

/** 단색 위의 ✓ — 팔레트의 두 잉크 가운데 그 색 위 대비가 큰 쪽. 하드코딩한 흰색이 아니다. */
function checkInkOn(hex: string, palette: Palette): string {
  return contrast(palette.onPrimary, hex) >= contrast(palette.text, hex)
    ? palette.onPrimary
    : palette.text;
}

function BackgroundGroup({photoPorts}: {photoPorts?: PhotoPorts}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const {background, backgroundFallback, setBackground} = useTheme();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const none = background.kind === 'none';
  const pickSolid = (id: SolidId) => {
    setNotice(null);
    setBackground({kind: 'solid', id});
  };
  const pickPreset = (id: PresetId) => {
    setNotice(null);
    setBackground({kind: 'preset', id});
  };
  const pickPhoto = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await chooseBackgroundPhoto(photoPorts);
      if (!outcome.ok) setNotice(IMPORT_FAILURE_COPY[outcome.reason]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <GroupSection label="배경">
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="배경"
        style={styles.card}
        testID="appearance-background-group">
        <GroupRow
          title="기본"
          detail="테마의 바닥 그대로예요."
          tone={none ? 'accent' : 'default'}
          onPress={() => {
            setNotice(null);
            setBackground(NO_BACKGROUND);
          }}
          accessibilityRole="radio"
          accessibilityState={{selected: none}}
          accessibilityLabel="배경 기본"
          trailing={<Check selected={none} testID="appearance-background-none-check" />}
          testID="appearance-background-none"
        />
        <View style={styles.bgBlock}>
          <Text style={styles.customLabel}>단색</Text>
          <View style={styles.bgSolids}>
            {SOLID_IDS.map(id => {
              const selected = background.kind === 'solid' && background.id === id;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="radio"
                  accessibilityState={{selected}}
                  accessibilityLabel={`배경 단색 ${SOLIDS[id].label}`}
                  onPress={() => pickSolid(id)}
                  style={[
                    styles.solid,
                    {backgroundColor: SOLIDS[id].hex},
                    selected && styles.solidSelected,
                  ]}
                  testID={`appearance-background-solid-${id}`}>
                  {selected ? (
                    <Text style={[styles.solidCheck, {color: checkInkOn(SOLIDS[id].hex, palette)}]}>
                      ✓
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>
        <View style={styles.bgBlock}>
          <Text style={styles.customLabel}>기본 제공</Text>
          <View style={styles.bgPresets}>
            {PRESET_IDS.map(id => {
              const selected = background.kind === 'preset' && background.id === id;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="radio"
                  accessibilityState={{selected}}
                  accessibilityLabel={`배경 ${PRESETS[id].label}`}
                  onPress={() => pickPreset(id)}
                  style={styles.presetCell}
                  testID={`appearance-background-preset-${id}`}>
                  <View
                    style={[
                      styles.presetTile,
                      {
                        backgroundColor: PRESETS[id].fallback,
                        experimental_backgroundImage: PRESETS[id].gradient,
                      },
                      selected && styles.solidSelected,
                    ]}
                  />
                  <Text style={[styles.presetLabel, selected && styles.presetLabelSelected]}>
                    {PRESETS[id].label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <GroupRow
          title="내 사진"
          detail={busy ? '사진을 줄이는 중이에요…' : '이 기기에만 저장되고 서버로 올라가지 않아요.'}
          tone={background.kind === 'photo' ? 'accent' : 'default'}
          separated
          disabled={busy}
          onPress={pickPhoto}
          accessibilityRole="radio"
          accessibilityState={{selected: background.kind === 'photo', disabled: busy}}
          accessibilityLabel={
            background.kind === 'photo' ? '배경 내 사진, 다시 고르기' : '배경 내 사진 고르기'
          }
          leading={
            background.kind === 'photo' ? (
              <Image
                source={{uri: backgroundPhotoUri(background.file)}}
                style={styles.photoThumb}
                accessible={false}
                testID="appearance-background-photo-thumb"
              />
            ) : undefined
          }
          trailing={
            <Check
              selected={background.kind === 'photo'}
              testID="appearance-background-photo-check"
            />
          }
          testID="appearance-background-photo"
        />
      </View>

      {backgroundFallback ? (
        <Sentence style={styles.caption} testID="appearance-background-fallback">
          {BACKGROUND_FALLBACK_COPY[backgroundFallback]}
        </Sentence>
      ) : null}
      {notice ? (
        <Sentence style={styles.caption} testID="appearance-background-notice">
          {notice}
        </Sentence>
      ) : null}
      <Sentence style={styles.caption}>
        글자가 읽히도록 배경 위에 반투명 면이 깔려요. 그래서 사진이 조금 흐리게 보여요.
      </Sentence>
      {!none ? (
        <View style={styles.reset}>
          <OutlineButton
            label="기본으로"
            onPress={() => {
              setNotice(null);
              setBackground(NO_BACKGROUND);
            }}
            testID="appearance-background-reset"
          />
        </View>
      ) : null}
    </GroupSection>
  );
}

/** 고른 강조색이 쓰이는 세 자리를 한 줄로. 앱 전체가 곧 미리보기이므로 이것은 요약이다. */
function Preview(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.preview} testID="appearance-preview">
      <View style={styles.previewFill}>
        <Text style={styles.previewFillText}>안 읽음</Text>
      </View>
      <View style={styles.previewSoft}>
        <Text style={styles.previewSoftText}>내가 참여했어요</Text>
      </View>
      <Text style={styles.previewLink}>링크</Text>
    </View>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  section: {gap: space.sm},
  sectionLabel: {
    fontSize: font.label,
    color: color.textMuted,
    fontWeight: '600',
    paddingHorizontal: space.xs,
  },
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  check: {
    fontSize: font.body,
    fontWeight: '700',
    color: color.accentText,
    minWidth: space.lg,
    textAlign: 'center',
  },
  // 자리는 지킨다 — 고른 줄이 바뀔 때 글자가 옆으로 움찔하지 않게.
  checkHidden: {opacity: 0},
  swatch: {
    width: 44,
    height: 36,
    flexDirection: 'row',
    borderRadius: ds2Radius.badge,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    overflow: 'hidden',
  },
  swatchHalf: {flex: 1},
  swatchSurface: {
    position: 'absolute',
    left: 3,
    right: 3,
    bottom: 4,
    height: 11,
    borderRadius: radius.sm,
  },
  swatchDot: {
    position: 'absolute',
    top: 5,
    right: 4,
    width: 7,
    height: 7,
    borderRadius: radius.pill,
  },
  dot: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  customCard: {
    marginTop: space.md,
    padding: space.md,
    gap: space.sm,
  },
  customHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  customLabel: {
    fontSize: font.label,
    fontWeight: '600',
    color: color.textMuted,
  },
  customLabelSelected: {color: color.accentText, fontWeight: '700'},
  customRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  input: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: ds2Radius.row,
    borderWidth: 1,
    borderColor: color.textFaint,
    backgroundColor: color.surfaceMuted,
    color: color.text,
    fontSize: font.body,
    fontFamily: 'Menlo',
  },
  inputSelected: {borderColor: color.accent},
  inputError: {borderColor: color.danger},
  notice: {fontSize: font.meta, color: color.textMuted},
  noticeError: {color: color.dangerText, fontWeight: '600'},
  caption: {
    marginTop: space.sm,
    fontSize: font.meta,
    color: color.textMuted,
  },
  preview: {
    marginTop: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  bgBlock: {
    padding: space.md,
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  bgSolids: {flexDirection: 'row', flexWrap: 'wrap', gap: space.md},
  solid: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  solidSelected: {borderWidth: 3, borderColor: color.accent},
  solidCheck: {fontSize: font.body, fontWeight: '700'},
  bgPresets: {flexDirection: 'row', flexWrap: 'wrap', gap: space.md},
  presetCell: {width: 96, gap: space.xs},
  presetTile: {
    width: 96,
    height: 64,
    borderRadius: ds2Radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  presetLabel: {fontSize: font.meta, color: color.textMuted, textAlign: 'center'},
  presetLabelSelected: {color: color.accentText, fontWeight: '600'},
  photoThumb: {width: 36, height: 36, borderRadius: ds2Radius.badge},
  reset: {marginTop: space.sm, alignItems: 'flex-start'},
  previewFill: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: ds2Radius.badge,
    backgroundColor: color.accent,
  },
  previewFillText: {fontSize: font.caption, fontWeight: '600', color: color.onAccent},
  previewSoft: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: ds2Radius.badge,
    backgroundColor: color.accentSurface,
  },
  previewSoftText: {fontSize: font.caption, fontWeight: '600', color: color.accentText},
  previewLink: {fontSize: font.label, fontWeight: '600', color: color.accentText},
});
