/**
 * 게이트 1 — 한글 IME 계측 화면 (최우선 게이트)
 *
 * 이 화면의 목적은 "돌려보고 느낌을 말하는 것"이 아니라
 * **스크린샷 한 장이 판정이 되게** 하는 것이다.
 *
 * 항목을 둘로 나눈다:
 *   (기계) 최종 값이 목표와 일치하는가 · 조합 불변식을 깨는 전이가 있는가
 *          → 앱이 스스로 PASS/FAIL 을 찍는다. 사람 판단 불필요.
 *   (사람) 조합 중 **밑줄**이 보이는가
 *          → RN #55257 의 확증 증상이 정확히 이것이고, JS 에서 관측할 방법이 없다.
 *            사람이 눈으로 보고 버튼을 누른다.
 *
 * 정직하게 적어 두는 한계:
 *   RN iOS 는 조합(composition/markedText) 이벤트를 JS 로 노출하지 않는다.
 *   그래서 "조합 중"이라는 상태 자체는 관측 불가이고, 우리가 볼 수 있는 것은
 *   value 의 변화열뿐이다. 밑줄 판정이 사람 몫인 이유가 이것이다.
 */
import React, {useCallback, useMemo, useRef, useState} from 'react';
import {ScrollView, Text, TextInput, View} from 'react-native';

import {Badge, Btn, C, Card, KV, Row, s, type Verdict} from '../ui';
import {
  classify,
  summarize,
  verdictOf,
  type CaseResult,
  type Transition,
} from './composition';

const TARGET = '안녕하세요';

/** 멘션 자동완성 재현용. 조합 중 매 keystroke 마다 이 목록이 다시 걸러진다. */
const MENTION_POOL = Array.from({length: 60}, (_, i) => `팀원${i + 1} 김인턴`);

type Mode = 'uncontrolled' | 'controlled' | 'rerender' | 'async' | 'backspace';

type Human = 'yes' | 'no' | 'unset';

interface CaseSpec {
  id: string;
  title: string;
  mode: Mode;
  target: string;
  /** 사람이 그대로 따라 할 조작 */
  howto: string;
  why: string;
}

const CASES: CaseSpec[] = [
  {
    id: 'A',
    title: 'A. 비제어 입력 (기준선)',
    mode: 'uncontrolled',
    target: TARGET,
    howto: `"${TARGET}" 를 천천히 한 글자씩 입력`,
    why: 'value 를 React 가 통제하지 않는다. 여기서도 깨지면 RN/iOS 자체 문제이고, 여기만 멀쩡하면 controlled 가 원인이다.',
  },
  {
    id: 'B',
    title: 'B. 제어 입력 (우리 컴포저와 동일)',
    mode: 'controlled',
    target: TARGET,
    howto: `"${TARGET}" 를 천천히 한 글자씩 입력`,
    why: 'momo 컴포저는 controlled 다. RN #48497 이 지목하는 조건이 정확히 이것.',
  },
  {
    id: 'C',
    title: 'C. 제어 + 조합 중 리렌더 (멘션 자동완성)',
    mode: 'rerender',
    target: TARGET,
    howto: `"${TARGET}" 를 천천히 한 글자씩 입력`,
    why: '매 keystroke 마다 형제 목록 60건이 다시 걸러지고 리렌더된다. 실제 멘션 UI 의 부하를 조합 중에 건다.',
  },
  {
    id: 'D',
    title: 'D. 제어 + 비동기 setState (한 틱 지연)',
    mode: 'async',
    target: TARGET,
    howto: `"${TARGET}" 를 천천히 한 글자씩 입력`,
    why: 'setState 가 한 틱 늦게 반영된다. controlled IME 가 가장 잘 깨지는 형태이며, 네트워크/스토어 경유 상태에서 실제로 생긴다.',
  },
  {
    id: 'E',
    title: 'E. 조합 중 백스페이스',
    mode: 'backspace',
    target: '',
    howto: '"한글" 을 입력한 뒤 백스페이스로 전부 지우기 (빈 칸이 될 때까지)',
    why: '조합 중 백스페이스가 자모 단위로 풀리는지, 음절이 통째로 날아가는지. 티켓 명시 항목.',
  },
];

