import {
  CHANNEL_NAME_MAX,
  channelNameIssue,
  judgeChannelName,
  normalizeChannelName,
} from '@momo/core/features/channels/model';
import React, {useEffect, useMemo, useState} from 'react';
import {ScrollView, Settings, StyleSheet, Text} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';

import {NewChannelSheet} from '../src/shell/NewChannelSheet';
import {Backdrop} from './sheetKit';

// =============================================================================
// 채널 이름 규칙 — 실제 폰 엔진 측정 면 (#5834, ADR-0225 D11·D13).
//
//   -momoMeasure NEWCHANNEL-VECTORS           코어의 벡터 사본 전부를 코어 함수(`judgeChannelName`)로 돌려 통과 수를 화면 글자 · 싱크로 낸다.
//                                            엔진이 Hermes 인지, `\p{M}` 이 만들어지는지, NFC 가 합쳐지는지도 같이 적는다.
//   -momoMeasure NEWCHANNEL-VECTORS-FALLBACK  같은 벡터를, **정규식이 `\p{` 에서 던지는 엔진**으로 돌린다(#5877 의 물러섬) — 첫 판정 전에
//                                            `RegExp` 를 바꿔 끼운다. 코어는 한 번 만든 결과(실패 포함)를 기억하므로 정상 길과 한 실행에 못 담는다.
//   -momoMeasure NEWCHANNEL-SHEET             새 채널 시트(배송되는 것) 한 장. 글은 Maestro `inputText` 가 치고 `maestro hierarchy` 가 칸·줄·공개 범위 카드의 위치를 읽는다(#5834 의 전·후 숫자).
//
// 이름·회사는 가상이다. 받는 쪽은 `measure/bubble-clip-check.mjs serve` (`-momoGapSink`).
// =============================================================================

interface VectorCase {
  group: string;
  note: string;
  input: string;
  verdict: 'ok' | 'required' | 'tooLong' | 'hidden' | 'unsupported' | 'edge';
  stored?: string;
}
const vectorFile = require('@momo/core/features/channels/__fixtures__/channel-name.vectors.json') as {
  maxChars: number;
  cases: VectorCase[];
};

const noop = () => {};

function post(record: Record<string, unknown>): void {
  const sink = Settings.get('momoGapSink');
  const line = {surface: 'newchannel', ...record};
  console.log(`NEWCHANNEL5834 ${JSON.stringify(line)}`);
  if (typeof sink !== 'string' || sink === '') return;
  void fetch(`http://${sink}/probe`, {method: 'POST', body: JSON.stringify(line)}).catch(() => {});
}

const escape = (input: string): string =>
  input.replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).slice(0, 60);

interface Row {
  index: number;
  label: string;
  want: string;
  got: string;
  pass: boolean;
}

/** 한 벡터 줄을 코어 함수로 돌린다. 던지면 그 줄이 `threw` 로 적힌다(통과가 아니다). */
function runCase(c: VectorCase, index: number): Row {
  const want = c.verdict === 'ok' ? `ok:${c.stored}` : c.verdict;
  try {
    const judged = judgeChannelName(c.input);
    const got = judged.ok ? `ok:${judged.name}` : judged.verdict;
    let pass = got === want;
    if (pass && c.verdict === 'ok') {
      // 저장 값을 다시 접어도 그대로(멱등) · 이슈 없음.
      pass = normalizeChannelName(c.stored as string) === c.stored && channelNameIssue(c.input) === null;
    } else if (pass) {
      pass = channelNameIssue(c.input) !== null;
    }
    return {index, label: escape(c.input), want: escape(want), got: escape(got), pass};
  } catch (error) {
    return {index, label: escape(c.input), want: escape(want), got: `threw:${String(error)}`.slice(0, 60), pass: false};
  }
}

function engineFacts(): Record<string, unknown> {
  const hermes = (globalThis as {HermesInternal?: {getRuntimeProperties?: () => Record<string, string>}}).HermesInternal;
  const props = hermes?.getRuntimeProperties?.() ?? {};
  let pM: string;
  try {
    pM = String(new RegExp('^\\p{M}$', 'u').test('\u0301'));
  } catch (error) {
    pM = `threw:${String(error)}`;
  }
  let pL: string;
  try {
    pL = String(new RegExp('^\\p{L}$', 'u').test('\ud55c'));
  } catch (error) {
    pL = `threw:${String(error)}`;
  }
  return {
    hermes: hermes !== undefined,
    hermesVersion: props['OSS Release Version'] ?? null,
    bytecodeVersion: props['Bytecode Version'] ?? null,
    pMarkAcute: pM,
    pLetterHangul: pL,
    nfcLatin: 'e\u0301'.normalize('NFC') === '\u00e9',
    nfcHangul: '\u1112\u1161\u11ab'.normalize('NFC') === '\ud55c',
    lowerI: 'I'.toLowerCase(),
  };
}

