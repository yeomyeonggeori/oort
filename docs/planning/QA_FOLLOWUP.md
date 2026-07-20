# QA·검증 팔로업 트래커 (2026-07-20 개설, Fable)

> 성재 지시: "수동 QA는 계속 팔로업, 샌드박스·내부 검증은 어떻게 수행·검증할지 고민해 문서로 하나씩 팔로업. 필요 시점에 같이 진행."
> 목적: runtime-unverified·manual·pilot 항목을 한 곳에서 추적. 각 항목 = **무엇 / 검증 방법(누가) / 현재 상태 / 트리거 / 수용 조건**.
> 정본 관계: 검증 부채 요약은 ENGINE_HANDOFF §C, 실측 데이터는 research/17, 이 문서는 "어떻게 검증하나"의 실행 가이드.

## 범례
- **[자동]** = Fable가 verifier/스크립트로 수행 (성재 개입 0)
- **[함께]** = 성재 환경(서버·기기·마이크·구독) 필요, Fable가 절차 안내·판정
- **[성재]** = 성재 단독 수행 (탭·인증 등)

---

## Q1. A-10 Interactive Work Console 실사용 1사이클 [함께] — C-2 통합
- **무엇**: 채팅 멘션 → 에이전트 spawn → 승인 카드 → control dispatch → 로컬 PTY 실행(claude/codex) → input/read/kill → ack → 발췌 스레드 공유. A-10 UI + 483/484/486 엔진 + 실 Codex의 전 경로.
- **검증 방법**: self-hosted 서버 로그인 상태의 dev 앱(SwiftPM 빌드 — 샌드박스 아님)에서 Work 서랍 열기. Fable가 단계별 체크리스트 제공, 성재가 실 Codex로 1왕복, 각 단계 산출물(승인 카드·세션 카드·스레드 발췌) 스크린샷으로 판정.
- **현재 상태**: 엔진 483/484/486/487 랜딩, A-10 track 검수 완료·main 리뷰 대기. 로컬 데모 backend는 Work API 미지원(disabled 정상) → **실 서버 필수**.
- **트리거**: A-10 main 머지 + 성재 self-hosted 서버 기동 가능한 시점.
- **수용**: 1왕복 전 단계 성공 + 서버 원장/스레드에 raw·cwd·토큰 미유입 육안 확인.

## Q2. App Sandbox 배포 정책 결정 [Fable 기안 → 성재 결정]
- **무엇**: dev(SwiftPM) 빌드는 PTY 동작, 배포(Xcode App Sandbox) 빌드는 fail-closed. 배포판에서 PTY를 열려면 ①App Sandbox 해제(App Store 불가·공증 직접배포 가능) 또는 ②비샌드박스 로컬 helper 경유 중 택1 — 보안 결정.
- **검증/판단 방법**: 이건 테스트가 아니라 **ADR 결정**. Fable 분석: **②가 우리 로드맵과 정합** — ADR-0125의 momo-workd(T2, MOMO-488)가 정확히 "비샌드박스 로컬 호스트"다. 즉 배포판 앱은 샌드박스 유지 + PTY는 workd에 위임하면 App Store 경로도 열린다. dev 빌드는 앱 내장 PTY(T1) 그대로.
- **현재 상태**: A-10이 샌드박스에서 fail-closed(안전 기본값) — **머지 blocker 아님**(dev 경로 완전 동작). 배포 정책은 M8(스토어) 선행 결정으로 분리 가능.
- **트리거**: M8 스토어 배포 준비 또는 배포판 dogfood 필요 시. 그 전에 ADR-0114 보강(D1에 "배포판=workd 위임" 명문화) 1건.
- **수용**: ADR 결정 Accepted + 선택안대로 배포 빌드에서 PTY 경로 실동작.

## Q3. X-6 auto-approve snapshot 조회 계약 [자동] — 엔진 티켓
- **무엇**: 484 auto-approve는 PUT/DELETE만 있고 GET/list가 없어 앱 재시작 직후 설정 복원 불가(A-10은 정직하게 `unknown` 표시).
- **검증 방법**: 엔진 소형 goal — `GET /v1/workspaces/:ws/work-auto-approve` 추가 + verify_work_control에 snapshot 왕복 단정. Fable가 worker+게이트로 완결.
- **현재 상태**: ENGINE_HANDOFF X-6 `ready`(역핸드오프 등록됨).
- **트리거**: 489/490 사이 또는 A-10 머지 후 UXUI가 소비하겠다고 하면.
- **수용**: verifier PASS + UXUI가 재시작 후 auto-approve 상태 복원.

