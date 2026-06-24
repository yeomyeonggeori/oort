export const meta = {
  name: 'agent-native-messenger-buildplan',
  description: 'Deep-dive + build plan: Swift Mac-first agent-native messenger',
  phases: [
    { title: 'Research', detail: '6 axes' },
    { title: 'Verify', detail: 'verify key claims' },
    { title: 'Gaps', detail: 'completeness critic' },
    { title: 'Gap-fill', detail: 'fill gaps' },
    { title: 'Synthesis', detail: 'plan' },
  ],
}

const GUARD = [
  '[조사 규칙]',
  '- WebSearch/WebFetch/GitHub로 실제 코드·문서·라이선스를 확인. 추측 금지, 실존 URL 인용.',
  "- 목표 제품: AI 에이전트가 '1급 구성원'인 네이티브 메신저. 1순위=Swift macOS 데스크탑, 2순위=iOS 앱스토어. 빠른 GTM.",
  "- 차용 관점: 슬랙/메타모스트의 기능·구조에서 '그대로 차용 / 개조 필요 / 버리고 에이전트용 재설계'를 구분.",
  '- 라이선스는 컴포넌트별로 정확히(AGPL/MSL/MIT/Apache). 상용 비공개 Swift 앱에서 재사용 가능 여부를 정직하게.',
  "- 모르면 '불명'이라고 정직하게. internkim(김인턴)은 사용자 내부 개발 에이전트일 수 있음.",
].join('\n')

const FIND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    topic: { type: 'string' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          point: { type: 'string' },
          detail: { type: 'string' },
          reuse_verdict: { type: 'string', enum: ['adopt', 'adapt', 'rebuild_for_agents', 'reference_only', 'na'] },
          source: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['point', 'detail', 'confidence'],
      },
    },
    recommendations: { type: 'array', items: { type: 'string' } },
    caveats: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['topic', 'summary', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claim: { type: 'string' },
    verdict: { type: 'string', enum: ['supported', 'refuted', 'uncertain'] },
    reasoning: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['claim', 'verdict', 'reasoning'],
}

const GAPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { topic: { type: 'string' }, why: { type: 'string' }, query: { type: 'string' } },
        required: ['topic', 'query'],
      },
    },
  },
  required: ['gaps'],
}

const ANGLES = [
  { key: 'slack-features', q: 'Slack의 전체 기능 표면을 인벤토리화하라. 그룹화: (1)메시징·채널·스레드·DM (2)Huddles·Clips·Canvas·Lists (3)검색·파일·핀·북마크 (4)Workflow Builder·자동화 (5)앱/봇 플랫폼·Events API·Block Kit·슬래시커맨드 (6)Agentforce/AI·MCP (7)엔터프라이즈 관리·SSO·감사·DLP. 각 기능이 에이전트 네이티브 메신저에 adopt/adapt/rebuild_for_agents/reference_only 중 무엇인지 판정.' },
  { key: 'mattermost-arch', q: 'Mattermost의 (a)전체 기능셋과 (b)오픈소스 아키텍처를 GitHub로 심층 스캔하라. server(Go), webapp(React), mobile(React Native), desktop(Electron). 데이터모델/DB 스키마, REST API v4, WebSocket 이벤트, 플러그인 프레임워크, 통합(슬래시커맨드/webhook/bot accounts/interactive/Apps), Calls·Playbooks·Boards. 컴포넌트별 라이선스(AGPL vs Mattermost Source Available License)와 상용 비공개 Swift 앱 차용 가능 여부. Swift 네이티브라 mobile(RN)은 직접 차용 불가임을 명확히. 각 부분 reuse_verdict.' },
  { key: 'swift-oss-stack', q: 'Swift 기반 macOS(1순위)+iOS(2순위) 에이전트 메신저를 OSS 구조 위에 빠르게 만들기 위한 빌딩블록을 조사하라. 후보: Matrix + Element X iOS(SwiftUI, matrix-rust-sdk), XMPP, Signal protocol, 실시간(Starscream/swift-nio/URLSession WebSocket), SwiftUI 채팅 UI(ExyteChat, MessageKit), 서버(Vapor/Hummingbird), 로컬 LLM(MLX Swift), 저장(GRDB/SwiftData). 각 후보 라이선스·성숙도·Mac+iOS 코드공유 적합성. 메신저 백본을 새로 짤지 vs Matrix 같은 OSS에 얹을지 권고.' },
  { key: 'the-agents', q: '3개 에이전트를 조사해 통합 방법을 정리하라: (1)Hermes agent (NousResearch Hermes 모델 계열인지, hermes 이름의 에이전트 프레임워크인지 구분), (2)openclaw (오픈소스 에이전트/도구인지 GitHub 확인), (3)internkim/김인턴 (사용자 내부 개발 에이전트, 공개정보 없으면 불명 처리). 각 인터페이스(MCP/REST/CLI/stdio/소켓), 인증, 스트리밍/툴콜 지원. 메신저가 호환되려면 어떤 어댑터 추상화가 필요한지.' },
  { key: 'agent-native-primitives', q: "에이전트를 메신저의 1급 구성원으로 포지셔닝하기 위한 설계 프리미티브를 정리하라. 항목: 에이전트 아이덴티티/계정(사람과 동등), presence·lifecycle, 능력 디스커버리(A2A Agent Card), 권한·ACL·승인 게이트, 전체 감사로그, 1급 메시지 타입(툴콜/diff/아티팩트), 비동기·고빈도 처리, 에이전트-에이전트(A2A)+사람-에이전트 혼합 거버넌스, 결제(x402/AP2). 각각을 macOS 앱+서버에 어떻게 구현할지 권고." },
  { key: 'licensing-appstore', q: '(1)Mattermost/OSS 차용의 라이선스 함의: AGPLv3/Mattermost Source Available License/MIT·Apache 카피레프트 도달범위, 상용 비공개 macOS/iOS 앱에서 쓸 수 있는 것과 없는 것. (2)Apple 앱스토어 제약: macOS(공증/샌드박스/백그라운드 상주/MAS vs 직접배포), iOS(백그라운드 실행 한계가 상주 에이전트에 치명적인지, 3.1.1 IAP로 에이전트 사용료 과금, 외부결제). 빠른 GTM 배포전략 권고.' },
]

