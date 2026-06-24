# momo — 스토어 검수 게이트 (마일스톤, 스토어 제출 선행)

> **이 게이트를 PASS하기 전에는 `release-ios.yml` / `release-macos.yml`를 트리거하지 않는다.**
> 목적: "빌드 파일이 실제로 사용 가능"함을 빡세게 판명한 뒤에만 스토어/공증 배포로 진행.
> 현재 상태(STATUS.md): Phase 0 컴파일만 통과, **런타임 미검증**. → 이 게이트는 아직 OPEN(미통과).
>
> 📐 **객관 통과기준(measurable DoD) = `docs/cicd/05-qa-release-gate.md`.** 이 파일(03)은 체크리스트(무엇), 05는 "사용 가능 완전 판명"의 수치/방법(어떻게 증명)·PASS 기록 양식.
> 관련: `06-beta-testflight-plan.md`(베타) · `07-crash-analytics-spec.md`(크래시-free 계측) · `08-e2e-accessibility-performance.md`(e2e/접근성/성능) · `09-qa-codex-tickets.md`(Codex 티켓).

## G-0. 런타임 e2e (STATUS.md §5 선결)
- [ ] docker(PG18+Centrifugo v6) 기동 → `make migrate`(001→002) 멱등 적용.
- [ ] 서버 기동 → `GET /health` green.
- [ ] 메시지 송신 → `channel_seq` 갭리스 발급 + outbox→relay→Centrifugo publish 왕복.
- [ ] RLS 테넌트 격리 확인(워크스페이스 간 행 미노출).
- [ ] AgentWorker↔hermes SSE 실연결: 김인턴 멘션→스트리밍 응답 1회 + reserve/reconcile 비용 기록.

## G-1. macOS .app 사용성
- [ ] `clients/macOS`에 Xcode App 프로젝트 추가 → `.app` 번들 산출(C1 티켓).
- [ ] 실기기(개발자 머신) 기동: 로그인 → 채널 입장 → 메시지 송수신 → 에이전트 응답 렌더(D Live Tool-Call) 1회.
- [ ] 비용 호흡 링(B) / 승인 인박스(C) 실데이터 바인딩 표시.
- [ ] 크래시 0, 콘솔 에러 0(치명), 권한 prompt(네트워크/알림) 정상.

## G-2. iOS 앱 사용성
- [ ] `clients/iOS` 디렉터리 + Xcode App 프로젝트 생성(C2 티켓).
- [ ] 시뮬레이터 + 실기기에서 G-1과 동일 시나리오 통과.
- [ ] 멀티팀: 고유 초대코드 자가가입 → 워크스페이스 격리 확인(10인=1팀, 3+팀).

## G-3. 스토어 메타/정책 사전점검
- [ ] App Store Connect App 레코드 + Bundle ID 등록.
- [ ] 개인정보 처리방침 URL, App Privacy(데이터 수집) 라벨 작성.
- [ ] 스크린샷(필수 기기 사이즈), 아이콘, 설명 초안.
- [ ] `deliver`/`precheck`로 메타데이터 사전검증 1회(submit_for_review:false).
- [ ] (법무) 라이선스/약관/수출규제(암호화 사용 신고 ITSAppUsesNonExemptEncryption) 검토 — **법률 자문 아님**.

## G-4. CI 그린
- [ ] `ci-build.yml` 통과(swift build/test + Xcode app 빌드).
- [ ] `fastlane ios beta`(TestFlight) 비대화형 성공 1회(내부 테스터).

## G-5. 객관 통과기준 (수치 — 05 문서가 정본)
> 아래는 요약. 정의/측정법/임계 근거는 `docs/cicd/05-qa-release-gate.md` §1~§9.
- [ ] **G-A 크래시-free**: 세션 ≥ 99.5% AND 유저 ≥ 99.0% (분모=세션/유저 수 + 윈도우 일수 명기), 신규 P0/P1 crash 0. (Sentry/MetricKit, 05 §2)
- [ ] **G-B 핵심플로우 e2e**: 8/8 PASS, 치명 결함 0. (XCUITest + 수동 스모크, 05 §3 / 08 §1)
- [ ] **G-C 접근성**: `performAccessibilityAudit` 치명 위반 0 + VoiceOver 핵심플로우 조작 가능. (05 §4 / 08 §2)
- [ ] **G-D 성능**: 콜드 런치 p90 < 2s, hang ≈ 0, 메모리/스크롤 안정(실기기·Release). (05 §5 / 08 §3)
- [ ] **G-F 베타 피드백**: 전수 트리아지, P0/P1 잔여 0. (TestFlight + ASC API, 06 §3)
- [ ] **G-G 릴리스 준비 체크리스트**: 05 §9 (메타/프라이버시/암호화 신고/버전·빌드번호) 100%.

## PASS 판정
위 **G-0~G-5 전부 체크 + 증거 첨부** → 게이트 **PASS**. 이 파일 상단에 05 §10 PASS 블록(날짜+커밋해시+빌드#+증거 링크) 기록.
→ 이후에만 `v*.*.*` 태그로 release 워크플로우 가동. **기록 없는 release 트리거는 규칙 위반.**
</content>
