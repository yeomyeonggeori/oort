import {TOUCH_TARGET} from '../src/design/tokens';
import {ATTACH_MENU} from '../src/features/attachments/AttachMenu';
import {
  PHOTO_CARD,
  PHOTO_MORPH,
  photoCardSize,
  photoCellSize,
  scrollNeedsHint,
} from '../src/features/attachments/photoCardDesign';

// =============================================================================
// 사진 카드의 치수 (#4181) — 웹에 짝이 없는 폰 값은 「그 값이 지키는 관계」를 단정한다
// (docs/design-system/README.md §6 「폰에 값을 더할 때」). 값 하나를 복사해 적는 시험은
// 값이 움직이는 날 같이 움직이므로 관계로 쓴다.
// =============================================================================

describe('Buzz 실측 대비 — 402×874(iPhone 17 Pro)에서', () => {
  const size = photoCardSize({width: 402, height: 874});

  it('카드 폭은 좌우 10 을 뺀 382 이고 Buzz 실측과 같다', () => {
    expect(size.width).toBe(402 - 2 * PHOTO_CARD.inset);
    expect(size.width).toBe(382);
  });

  it('카드 높이는 Buzz 372 의 ±2% 안이다(화면 높이의 ≈43%)', () => {
    expect(Math.abs(size.height - 372) / 372).toBeLessThan(0.02);
  });

  it('열 수와 틈은 Buzz 의 3열·1pt 이고, 세 칸과 두 틈이 카드 폭을 정확히 채운다', () => {
    expect(PHOTO_CARD.columns).toBe(3);
    expect(PHOTO_CARD.cellGap).toBe(1);
    const cell = photoCellSize(size.width);
    expect(cell * PHOTO_CARD.columns + PHOTO_CARD.cellGap * (PHOTO_CARD.columns - 1)).toBeCloseTo(
      size.width,
      6,
    );
  });
});

describe('관계 — 값이 아니라 값이 지키는 것', () => {
  it('모서리는 메뉴 카드와 같은 값이다 — 변신 동안 모서리가 두 값 사이를 오가지 않는다', () => {
    expect(PHOTO_CARD.radius).toBe(ATTACH_MENU.radius);
    // Buzz 카드 눈대중 ≈32 와의 차이는 카드 폭의 1% 안이다.
    expect(Math.abs(32 - PHOTO_CARD.radius) / 382).toBeLessThan(0.01);
  });

  it('뒤로 원과 알약의 높이는 터치 최소와 같다(손으로 적은 44 가 아니다)', () => {
    expect(PHOTO_CARD.control).toBe(TOUCH_TARGET);
  });

  it('선택 표식은 사진 모서리 안에 앉고, 셀 전체가 눌림 대상이라 44 일 필요가 없다', () => {
    const cell = photoCellSize(photoCardSize({width: 402, height: 874}).width);
    expect(PHOTO_CARD.badge + 2 * PHOTO_CARD.badgeInset).toBeLessThan(cell);
    expect(cell).toBeGreaterThanOrEqual(TOUCH_TARGET);
  });

  it('작은 화면(375×667)에서도 카드가 두 줄 반 이상 보인다', () => {
    const small = photoCardSize({width: 375, height: 667});
    const cell = photoCellSize(small.width);
    expect(small.height).toBe(PHOTO_CARD.minHeight);
    expect(small.height / (cell + PHOTO_CARD.cellGap)).toBeGreaterThanOrEqual(2.5);
  });

  it('아주 넓은 창(iPad 가로)에서는 카드 폭이 maxWidth 에서 멈춘다 — 폰 폭은 그대로다', () => {
    expect(photoCardSize({width: 1024, height: 768}).width).toBe(PHOTO_CARD.maxWidth);
    expect(photoCardSize({width: 402, height: 874}).width).toBe(402 - 2 * PHOTO_CARD.inset);
    expect(photoCardSize({width: 440, height: 956}).width).toBe(440 - 2 * PHOTO_CARD.inset);
    // 셀은 정사각형이라 폭 상한이 곧 셀 상한이다 — 한 줄만 보이는 거대 카드가 되지 않는다.
    const wide = photoCardSize({width: 1024, height: 768});
    expect(wide.height / photoCellSize(wide.width)).toBeGreaterThan(1.5);
  });

  it('글자 배율이 커지면 카드가 그만큼 자란다(상한 안에서) — 줄이지는 않는다', () => {
    const se = {width: 375, height: 667};
    const base = photoCardSize(se).height;
    // 배율 1 이하는 그대로다.
    expect(photoCardSize({...se, fontScale: 1}).height).toBe(base);
    expect(photoCardSize({...se, fontScale: 0.8}).height).toBe(base);
    // 1.3 배면 1.3 배(상한 460 안).
    expect(photoCardSize({...se, fontScale: 1.3}).height).toBe(Math.round(667 * PHOTO_CARD.heightRatio * 1.3));
    // AX5(3.12)는 `textGrowthMax` 에서 멈추고, 그 값은 maxHeight 안이다.
    const ax5 = photoCardSize({...se, fontScale: 3.12}).height;
    expect(ax5).toBe(Math.min(PHOTO_CARD.maxHeight, Math.round(667 * PHOTO_CARD.heightRatio * PHOTO_CARD.textGrowthMax)));
    expect(ax5).toBeGreaterThan(base);
    expect(ax5).toBeLessThanOrEqual(PHOTO_CARD.maxHeight);
  });

  it('큰 화면에서는 글자가 커져도 카드가 maxHeight 에서 멈춘다', () => {
    expect(photoCardSize({width: 402, height: 874, fontScale: 3.12}).height).toBe(PHOTO_CARD.maxHeight);
  });

  it('스크롤 힌트: 내용이 면보다 길 때만 알린다(면 높이를 알기 전에는 알리지 않는다)', () => {
    expect(scrollNeedsHint(300, 200)).toBe(true);
    expect(scrollNeedsHint(200, 200)).toBe(false);
    expect(scrollNeedsHint(200.5, 200)).toBe(false); // 반올림 오차
    expect(scrollNeedsHint(500, 0)).toBe(false); // 아직 재지 못했다
  });

  it('큰 화면에서는 카드가 상한에서 멈춘다', () => {
    expect(photoCardSize({width: 820, height: 1180}).height).toBe(PHOTO_CARD.maxHeight);
  });
});

