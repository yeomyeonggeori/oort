/**
 * 게이트 5 — 타임라인 더미 데이터.
 *
 * 한국어 **가변 높이** 행이 요점이다(2~5줄 섞임). 고정 높이 행으로 재면
 * 세 라이브러리 모두 잘 나오고, 우리가 알고 싶은 것은 정확히 그 반대 상황이다.
 */

const BODIES = [
  '네 확인했습니다.',
  '방금 배포 올렸어요. 게이트 세 개 다 통과했고 로그도 깨끗합니다.',
  '이 부분은 어제 이야기한 대로 처리했는데, 혹시 순서가 바뀌면 재현되는 케이스가 있어서 한 번 더 확인 부탁드려요. 특히 재연결 직후 구간이요.',
  '오케이',
  '지금 작업 세션 붙어서 보고 있는데, 터미널 출력이 80컬럼 기준으로 잘려 나옵니다. 폰에서는 접힌 행으로 보여 주는 편이 나을 것 같아요. 데스크톱에서 열기 링크도 같이 두면 좋겠고요.',
  '승인 요청 하나 올라왔습니다. 확인 후 처리 부탁드립니다.',
  '이슈 재현했습니다. 조합 중에 목록이 갱신되면 마지막 글자가 한 번 더 들어가는 형태였고, 리렌더를 멈추면 재현되지 않습니다. 원인은 controlled value 쪽으로 보입니다.',
  '감사합니다 🙏',
  '오늘 회의는 30분 뒤로 미뤄도 괜찮을까요? 지금 빌드가 아직 돌고 있어서요.',
  '문서 갱신해 두었습니다. 정본은 그대로 두고 부록만 손봤어요.',
];

const WHO = ['성재', '김인턴', 'hermes', '지현', '민수'];

export interface Msg {
  id: string;
  seq: number;
  who: string;
  body: string;
  mine: boolean;
}

/** 결정론적 생성 — 실행마다 같은 데이터라야 세 라이브러리를 비교할 수 있다. */
export function makeMessages(n: number): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `m${i}`,
      seq: i,
      who: WHO[i % WHO.length],
      body: BODIES[(i * 7) % BODIES.length],
      mine: i % 3 === 0,
    });
  }
  // inverted 리스트: index 0 이 화면 맨 아래(= 최신)
  return out.reverse();
}

let extra = 0;
export function newIncoming(): Msg {
  extra += 1;
  return {
    id: `new${extra}`,
    seq: 100000 + extra,
    who: '김인턴',
    body: `방금 도착한 메시지 #${extra} — 스크롤이 튀는지 보는 중입니다.`,
    mine: false,
  };
}

let older = 0;
export function makeOlder(n: number): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < n; i++) {
    older += 1;
    out.push({
      id: `old${older}`,
      seq: -older,
      who: WHO[older % WHO.length],
      body: `과거 메시지 #${older} — ${BODIES[(older * 3) % BODIES.length]}`,
      mine: false,
    });
  }
  return out;
}
