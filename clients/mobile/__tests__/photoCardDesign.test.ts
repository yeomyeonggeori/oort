import {ds2Radius, TOUCH_TARGET} from '../src/design/tokens';
import {
  PHOTO_CARD,
  PHOTO_MORPH,
  photoCardSize,
  photoCellSize,
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
  it('모서리는 폰 반경 사다리의 한 칸이다(사다리 밖 값을 들이지 않았다)', () => {
    expect(Object.values(ds2Radius)).toContain(PHOTO_CARD.radius);
    // Buzz ≈32 에서 가장 가까운 칸이고, 그 차이는 카드 폭의 1% 아래다.
    const nearest = Object.values(ds2Radius)
      .filter(value => value < ds2Radius.pill)
      .reduce((best, value) => (Math.abs(value - 32) < Math.abs(best - 32) ? value : best));
    expect(PHOTO_CARD.radius).toBe(nearest);
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

  it('두 층의 구간이 짧게 겹친다 — 메뉴가 사라지기 전에 사진이 서기 시작하되 오래 겹치지 않는다', () => {
    const [menuFrom, menuTo] = PHOTO_MORPH.menuFade;
    const [cardFrom, cardTo] = PHOTO_MORPH.cardFade;
    expect(menuFrom).toBeGreaterThanOrEqual(0);
    expect(cardTo).toBeLessThanOrEqual(1);
    expect(cardFrom).toBeLessThan(menuTo);
    expect(menuTo - cardFrom).toBeLessThanOrEqual(0.2);
    expect(cardTo).toBeGreaterThan(menuTo);
    expect(PHOTO_MORPH.menuEndScale).toBeGreaterThan(0);
    expect(PHOTO_MORPH.menuEndScale).toBeLessThan(1);
    expect(PHOTO_MORPH.cardStartScale).toBeGreaterThan(0.8);
    expect(PHOTO_MORPH.cardStartScale).toBeLessThan(1);
  });
});