interface CaseReport {
  id: string;
  verdict: Verdict;
  result: CaseResult;
  underline: Human;
}

function ImeCase({
  spec,
  onReport,
}: {
  spec: CaseSpec;
  onReport: (r: CaseReport) => void;
}) {
  const [value, setValue] = useState('');
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [keyLog, setKeyLog] = useState<string[]>([]);
  const [underline, setUnderline] = useState<Human>('unset');
  const [tick, setTick] = useState(0);
  const lastRef = useRef({text: '', at: 0});

  const record = useCallback((next: string) => {
    const now = Date.now();
    const prev = lastRef.current;
    const dt = prev.at === 0 ? 0 : now - prev.at;
    setTransitions(old => {
      const t = classify(prev.text, next, old.length + 1, dt);
      return [...old, t];
    });
    lastRef.current = {text: next, at: now};
  }, []);

  const onChangeText = useCallback(
    (next: string) => {
      record(next);
      if (spec.mode === 'uncontrolled') {
        return;
      }
      if (spec.mode === 'async') {
        // 한 틱 늦게 반영 — controlled IME 파손의 고전적 조건
        setTimeout(() => setValue(next), 0);
        return;
      }
      setValue(next);
      if (spec.mode === 'rerender') {
        setTick(n => n + 1);
      }
    },
    [record, spec.mode],
  );

  const result = useMemo(
    () => summarize(transitions, spec.target),
    [transitions, spec.target],
  );
  const machineVerdict = verdictOf(result);

  React.useEffect(() => {
    onReport({id: spec.id, verdict: machineVerdict, result, underline});
  }, [machineVerdict, result, underline, onReport, spec.id]);

  const mentions = useMemo(() => {
    if (spec.mode !== 'rerender') {
      return [];
    }
    const q = value.trim();
    return MENTION_POOL.filter(m => q === '' || m.includes(q)).slice(0, 5);
  }, [spec.mode, value, /* 리렌더를 확실히 유발 */ tick]);

  const reset = () => {
    setValue('');
    setTransitions([]);
    setKeyLog([]);
    lastRef.current = {text: '', at: 0};
  };

  const recent = transitions.slice(-10);

  return (
    <Card title={spec.title} verdict={machineVerdict}>
      <Text style={s.cardSub}>{spec.why}</Text>
      <Text style={[s.cardSub, {color: C.accent, marginTop: 6}]}>
        ▶ 할 것: {spec.howto}
      </Text>

      <TextInput
        style={s.input}
        placeholder="여기에 입력"
        placeholderTextColor={C.dim}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        {...(spec.mode === 'uncontrolled' ? {} : {value})}
        onChangeText={onChangeText}
        onKeyPress={e =>
          setKeyLog(k => [...k.slice(-9), e.nativeEvent.key ?? '?'])
        }
      />

      {spec.mode === 'rerender' ? (
        <View style={{marginTop: 6}}>
          <Text style={s.dim}>
            멘션 후보 {mentions.length}건 (리렌더 {tick}회)
          </Text>
          {mentions.map(m => (
            <Text key={m} style={[s.mono, {marginTop: 2}]}>
              @{m}
            </Text>
          ))}
        </View>
      ) : null}

      <KV
        k="목표 / 현재"
        v={`${spec.target === '' ? '(빈 칸)' : spec.target}  /  ${
          result.finalValue === '' ? '(빈 칸)' : result.finalValue
        }`}
        tone={result.finalMatches ? 'PASS' : 'FAIL'}
      />
      <KV k="onChangeText 횟수" v={String(result.keystrokeCount)} />
      <KV
        k="조합 불변식 위반"
        v={`${result.suspiciousCount}건`}
        tone={result.suspiciousCount === 0 ? 'PASS' : 'FAIL'}
      />
      <KV
        k="onKeyPress 수신"
        v={keyLog.length === 0 ? '(없음 — RN iOS 는 조합 중 키를 안 준다)' : keyLog.join(' ')}
      />

      <Text style={[s.dim, {marginTop: 8}]}>값 변화열 (최근 10)</Text>
      {recent.length === 0 ? (
        <Text style={s.mono}>(아직 입력 없음)</Text>
      ) : (
        recent.map(t => (
          <Text
            key={t.i}
            style={[s.mono, t.suspicious ? {color: C.fail} : null]}
          >
            {t.i}. {t.from === '' ? '∅' : t.from} → {t.to === '' ? '∅' : t.to}
            {'  '}(-{t.dropped}/+{t.added}){t.suspicious ? '  ⚠ 위반' : ''}
          </Text>
        ))
      )}

      <Text style={[s.dim, {marginTop: 10}]}>
        사람 판정 — 조합 중(글자가 완성되기 전) 밑줄이 보였나?
      </Text>
      <Row>
        <Btn
          label={underline === 'yes' ? '● 밑줄 보임' : '○ 밑줄 보임'}
          onPress={() => setUnderline('yes')}
        />
        <Btn
          label={underline === 'no' ? '● 안 보임' : '○ 안 보임'}
          onPress={() => setUnderline('no')}
        />
        <Btn label="초기화" onPress={reset} />
      </Row>
    </Card>
  );
}