phase('Research')
log('6개 축 병렬 조사 시작')

const research = await pipeline(
  ANGLES,
  (a) => agent(a.q + '\n' + GUARD, { label: 'research:' + a.key, phase: 'Research', schema: FIND_SCHEMA, agentType: 'deep-research' }),
  (res, a) => {
    if (!res) return null
    const top = (res.findings || []).filter((f) => f.confidence !== 'low').slice(0, 3)
    if (!top.length) return { key: a.key, res, verdicts: [] }
    return parallel(
      top.map((f) => () =>
        agent(
          '다음 주장을 독립 검증하고 반증을 우선 시도하라. 라이선스/인터페이스/아키텍처 사실이면 1차 출처(GitHub/공식문서)로 확인.\n주장: ' + f.point + '\n세부: ' + f.detail + '\n출처: ' + (f.source || '(검색)') + '\n' + GUARD,
          { label: 'verify:' + a.key, phase: 'Verify', schema: VERDICT_SCHEMA, agentType: 'deep-research' }
        ).then((v) => v || { claim: f.point, verdict: 'uncertain', reasoning: 'null' })
      )
    ).then((verdicts) => ({ key: a.key, res, verdicts: verdicts.filter(Boolean) }))
  }
)

const dims = research.filter(Boolean)
log('연구 ' + dims.length + '축 + 검증 완료. 공백 분석.')

const compact = dims.map((d) => ({
  axis: d.key,
  summary: d.res.summary,
  findings: (d.res.findings || []).map((f) => ({ point: f.point, detail: (f.detail || '').slice(0, 300), reuse: f.reuse_verdict, conf: f.confidence, src: f.source })),
  recommendations: d.res.recommendations || [],
  caveats: d.res.caveats || [],
  verdicts: (d.verdicts || []).map((v) => ({ claim: v.claim, verdict: v.verdict })),
}))

phase('Gaps')
const gapRes = await agent(
  '리서치 완전성 비평가. 목표: Swift Mac-first 에이전트 네이티브 메신저 구현계획. 아래에서 계획 수립에 빠진 결정적 공백(아키텍처 미결, 라이선스 미확인, 에이전트 통합 인터페이스 불명, 동기화/오프라인, 푸시(APNs), 멀티에이전트 동시성, 보안)을 최대 5개 + 검색쿼리.\n' + JSON.stringify(compact).slice(0, 22000) + '\n' + GUARD,
  { label: 'gap-critic', phase: 'Gaps', schema: GAPS_SCHEMA, agentType: 'deep-research' }
)
const gaps = (gapRes && gapRes.gaps ? gapRes.gaps : []).slice(0, 5)
log('공백 ' + gaps.length + '개 보강.')

