import {formRevealOffset} from '../src/lib/formReveal';

// =============================================================================
// `formRevealOffset` — 포커스한 칸(과 들어갈 때는 주 버튼)을 창에 넣는 오프셋 (#2678)
//
// 값은 iPhone 13 mini 기본 크기에서 잰 연결 화면이다(콘텐츠 좌표): 이메일 행 301–364,
// 비밀번호 행 381–444, 로그인 버튼 461–505, 키보드가 줄인 창 418, 여백 16.
// =============================================================================

const EMAIL = {top: 301, bottom: 364};
const PASSWORD = {top: 381, bottom: 444};
const ACTION = {top: 461, bottom: 505};

describe('formRevealOffset', () => {
  it('칸과 버튼이 함께 들면, 버튼 아래 여백까지 들도록 가장 적게 굴린다', () => {
    // 오프셋 0 에서 버튼 아래(505 + 16)는 창(418) 밖이다 → 521 − 418 = 103.
    expect(
      formRevealOffset({viewport: 418, offset: 0, field: EMAIL, action: ACTION, margin: 16}),
    ).toBe(103);
  });

  it('이미 다 보이면 굴리지 않는다 — 다음 칸으로 옮겨도 목록이 흔들리지 않는다', () => {
    expect(
      formRevealOffset({viewport: 418, offset: 103, field: PASSWORD, action: ACTION, margin: 16}),
    ).toBeNull();
  });

  it('칸이 창 위로 나가 있으면 칸의 윗변(여백 포함)까지만 되돌린다', () => {
    // 버튼에서 막혀 주소 칸으로 포커스가 돌아온 경우 — 칸 167–254, 창 418.
    expect(
      formRevealOffset({
        viewport: 418,
        offset: 180,
        field: {top: 167, bottom: 254},
        action: ACTION,
        margin: 16,
      }),
    ).toBe(151);
  });

  it('칸과 버튼이 함께 들지 않으면 칸을 창 맨 위에 둔다 — 버튼보다 칸이 먼저다', () => {
    // AX5 이메일: 행 926–1072, 버튼 1252–1333, 창 418 — 합치면 439 로 창보다 길다.
    expect(
      formRevealOffset({
        viewport: 418,
        offset: 460,
        field: {top: 926, bottom: 1072},
        action: {top: 1252, bottom: 1333},
        margin: 16,
      }),
    ).toBe(910);
  });

  it('버튼이 칸보다 위에 있으면 칸만 본다', () => {
    expect(
      formRevealOffset({
        viewport: 200,
        offset: 0,
        field: {top: 400, bottom: 460},
        action: {top: 100, bottom: 140},
        margin: 16,
      }),
    ).toBe(276);
  });

  it('창을 아직 재지 않았거나 포커스한 칸의 자리를 모르면 아무것도 하지 않는다', () => {
    expect(
      formRevealOffset({viewport: 0, offset: 0, field: EMAIL, action: ACTION, margin: 16}),
    ).toBeNull();
    expect(
      formRevealOffset({viewport: 418, offset: 0, field: undefined, action: ACTION, margin: 16}),
    ).toBeNull();
  });

  it('맨 위의 칸은 0 에서 멈춘다', () => {
    expect(
      formRevealOffset({
        viewport: 300,
        offset: 40,
        field: {top: 8, bottom: 60},
        margin: 16,
      }),
    ).toBe(0);
  });
});
