/**
 * 게이트 3 — centrifuge-js 실왕복 + 리플레이 게이트
 *
 * 재는 성질은 웹 `clients/web/gates/gate-resume.mjs` 와 **같다**:
 *   구독(recoverable+positioned) → tail 기록 → WS 끊기 → 끊긴 동안 M건 주입
 *   → 재연결 → (Centrifugo 복구 ∪ REST ?after 백필) 로 전부 설명되는가.
 *   `missing` 은 반드시 0.
 *
 * 붙는 대상은 **로컬 스파이크 스택**이다(tools/centrifugo-spike/run.sh).
 * 실서버(app.oor7.com)에는 붙지 않는다 — 자격증명이 필요하고, 이 배치는 쓰지 않는다.
 *
 * 같은 시나리오의 Node 기준선이 tools/centrifugo-spike/resume-node.mjs 에 있다.
 * 앱과 Node 의 결과가 갈리면 그 차이가 곧 "RN/Hermes 고유 문제"다.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ScrollView, Text, TextInput, View} from 'react-native';
import {Centrifuge} from 'centrifuge';

import {Btn, C, Card, KV, Row, s, type Verdict} from '../ui';

const CENT_PORT = 18901;
const BROKER_PORT = 18902;
const CHANNEL = 'ch:spike';
const MISS = 25;

interface Result {
  liveBeforeDrop: number;
  injectedWhileOffline: number;
  tailSeqBeforeDrop: number;
  recoveredViaWs: number;
  subscribedCtxRecovered: boolean | null;
  /** createReplayGate 가 의존하는 성질: subscribed 직후 동기 플러시 */
  hasRecoveredPublications: boolean | null;
  recoveredViaRestBackfill: number;
  missing: number;
  /**
   * WS 레일이 실제로 살아 있었는가.
   *
   * 이 필드가 없으면 이 하네스는 거짓말을 한다 — 실제로 겪었다:
   * centrifuge-js 가 한 번도 연결되지 못했는데도 REST 백필이 25건을 전부
   * 메워서 `missing === 0` 이 되고 화면에 PASS 가 찍혔다. 웹 게이트의 판정식
   * (복구 ∪ 백필)을 그대로 가져온 탓인데, 웹에서는 WS 가 살아 있는 것이
   * 전제였다. 이 게이트가 묻는 것은 정확히 그 전제이므로 따로 세야 한다.
   */
  wsRailOk: boolean;
  pass: boolean;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(() => r(), ms));