## Q4. C-4 상호작용 실 WebSocket 2-클라이언트 [자동 우선, 함께 보조]
- **무엇**: 수정/삭제/반응이 두 번째 클라이언트에 실시간 반영(X-5는 history API+Core 회귀로 검증, 실 ws 구독 왕복은 미실증).
- **검증 방법**: **[자동]** 실 Centrifugo ws를 구독하는 2-클라 verifier(SwiftCentrifuge 또는 python ws 클라이언트로 published frame 수신 단정) 신설 → Fable. **[함께]** 대안: 성재가 맥+아이폰으로 한 메시지 수정→타 기기 반영 육안.
- **현재 상태**: ENGINE_HANDOFF C-4 등재. work.session/control도 같은 ws 경로라 이 verifier가 A-10 realtime까지 커버.
- **트리거**: 엔진 Host Fabric 배치 마무리 후 검증 부채 정리 라운드.
- **수용**: 2-클라 verifier가 4종 상호작용 + work.* 이벤트 수신 단정 PASS.

## Q5. C-1 허들 2-클라이언트 실오디오 [함께]
- **무엇**: LiveKit 허들에서 두 참가자 간 실제 오디오 왕복(V-1~3b는 lifecycle/JWT/토큰만 검증, 실 미디어 미실증).
- **검증 방법**: 성재 맥 2개(또는 맥+아이폰) + 마이크. Fable가 허들 시작·참가 절차 안내, 성재가 오디오 육안(청취) 확인.
- **현재 상태**: ENGINE_HANDOFF C-1. compose `huddle` 프로파일 opt-in.
- **트리거**: 성재 마이크·2기기 가능한 시점(A-5 UI와 함께).
- **수용**: 양방향 오디오 청취 확인.

## Q6. C-3 iOS deep link 실기기 재확인 [성재]
- **무엇**: 알림 탭 deep link가 채널 목록에서 멈추는 이슈(MOMO-469) 재확인.
- **검증 방법**: 성재 아이폰 케이블 Run 1회 + 푸시 탭.
- **현재 상태**: ENGINE_HANDOFF C-3.
- **트리거**: iOS 트랙 재개 시.
- **수용**: 딥링크가 대상 채널로 정확히 이동.

## Q7. T3 파일럿 잔여 (research/17-01) — E2/E3/E5
- **E2 경제 실측 [자동]**: 중간 시나리오(세션 3×일3h) 4일 상시 구동 → 실청구액 vs $0.10/h 추정 대조·스탠바이 0과금 검증. Fable가 상시 러너 스크립트로. **트리거**: 성재 "E2 ㄱㄱ"(비용 발생 4일).
- **E3 구독 OAuth [함께]**: 샌드박스 안 `claude` 로그인 → 볼륨 영속 → 재기동 후 7일 유지. Fable가 샌드박스 기동, 성재가 폰 인증 1회. **트리거**: 성재 5분 가능 시.
- **E5 momo 통합 데모 [함께]**: 484 경로로 채팅→spawn→샌드박스 실행→스레드 회신을 E2B 샌드박스에서(T3 실기질). 성재가 승인 카드 탭. **트리거**: 488 랜딩 후(workd/호스트 계약 필요).
- **현재 상태**: E1(지연)·E4(L-base 공유) 완료·판정선 통과. 예산 상한 $150/월(실집행 $50~100 예상).
- **수용**: E2 원가 ≤$30/인 · E3 무재로그인 7일 · E5 1왕복 성공 → ADR-0125 D3 기질 확정.

## Q8. MOMO-491 push_relay Ed25519 openssl 이식 [자동]
- **무엇**: verify_push_relay/push_relay_keygen이 verify_work_host와 동일 openssl ED25519 패턴 → relay 프로파일 게이트를 bash -l로 돌리면 LibreSSL 함정 재발.
- **검증 방법**: find_openssl 리졸버 이식 + relay 프로파일 게이트를 bash -l로 1회. Fable 완결.
- **현재 상태**: 이슈 #524 `ready`.
- **트리거**: 엔진 배치 여유 시(소형).
- **수용**: relay 프로파일 게이트 bash -l PASS.

---

## 실행 원칙 (재발 방지 메모)
- verifier는 **게이트 방식(`bash -lc`)으로 최소 1회** 확인 — zsh 단독 통과가 게이트 통과를 보장하지 않음(openssl LibreSSL 함정 전례).
- 게이트 반복+파일럿 병행 시 Docker VM(7.7GB) 압박 → 배치 종료마다 `momo-docker-reclaim` + build cache prune.
- worker 산출 verifier는 docker 미실행이라 첫 실런에서 SQL 함수·NULL 의미론·계약 모순이 드러남 — **실검증이 정적 리뷰를 대체하지 않는다**(479/487/486/522 전례).