describe('변신 스프링 — 「겉보기 250~350ms, 넘침 거의 없음」', () => {
  const {stiffness, damping, mass} = PHOTO_MORPH.spring;
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  it('감쇠비가 임계에 가깝다(넘침이 눈에 안 보인다)', () => {
    expect(zeta).toBeGreaterThanOrEqual(0.85);
    expect(zeta).toBeLessThanOrEqual(1);
    // 넘침 비율 exp(−πζ/√(1−ζ²)) 은 0.5% 아래다.
    const overshoot = Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));
    expect(overshoot).toBeLessThan(0.005);
  });

  it('2% 정착 시간 4/(ζω) 가 250~350ms 안이다', () => {
    const settle = 4 / (zeta * omega);
    expect(settle).toBeGreaterThan(0.2);
    expect(settle).toBeLessThanOrEqual(0.35);
  });

  it('변신의 어느 진행에서도 틀 안이 막혀 있다 — 몸통 + 메뉴 + 사진 층의 합성 불투명도가 1 이다', () => {
    const [menuFrom, menuTo] = PHOTO_MORPH.menuFade;
    const [cardFrom, cardTo] = PHOTO_MORPH.cardFade;
    const [bodyFrom, bodyTo] = PHOTO_MORPH.bodyFade;
    const ramp = (p: number, from: number, to: number) => Math.min(1, Math.max(0, (p - from) / (to - from)));
    for (let step = 0; step <= 200; step += 1) {
      const p = step / 200;
      const body = ramp(p, bodyFrom, bodyTo);
      const menu = 1 - ramp(p, menuFrom, menuTo);
      const card = ramp(p, cardFrom, cardTo);
      // 알파 합성: 몸통이 아직 다 안 섰으면 메뉴가 발자국을 덮고(메뉴는 아직 불투명), 메뉴가 줄기 시작하면
      // 몸통이 이미 다 서 있다. 그 사이에 비치는 구멍이 없다.
      const coverage = 1 - (1 - body) * (1 - menu) * (1 - card);
      expect(coverage).toBeGreaterThanOrEqual(0.999);
    }
  });

  it('몸통은 틀이 메뉴 발자국을 벗어나 자라기 전에 이미 막혀 있다(발자국 밖 띠로 뒤 대화가 비치지 않는다)', () => {
    const [bodyFrom, bodyTo] = PHOTO_MORPH.bodyFade;
    const [menuFrom] = PHOTO_MORPH.menuFade;
    // 진행 0 의 틀은 메뉴와 같다 — 몸통이 메뉴의 유리를 덮지 않는다.
    expect(bodyFrom).toBe(0);
    // 메뉴가 줄기 시작하기 전에 몸통이 다 올라온다.
    expect(bodyTo).toBeLessThanOrEqual(menuFrom);
    expect(bodyTo).toBeGreaterThan(bodyFrom);
  });

  it('메뉴가 먼저 걷히고 사진이 이어 선다 — 두 층이 겹치는 구간이 짧다(글자가 글자 위에 겹쳐 뭉개지지 않는다)', () => {
    const [menuFrom, menuTo] = PHOTO_MORPH.menuFade;
    const [cardFrom, cardTo] = PHOTO_MORPH.cardFade;
    // 메뉴가 먼저 시작하고 먼저 끝난다.
    expect(menuFrom).toBeLessThan(cardFrom);
    expect(menuTo).toBeLessThan(cardTo);
    // 사진 층은 메뉴 층이 걷히기 전에 시작할 수 있되, 겹침은 진행의 20% 안이다.
    const overlap = Math.max(0, Math.min(menuTo, cardTo) - Math.max(menuFrom, cardFrom));
    expect(overlap).toBeLessThanOrEqual(0.2);
    expect(cardTo).toBeLessThanOrEqual(1);
    expect(PHOTO_MORPH.menuEndScale).toBeGreaterThan(0);
    expect(PHOTO_MORPH.menuEndScale).toBeLessThan(1);
    expect(PHOTO_MORPH.cardStartScale).toBeGreaterThan(0.8);
    expect(PHOTO_MORPH.cardStartScale).toBeLessThan(1);
  });
});