function useBrokenRegExp(enabled: boolean): void {
  // 첫 판정 전에 한 번만 바꿔 끼운다(렌더 중이 아니라 초기화 함수에서 — 이 하네스는 판정 전에 서 있어야 한다).
  useState(() => {
    if (!enabled) return null;
    const Native = globalThis.RegExp;
    function Broken(this: unknown, pattern: string | RegExp, flags?: string): RegExp {
      if (typeof pattern === 'string' && pattern.includes('\\p{')) {
        throw new SyntaxError('measure: property escapes are not supported here');
      }
      return new Native(pattern, flags);
    }
    Broken.prototype = Native.prototype;
    (globalThis as {RegExp: unknown}).RegExp = Broken;
    return null;
  });
}

function VectorsSurface({fallback}: {fallback: boolean}): React.JSX.Element {
  useBrokenRegExp(fallback);
  const insets = useSafeAreaInsets();
  const [report, setReport] = useState<{rows: Row[]; facts: Record<string, unknown>} | null>(null);
  useEffect(() => {
    const started = Date.now();
    // 물러선 판은 사실 탐침을 **판정 뒤에** 읽는다(탐침이 만드는 정규식도 던지는 것을 그대로 본다).
    const rows = vectorFile.cases.map(runCase);
    const facts = engineFacts();
    setReport({rows, facts});
    const failed = rows.filter(row => !row.pass);
    post({
      kind: 'summary',
      mode: fallback ? 'fallback' : 'engine',
      total: rows.length,
      passed: rows.length - failed.length,
      maxChars: vectorFile.maxChars === CHANNEL_NAME_MAX,
      ms: Date.now() - started,
      facts,
    });
    for (const row of failed) post({kind: 'fail', mode: fallback ? 'fallback' : 'engine', ...row});
    post({kind: 'done'});
  }, [fallback]);
  const failed = report?.rows.filter(row => !row.pass) ?? [];
  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={[styles.body, {paddingTop: insets.top + 8}]}
      testID="newchannel-vectors">
      <Text style={styles.title}>{fallback ? 'VECTORS FALLBACK' : 'VECTORS ENGINE'}</Text>
      <Text style={styles.line} testID="newchannel-vectors-summary">
        {report === null ? 'running' : `passed ${report.rows.length - failed.length}/${report.rows.length}`}
      </Text>
      {report !== null
        ? Object.entries(report.facts).map(([key, value]) => (
            <Text key={key} style={styles.line}>
              {key}={String(value)}
            </Text>
          ))
        : null}
      {failed.slice(0, 40).map(row => (
        <Text key={row.index} style={styles.fail}>
          {row.index + 1} {row.label} want={row.want} got={row.got}
        </Text>
      ))}
    </ScrollView>
  );
}

function SheetSurface(): React.JSX.Element {
  const client = useMemo(
    () => new QueryClient({defaultOptions: {queries: {staleTime: Infinity, gcTime: Infinity, retry: false}}}),
    [],
  );
  return (
    <QueryClientProvider client={client}>
      <Backdrop>
        <NewChannelSheet onOpenConversation={noop} onClose={noop} />
      </Backdrop>
    </QueryClientProvider>
  );
}

export function NewChannelNameSurface({which}: {which: string}): React.JSX.Element {
  if (which === 'vectors') return <VectorsSurface fallback={false} />;
  if (which === 'vectors-fallback') return <VectorsSurface fallback />;
  return <SheetSurface />;
}

const styles = StyleSheet.create({
  fill: {flex: 1, backgroundColor: '#ffffff'},
  body: {paddingHorizontal: 12, paddingBottom: 40, gap: 4},
  title: {fontSize: 14, fontWeight: '700', color: '#000000'},
  line: {fontSize: 12, color: '#000000'},
  fail: {fontSize: 10, color: '#aa0000'},
});