export default function RealtimeGate() {
  // 시뮬레이터는 127.0.0.1 로 맥에 닿는다. 실기기는 맥의 LAN 주소가 필요하다
  // (`tools/centrifugo-spike/run.sh ip` 가 찍어 준다).
  const [host, setHost] = useState('127.0.0.1');
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  /** 웹은 websocket 구현을 넘기지 않는다. RN 에서도 그런지가 측정 대상이다. */
  const [passWs, setPassWs] = useState(false);
  const clientRef = useRef<Centrifuge | null>(null);

  const say = useCallback((m: string) => {
    setLog(l => [...l.slice(-40), m]);
  }, []);

  const broker = `http://${host}:${BROKER_PORT}`;
  const wsUrl = `ws://${host}:${CENT_PORT}/connection/websocket`;

  const run = async () => {
    setRunning(true);
    setResult(null);
    setLog([]);
    try {
      say(`브로커 ${broker} 확인…`);
      const health = await fetch(`${broker}/health`).then(r => r.json());
      say(`브로커 응답: channel=${health.channel}`);

      const getToken = async () => {
        const r = await fetch(`${broker}/token`, {method: 'POST'});
        const j = await r.json();
        return j.token as string;
      };

      say(`Centrifuge 생성 (websocket 주입: ${passWs ? '함' : '안 함'})`);
      const client = new Centrifuge(wsUrl, {
        getToken,
        minReconnectDelay: 200,
        maxReconnectDelay: 1000,
        ...(passWs ? {websocket: (globalThis as any).WebSocket} : {}),
      });
      clientRef.current = client;

      client.on('error', ctx => say(`client error: ${JSON.stringify(ctx?.error ?? ctx)}`));
      client.on('connected', () => say('connected'));
      client.on('disconnected', ctx => say(`disconnected: ${ctx?.reason ?? ''}`));

      const recovered = new Set<number>();
      const live = new Set<number>();
      let phase: 'initial' | 'offline' | 'offline-recovery' = 'initial';
      let ctxRecovered: boolean | null = null;
      let ctxHasRecoveredPubs: boolean | null = null;

      const sub = client.newSubscription(CHANNEL, {
        recoverable: true,
        positioned: true,
      });

      sub.on('publication', ctx => {
        const seq = ctx?.data?.payload?.seq;
        if (typeof seq !== 'number') {
          return;
        }
        if (phase === 'offline-recovery') {
          recovered.add(seq);
        } else {
          live.add(seq);
        }
      });

      let subCount = 0;
      let resolveAgain: (() => void) | null = null;
      const subscribedAgain = new Promise<void>(res => {
        resolveAgain = res;
      });
      const firstSubscribed = new Promise<void>(res => {
        sub.on('subscribed', (ctx: any) => {
          subCount += 1;
          if (subCount === 1) {
            say('subscribed (최초)');
            res();
          } else if (subCount >= 2) {
            ctxRecovered = ctx?.recovered ?? null;
            ctxHasRecoveredPubs = ctx?.hasRecoveredPublications ?? null;
            say(
              `subscribed (재연결) recovered=${String(ctxRecovered)} hasRecoveredPublications=${String(
                ctxHasRecoveredPubs,
              )}`,
            );
            resolveAgain?.();
          }
        });
      });

      say('connect + subscribe…');
      client.connect();
      sub.subscribe();
      await Promise.race([firstSubscribed, sleep(8000)]);

      say('라이브 3건 주입');
      await fetch(`${broker}/publish?n=3&tag=live`, {method: 'POST'}).then(r => r.json());
      await sleep(500);

      const before = await fetch(`${broker}/after?seq=0`).then(r => r.json());
      const tailSeq = before.count ? before.messages[before.messages.length - 1].seq : 0;
      say(`끊기 전 tail seq = ${tailSeq}, 라이브 수신 ${live.size}건`);

      phase = 'offline';
      say('WS 끊기');
      client.disconnect();
      await sleep(400);

      say(`끊긴 동안 ${MISS}건 주입`);
      const injected = await fetch(`${broker}/publish?n=${MISS}&tag=offline`, {
        method: 'POST',
      }).then(r => r.json());

      phase = 'offline-recovery';
      say('재연결');
      client.connect();
      sub.subscribe();
      await Promise.race([subscribedAgain, sleep(8000)]);
      await sleep(900);

      const backfill = await fetch(`${broker}/after?seq=${tailSeq}`).then(r => r.json());
      const backfillSeqs = new Set<number>(backfill.messages.map((m: any) => m.seq));
      const accounted = new Set<number>([...recovered, ...backfillSeqs]);
      const missing = (injected.seqs as number[]).filter(sq => !accounted.has(sq));

      // WS 레일이 살아 있었다는 증거: 끊기기 전 라이브 수신이 있었고,
      // 재연결 시 Centrifugo 가 복구를 보고했고, 실제로 복구분을 받았다.
      const wsRailOk =
        live.size > 0 && ctxRecovered === true && recovered.size === injected.seqs.length;

      const r: Result = {
        liveBeforeDrop: live.size,
        injectedWhileOffline: injected.seqs.length,
        tailSeqBeforeDrop: tailSeq,
        recoveredViaWs: recovered.size,
        subscribedCtxRecovered: ctxRecovered,
        hasRecoveredPublications: ctxHasRecoveredPubs,
        recoveredViaRestBackfill: backfill.count,
        missing: missing.length,
        wsRailOk,
        // 둘 다 필요하다. REST 백필만으로 메워진 것은 이 게이트의 PASS 가 아니다.
        pass: missing.length === 0 && wsRailOk,
      };
      setResult(r);
      say(
        r.pass
          ? '판정: PASS (WS 복구 정상 + missing 0)'
          : `판정: FAIL (wsRailOk=${wsRailOk}, missing=${missing.length})`,
      );
      client.disconnect();
    } catch (e) {
      say(`예외: ${e instanceof Error ? e.message : String(e)}`);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  // 탭을 열면 한 번은 자동으로 돈다. 기기에서 탭 하나 줄이는 것도 있지만,
  // 진짜 이유는 이 게이트가 "사람 조작 없이도 재현되어야" 하기 때문이다.
  const didAuto = useRef(false);
  useEffect(() => {
    if (didAuto.current) {
      return;
    }
    didAuto.current = true;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verdict: Verdict = result ? (result.pass ? 'PASS' : 'FAIL') : 'PENDING';

  return (
    <ScrollView style={s.screen} keyboardShouldPersistTaps="handled">
      <Card title="게이트 3 — centrifuge-js 실왕복 + 리플레이" verdict={verdict}>
        <Text style={s.cardSub}>
          먼저 맥에서 `tools/centrifugo-spike/run.sh up` 을 띄워라. 시뮬레이터는
          127.0.0.1, 실기기는 맥의 LAN 주소를 넣어야 한다(`run.sh ip`).
        </Text>
        <TextInput
          style={s.input}
          value={host}
          onChangeText={setHost}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="호스트 (예: 192.168.0.10)"
          placeholderTextColor={C.dim}
        />
        <KV k="WS" v={wsUrl} />
        <KV k="브로커" v={broker} />
        <Row>
          <Btn
            label={running ? '측정 중…' : '리플레이 게이트 실행'}
            onPress={running ? () => {} : run}
            tone="accent"
          />
          <Btn
            label={passWs ? 'websocket 주입: 함' : 'websocket 주입: 안 함(웹과 동일)'}
            onPress={() => setPassWs(v => !v)}
          />
        </Row>

        {result ? (
          <View style={{marginTop: 10}}>
            <KV k="끊기 전 라이브 수신" v={`${result.liveBeforeDrop}건`} />
            <KV k="끊긴 동안 주입" v={`${result.injectedWhileOffline}건`} />
            <KV k="WS 복구 수신" v={`${result.recoveredViaWs}건`} />
            <KV k="ctx.recovered" v={String(result.subscribedCtxRecovered)} />
            <KV
              k="hasRecoveredPublications"
              v={String(result.hasRecoveredPublications)}
            />
            <KV k="REST 백필" v={`${result.recoveredViaRestBackfill}건`} />
            <KV
              k="WS 레일 생존"
              v={result.wsRailOk ? '예' : '아니오 (REST 만으로 메워짐)'}
              tone={result.wsRailOk ? 'PASS' : 'FAIL'}
            />
            <KV
              k="missing"
              v={`${result.missing}건`}
              tone={result.missing === 0 ? 'PASS' : 'FAIL'}
            />
          </View>
        ) : null}

        <Text style={[s.dim, {marginTop: 10}]}>진행 로그</Text>
        {log.map((l, i) => (
          <Text key={i} style={s.mono}>
            {l}
          </Text>
        ))}
      </Card>
      <View style={{height: 60}} />
    </ScrollView>
  );
}
