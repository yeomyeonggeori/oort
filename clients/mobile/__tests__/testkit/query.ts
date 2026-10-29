import {fireEvent, screen} from '@testing-library/react-native';

/**
 * 화면의 것을 **접근성 역할·레이블**로 찾는 길.
 *
 * 한국어 문장을 시험에 그대로 박아 두면(이 트리에는 그런 단정이 1,276줄이다) 문장이 바뀔 때,
 * 그리고 7개 언어(#4240)로 넘어갈 때 한꺼번에 깨진다. 사람이 화면을 쓰는 방식은 「이름이 X 인
 * 버튼」이지 「글자가 X 인 노드」가 아니므로, 시험도 역할과 레이블로 찾는다. 레이블은 소스의
 * `copy.ts` 상수나 시험이 만든 값을 `Copy` 로 넘긴다 — 한국어 문장 리터럴을 호출 자리에 쓰지 않는다.
 *
 * ## 레이블이 비면 던진다
 *
 * RNTL 은 `name: undefined` 를 「이름 조건 없음」으로 읽는다. 소스에서 문구 상수가 사라지거나
 * 이름이 바뀌면(`import * as copy` 로 받아 `copy[key]` 로 넘기는 길에서는 tsc 도 못 잡는다)
 * `control('button', copy.GONE)` 가 **화면의 아무 버튼이나** 집어서, 시험이 초록인 채로 아무것도
 * 가리지 못한다. 그래서 이 파일의 조회는 레이블 자리에 `undefined`·빈 문자열이 오면 던진다.
 * 이름 조건 없이 역할만으로 찾으려면 두 번째 인자를 **아예 주지 않는다**.
 *
 * ## 문장 사전이 생기면
 *
 * 문구 **키**로 찾는 길은 문장 사전(#4240)이 생긴 뒤에야 만들 수 있다. 그때 키를 현재 언어의
 * 문장으로 바꾸는 자리는 `resolveCopy` 한 곳이다. 지금은 문자열·정규식을 그대로 돌려준다.
 */

/** 레이블로 넘기는 값. `copy.ts` 상수·함수 결과·정규식. */
export type Copy = string | RegExp;

export type Role = Parameters<typeof screen.getByRole>[0];

/** 화면에서 찾은 노드. RNTL 이 돌려주는 모양 그대로다. */
export type ControlNode = ReturnType<typeof screen.getByRole>;

/** 레이블을 화면에서 찾을 글자로 바꾸는 자리. 문장 사전이 생기면 여기서 키를 문장으로 푼다. */
export function resolveCopy(label: Copy): Copy {
  return label;
}

function requireLabel(label: Copy | undefined, where: string): Copy {
  if (label === undefined || (typeof label === 'string' && label.trim() === '')) {
    throw new Error(
      `${where}: 레이블이 비었어요(${String(label)}) — 소스의 문구 상수가 없어졌거나 이름이 바뀐 것 같아요. ` +
        '빈 레이블은 화면의 모든 노드와 맞아서 시험이 아무것도 가리지 못해요. 이름 조건 없이 ' +
        '역할만으로 찾으려면 두 번째 인자를 주지 마세요.',
    );
  }
  return resolveCopy(label);
}

/** 역할(과 이름)이 맞는 노드 하나. 없거나 둘 이상이면 던진다. */
export function control(role: Role, ...name: [name?: Copy]): ControlNode {
  return name.length === 0
    ? screen.getByRole(role)
    : screen.getByRole(role, {name: requireLabel(name[0], 'control')});
}

/** 있을 수도 없을 수도 있는 노드. 없으면 `null`. 「안 보인다」를 단정할 때 쓴다. */
export function maybeControl(role: Role, ...name: [name?: Copy]): ControlNode | null {
  return name.length === 0
    ? screen.queryByRole(role)
    : screen.queryByRole(role, {name: requireLabel(name[0], 'maybeControl')});
}

/** 역할(과 이름)이 맞는 노드 모두. */
export function controls(role: Role, ...name: [name?: Copy]): ControlNode[] {
  return name.length === 0
    ? screen.queryAllByRole(role)
    : screen.queryAllByRole(role, {name: requireLabel(name[0], 'controls')});
}

/** 접근성 레이블이 맞는 노드 하나(입력창처럼 역할이 흔한 것을 레이블로 가를 때). */
export function labelled(label: Copy): ControlNode {
  return screen.getByLabelText(requireLabel(label, 'labelled'));
}

/** 이름이 맞는 컨트롤을 누른다. */
export function pressControl(role: Role, ...name: [name?: Copy]): void {
  fireEvent.press(control(role, ...name));
}

/** 레이블이 맞는 입력창에 글자를 넣는다. */
export function typeInto(label: Copy, text: string): void {
  fireEvent.changeText(labelled(label), text);
}
