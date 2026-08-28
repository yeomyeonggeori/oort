# 재개 체크포인트 — 종합 실테스트 (2026-08-28, Opus4.8→Fable 전환)

> 성재 지시: 모델 전환(Opus 4.8 → Fable) 위해 "작업 진행 준비까지만". 새 실작업 미착수, 이 문서에서 재개.
> 역할 불변: 구현·수리=grok 4.6 워커, 기획·검수·머지=Fable, 결재·실테스트=성재.

## 지금 어디까지 (준비 체인 ①~④ 완료)
- v0.1.3 발행 완료(main 빌드, app `e0faed22…`, pg `49a589bd…`, attestation 2본 PASS).
- #1837 문면 현행화 랜딩·정본화(#1841).
- VM 갱신(그록봇 릴레이) — pin v0.1.3, 허들 배선 5종 보존, 외부 4종 검증 그린, 새 번들 서빙 실증.
- 검수 앱 재빌드 → `~/Desktop/oort-uxui-review.app`(빌드 원본 main).

## S1(허들) 실측 → 결함 2겹 (증거: claudedocs/comprehensive-test-20260828/S1-huddle-findings.md)
- **결함 A(#1847) = 폐곡선.** #1825 셰임이 생성자만 리라이트 → livekit-client의 `setConfiguration` 주입 미발동. grok가 prototype 인터셉트 추가(PR #1849 → track/uxui f3883ae4), Fable 재검수 PASS(라이브 실측 일치). **main 미승격 — 결함 B와 batch 승격 예정.**
- **결함 B = 진단 대기.** 8443 적용 후에도 relay(tls)↔SFU 내부(172.19.0.2:50025) 페어 즉시 failed = TURN CreatePermission 거부 형상. 그록봇 진단 릴레이(livekit 로그·rtc 섹션·node/advertise IP) 준비됨 — 발신은 그록봇 앱 필요.

## 부수 발견
- **#1848(uxui)** 웹 명부 역할 변경 UI 부재 — 서버 PATCH /role 존재하나 미배선. **구현 대상(성재 확인).** 브리프 미작성 → Fable 재개 시 첫 후보.
- Grok Bot = `hosted-agent` → S4 generic 자격 409 차단. **S4는 generic 에이전트 신설 필요.**

## 정본 ID
- workspace = `00000000-0000-7000-8000-000000000001`
- Grok Bot(hosted) = `01a0327f-a57f-7ae6-9bb8-b1a659faa08f`
- Comptest-fable(테스트 계정, 멤버) = `01a046de-07b6-7ec0-ada1-6357ae9cd197`
- 테스트 계정 자격: `scratchpad/test-account.txt`(로컬, 비유입). 채널: general(201)·agent-lab(202, @grok 상주).

## 성재 대기 (둘 다 독립)
1. **Comptest-fable admin 승격** — owner curl 1회(비번=성재 터미널만). 시트: `scratchpad/promote-curl.sh`. 되면 Fable이 generic 에이전트 생성→자격(messages:read+write) 발급→**S4 매트릭스 5항** 자율 대행.
2. **결함 B 진단 릴레이** — 그록봇 앱 free 시 Fable 타이핑, 또는 성재 붙여넣기(2-paste). 릴레이 문구: `scratchpad/relay-turn-diag.txt`.

## Fable 재개 순서 (제안)
1. 정렬 확인(이 체크포인트 랜딩 시 `main ⊂ 두 트랙` 복구됨). #1849는 uxui만 — 결함 B 산출물과 batch 승격.
2. 성재 승격 완료 신호 → S4 자율 실행(generic 에이전트·자격·매트릭스).
3. 결함 B 진단 응답 → 서버/설정 수리 티켓(uxui or engine) → 수리 후 S1-a/b/c(relay/tls·2대 오디오·soak) 재개.
4. #1848 역할 UI 구현 브리프 발주(grok).
5. 허들 축 폐곡선 시 A+B batch 승격 창.

## 앱 제어 학습(반복 함정)
- 한글 IME가 cliclick·osascript keystroke를 자모 변환 → 텍스트 투입은 pbcopy+Edit>Paste. Electron은 AXManualAccessibility=true 선설정 후 AX 트리 접근(383 요소), Orchestrator 진입=AXPress. 전송 버튼은 AX 미노출 → 컴포저 focus 후 CGEvent Return(postToPid). 무접촉 캡처=`screencapture -l <windowID>`.