phase('Gap-fill')
let fills = []
if (gaps.length) {
  fills = (await parallel(
    gaps.map((g, i) => () =>
      agent('다음 공백을 실제 근거로 메워라.\n주제: ' + g.topic + '\n이유: ' + (g.why || '') + '\n검색: ' + g.query + '\n' + GUARD, { label: 'gapfill:' + (i + 1), phase: 'Gap-fill', schema: FIND_SCHEMA, agentType: 'deep-research' })
    )
  )).filter(Boolean)
}

phase('Synthesis')
log('구현 계획 합성 중...')

const synthInstructions = [
  '너는 시니어 제품/플랫폼 아키텍트다. 아래 검증된 리서치로 한국어 마크다운 구현 계획+방향성 deep-dive를 작성하라. 매우 구체적·실행가능하게. 인라인 URL 출처, 추정·라이선스 리스크 반드시 표시.',
  '제품: AI 에이전트가 1급 구성원인 네이티브 메신저. 1순위=Swift macOS 데스크탑, 2순위=iOS 앱스토어. 빠른 GTM. OSS 구조 위에 구축. 통합 에이전트=Hermes agent, 김인턴(internkim, 내부개발), openclaw.',
  '리포트 구조:',
  '1. 방향성·포지셔닝 — 왜 Mac-first Swift인가, ICP, 한 문장 포지셔닝, 차별화(데스크탑×A2A×권한 화이트스페이스), 안티-스코프.',
  '2. 탑티어 메신저 기능 스캔 매트릭스 — Slack/Mattermost 기능 표: 기능 | Slack | Mattermost | 우리 MVP 판정(adopt/adapt/rebuild_for_agents/drop) | 비고. 에이전트용 재설계 필요 기능 강조.',
  '3. 메타모스트 오픈소스 아키텍처 차용 가능 vs 코어 — 컴포넌트별(server Go/webapp/mobile RN/desktop Electron/플러그인/API/WebSocket/데이터모델) 표: reference/adapt/안씀 + 라이선스 판정·리스크(RN mobile 직접 차용 불가, server 차용시 AGPL/MSL 함의). 진짜 차용할 핵심(프로토콜·데이터모델·플러그인 개념·이벤트 모델) 명시.',
  '4. 제안 아키텍처 — Swift 클라이언트(SwiftUI, Mac+iOS 코드공유) + 백엔드(자체 Vapor vs Matrix 등 OSS에 얹기, 권고+트레이드오프) + 실시간(WebSocket) + 저장/동기화/오프라인 + 푸시(APNs) + 로컬 LLM(MLX) 옵션. 텍스트 다이어그램.',
  "5. 에이전트 통합 모델 & '구성원으로서의 에이전트' — 어댑터 추상화(MCP/REST/CLI/stdio 수용), Hermes/internkim/openclaw 통합 가설(불명이면 가정 명시), 에이전트 아이덴티티/presence/권한/감사/1급 메시지타입(툴콜·diff)/A2A. 봇이 아니라 멤버로 만드는 데이터모델.",
  '6. 단계별 로드맵 — Phase 0 스파이크 → Phase 1 Mac MVP(8~12주, in/out scope) → Phase 2 iOS → Phase 3 멀티에이전트/A2A/결제. 각 페이즈 산출물·성공기준·난관.',
  '7. 리스크 & 의사결정 필요 — 기술/라이선스/앱스토어/시장 리스크 + 사용자에게 물어야 할 미결정(3개 에이전트 실제 인터페이스, 백엔드 self-host 여부).',
  '8. 출처 목록.',
].join('\n')

const fillsCompact = fills.map((f) => ({ topic: f.topic, summary: f.summary, recs: f.recommendations, findings: (f.findings || []).map((x) => ({ point: x.point, src: x.source })) }))

const plan = await agent(
  synthInstructions + '\n\n[검증된 리서치 JSON]\n' + JSON.stringify(compact).slice(0, 38000) + '\n\n[보강 JSON]\n' + JSON.stringify(fillsCompact).slice(0, 12000) + '\n' + GUARD,
  { label: 'synthesis', phase: 'Synthesis', agentType: 'deep-research' }
)

return {
  plan,
  axes: dims.map((d) => d.key),
  gaps_filled: gaps.map((g) => g.topic),
  verdicts: dims.flatMap((d) => (d.verdicts || []).map((v) => ({ axis: d.key, claim: v.claim, verdict: v.verdict }))),
}
