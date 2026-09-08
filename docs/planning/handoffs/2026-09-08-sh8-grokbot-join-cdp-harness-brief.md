# SH-8 핸드오프 브리프 — 그록봇 합류 절 검수·보강 + 로컬 CDP 하네스 신규 작성 + #1361 해제 준비 (#2230, 2026-09-08 go)

> 트랙: engine/docs · 크기 M · 케이스 A(그록봇 VM) · 파도 G1'-3 · 발사는 성재 go 뒤. 사실 출처: 2026-09-08 읽기 전용 탐색(파일:줄 인용).

## 0. 발주 근거 정정 3건 (브리프가 전제한 것 vs 실측)
1. 「§3.3에 합류 절이 없다(A-1)」 → **이미 있다.** `docs/SELF_HOST_AGENT.md:946-994` §3.3.16 「Agent join (loopback curl, static bearer)」, 2026-09-06 `3495caa9`. 범위 = **신규 집필이 아니라 검수·보강**.
2. 「CDP 하네스 복구」 → **레포에 존재한 적 없음**(스크래치패드 전용 `cdp_read/send/clear.py`). LS-4/LS-6 무관. 범위 = **신규 작성**, 사양은 `docs/planning/research/2026-08-22-grok-cdp-control-and-operator-host.md:13-16`에 완비.
3. 「#1361 blocked = 계정·자연어 릴레이 전제」 → 본문 Deps(#1344·#1358·#1360·#1362·#1363~#1369) **전부 CLOSED**(2026-09-08 실측). 남은 전제(계정 생존·로컬 CDP 허용)는 2026-09-07 결재로 해소. blocked 라벨은 낡았다.

## 1. 산출물
- **D1 §3.3.16 검수·보강**(en/ko 동기): 합류 5단계(생성→pairing 핸드셰이크→confirm→active 재핸드셰이크→regenerate)가 서버 라우트와 1:1인지 실측(`hosted_agent_connections.rs:133,203,216,653,720-740` · `lib.rs:1045-1060,1221-1225`). 어긋난 문장만 고친다. §3.3.17.4 루틴 지시문(`:1173-1220`)의 헤더·JSON-RPC 원문이 현행 Agent Port(`agent_port.rs`) 응답과 바이트 일치하는지 mock 없이 실제 서버로 1회 실측.
- **D2 하네스** `scripts/dev/grokbot_cdp/{read,write,clear}.py` + README(로컬 한정 고지 — 외부 사용자·공개 표면 자동화 금지, 결재 `0183:134`). 사양: `--remote-debugging-port=9333`, 단일 page target, WS `suppress_origin=True`(403 회피), 주입은 `Input.insertText`(ProseMirror), SEND는 분류기 차단 → **사람 Enter 1탭**을 절차로 명시(자동 SEND 시도 금지). 시험: 앱 부재 시 skip이 아니라 `SKIPPED: app not running` 명시 출력 + 앱 있을 때 READ→WRITE→(사람 탭)→READ 왕복 1회 로그.
- **D3 모순 정리**: `SELF_HOST_AGENT.md:992-993` 「Do not drive the vendor chat app with CDP…」와 `presets.test.ts:141`은 **사용자용 카피이므로 유지**(하네스는 planner 로컬 시험 도구). 대신 §3.3.19 「Do not」에 한 줄: 「이 문서의 금지는 사용자·공개 표면 기준이며, 개발자 로컬 검증 하네스는 `scripts/dev/grokbot_cdp/README`를 따른다」.
- **D4 #1361 재편**: 본문 Deps를 실측 상태로 갱신하고 blocked→ready 제안(planner가 성재 승인 뒤 라벨 교체), 수용 기준 3(scheduled trigger 자발 발화)에 「SEND 분류기로 인해 사람 Enter 1탭이 남는다」를 명시.

## 2. 경계·허용 목록
- 보호 경로: `scripts/dev/grokbot_cdp/**`(신규)만 — 정책 감사 1회. `.github/**`·`server-rust/**`·`schema` 무접촉. 문서: `docs/SELF_HOST_AGENT.md`·`.ko.md`·(#1361 본문은 planner).
- 시크릿·계정 정보 비유입. Grok Bot 계정은 성재 본인 것만.

## 3. 수용 기준(숫자)
§3.3.16 5단계 라우트 대조표(문서 줄 ↔ 라우트 줄) 5/5 · 루틴 지시문 원문 vs 실측 응답 diff 0 · 하네스 READ/WRITE 왕복 로그 1회(앱 버전·빌드 기록) · 사보타주: `suppress_origin` 제거 → 403 재현 RED, `innerText` 주입 → ProseMirror 미반영 RED · `local_gate --profile docs` PASS.