const KEYBOARDS = ['2벌식', '천지인', 'iOS 기본 한글'] as const;

export default function ImeGate() {
  const [keyboard, setKeyboard] = useState<string>(KEYBOARDS[0]);
  const [reports, setReports] = useState<Record<string, CaseReport>>({});

  const onReport = useCallback((r: CaseReport) => {
    setReports(old =>
      old[r.id] &&
      old[r.id].verdict === r.verdict &&
      old[r.id].underline === r.underline &&
      old[r.id].result.keystrokeCount === r.result.keystrokeCount
        ? old
        : {...old, [r.id]: r},
    );
  }, []);

  const rows = CASES.map(c => reports[c.id]).filter(Boolean) as CaseReport[];
  const anyFail = rows.some(r => r.verdict === 'FAIL');
  const allRun = rows.length === CASES.length && rows.every(r => r.verdict !== 'PENDING');
  const underlineAnswered = rows.filter(r => r.underline !== 'unset').length;
  const underlineMissing = rows.filter(r => r.underline === 'no').length;

  const overall: Verdict = anyFail
    ? 'FAIL'
    : allRun && underlineAnswered === CASES.length
    ? underlineMissing === 0
      ? 'PASS'
      : 'FAIL'
    : 'PENDING';

  return (
    <ScrollView style={s.screen} keyboardShouldPersistTaps="handled">
      <Card title={`게이트 1 — 한글 IME · 키보드: ${keyboard}`} verdict={overall}>
        <Text style={s.cardSub}>
          키보드를 바꿔 가며 A~E 를 각각 수행하고, 매번 이 화면을 스크린샷으로 남겨라.
          한 스크린샷이 한 키보드의 판정이다.
        </Text>
        <Row>
          {KEYBOARDS.map(k => (
            <Btn
              key={k}
              label={keyboard === k ? `● ${k}` : `○ ${k}`}
              onPress={() => setKeyboard(k)}
              tone={keyboard === k ? 'accent' : 'normal'}
            />
          ))}
        </Row>
        <Text style={[s.dim, {marginTop: 10}]}>요약</Text>
        {CASES.map(c => {
          const r = reports[c.id];
          return (
            <View key={c.id} style={{flexDirection: 'row', alignItems: 'center', marginTop: 4}}>
              <Text style={[s.mono, {width: 22}]}>{c.id}</Text>
              <Badge verdict={r?.verdict ?? 'PENDING'} />
              <Text style={[s.dim, {marginLeft: 8}]}>
                {r
                  ? `${r.result.keystrokeCount}타 · 위반 ${r.result.suspiciousCount} · 밑줄 ${
                      r.underline === 'unset' ? '미답' : r.underline === 'yes' ? '보임' : '안 보임'
                    }`
                  : '미실행'}
              </Text>
            </View>
          );
        })}
        <Text style={[s.dim, {marginTop: 10}]}>
          기계 판정 = 최종 값이 목표와 정확히 일치 AND 조합 불변식 위반 0건.
          여기에 사람이 답한 밑줄 항목이 더해져야 게이트 1이 PASS 다.
        </Text>
      </Card>

      {CASES.map(c => (
        <ImeCase key={c.id} spec={c} onReport={onReport} />
      ))}
      <View style={{height: 60}} />
    </ScrollView>
  );
}
