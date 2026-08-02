/**
 * 스파이크 하네스 공용 UI 조각.
 *
 * 의도적으로 최소한이다. 이 코드는 판정이 끝나면 버려진다 —
 * 디자인 토큰·접근성·테마를 여기에 넣지 마라. 읽히기만 하면 된다.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export type Verdict = 'PASS' | 'FAIL' | 'PENDING';

export const C = {
  bg: '#0b0d10',
  card: '#151a21',
  line: '#252d38',
  text: '#e6edf3',
  dim: '#8b98a5',
  pass: '#2ea043',
  fail: '#f85149',
  pending: '#d29922',
  accent: '#388bfd',
};

export function verdictColor(v: Verdict): string {
  return v === 'PASS' ? C.pass : v === 'FAIL' ? C.fail : C.pending;
}

export function Badge({ verdict, label }: { verdict: Verdict; label?: string }) {
  return (
    <View style={[s.badge, { backgroundColor: verdictColor(verdict) }]}>
      <Text style={s.badgeText}>{label ?? verdict}</Text>
    </View>
  );
}

export function Card({
  title,
  subtitle,
  verdict,
  children,
}: {
  title: string;
  subtitle?: string;
  verdict?: Verdict;
  children?: React.ReactNode;
}) {
  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <Text style={s.cardTitle}>{title}</Text>
        {verdict ? <Badge verdict={verdict} /> : null}
      </View>
      {subtitle ? <Text style={s.cardSub}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

export function Btn({
  label,
  onPress,
  tone,
}: {
  label: string;
  onPress: () => void;
  tone?: 'normal' | 'accent';
}) {
  return (
    <TouchableOpacity
      style={[s.btn, tone === 'accent' && { backgroundColor: C.accent }]}
      onPress={onPress}
    >
      <Text style={s.btnText}>{label}</Text>
    </TouchableOpacity>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return <View style={s.row}>{children}</View>;
}

export function KV({ k, v, tone }: { k: string; v: string; tone?: Verdict }) {
  return (
    <View style={s.kv}>
      <Text style={s.kvK}>{k}</Text>
      <Text
        style={[s.kvV, tone ? { color: verdictColor(tone) } : null]}
        selectable
      >
        {v}
      </Text>
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  card: {
    backgroundColor: C.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.line,
    padding: 12,
    margin: 10,
  },
  cardHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  cardSub: { color: C.dim, fontSize: 12, marginTop: 4, lineHeight: 17 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  btn: {
    backgroundColor: '#2b3440',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 7,
    marginRight: 8,
    marginTop: 8,
  },
  btnText: { color: C.text, fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  kv: { flexDirection: 'row', marginTop: 5, alignItems: 'flex-start' },
  kvK: { color: C.dim, fontSize: 12, width: 132 },
  kvV: {
    color: C.text,
    fontSize: 12,
    flex: 1,
    fontFamily: 'Menlo',
  },
  input: {
    backgroundColor: '#0b0d10',
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 7,
    color: C.text,
    fontSize: 17,
    paddingHorizontal: 10,
    paddingVertical: 9,
    marginTop: 8,
  },
  mono: { color: C.text, fontSize: 11, fontFamily: 'Menlo' },
  dim: { color: C.dim, fontSize: 12, lineHeight: 17 },
});
