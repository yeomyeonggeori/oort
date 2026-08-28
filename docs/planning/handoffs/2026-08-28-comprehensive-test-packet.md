# 종합 실테스트 핸드오프 패킷 — 허들·터미널·그록봇·외부도구·UXUI (2026-08-28)

> 성재 방침(2026-08-28, #1825 코멘트 정본): 허들 2대 통화 실검증은 조각으로 하지 않는다.
> **UXUI·허들·터미널·그록봇 연동이 종합으로 테스트 가능한 시점에 성재가 일괄 수행**한다.
> 이 패킷은 그 "가능한 시점"을 만드는 준비 체인과, 일괄 수행 시나리오·PASS 기준의 정본이다.
> 역할: 준비 체인 실행·검수=Fable(오케스트레이터), 코드/문서 작업=grok 4.6 워커, 결재·실테스트=성재.

## 0. 테스트 대상 (전부 main 정본, main=da953b7d 기준)

| 축 | 랜딩분 | 검증 요지 |
|---|---|---|
| 허들 | #1825(TURN 리라이트)·#1783(허들 active)·HD-1(서버 복원) | SPIKE-HD 4·5·6 승계 — 외부 2대 오디오 왕복, relay/tls |
| 터미널 | TC-1(관전 도크)·#1777(remote_attach 수리)·#1778(관전차단 토글 수리) | 실 세션 attach + 토글 왕복 |
| 그록봇 연동 | 릴레이 자율화(SPIKE-HD 실증)·#1785(ACP 이벤트 릴레이) | 멘션 왕복 + ACP 이벤트 기록 |
| 외부 도구 | #1797(자격·쓰기)·#1820(읽기, ADR-0173) | messages:read/write 실측 매트릭스 |
| UXUI | #1770(role_labels)·#1800(workspace settings)·buzz 파도 전량 | 성재 자유 검수(피드백=전량 티켓화) |

## 1. 핵심 갭과 배포 경로 판정

**갭**: 최신 발행은 v0.1.2(2026-08-24) — 위 표의 랜딩분(8/27~28)을 **전부 미포함**.
그록봇 VM 스택은 발행 이미지 기반이므로, 지금 종합 테스트를 돌리면 구버전을 테스트하게 된다.

**판정: 이미지 재발행(v0.1.3)이 정경로.**
- VM 소스 재빌드는 기각 — 플레이북(digest pull)이 정본이고, VM에서의 소스 빌드는 오프-플레이북 드리프트+자원 소모(러스트 풀빌드)만 남긴다.
- 재발행은 셀프호스트 문서 체계(Releases=digest 정본)와 정합하고, 데스크탑 검수 앱과 빌드 원본을 같은 main으로 맞출 수 있다.

## 2. 준비 체인 (순서 고정)

### ① [성재 결재] v0.1.3 발행 창 승인
- 승인 시 Fable이 `gh workflow run publish-images --ref main` 디스패치 → **성재는 `release` environment 승인**(전례 v0.1.1·v0.1.2와 동일, amd64/arm64 잡 승인) → attestation PASS 확인 후 Fable이 Release v0.1.3 생성(digest 표=정본).
- 이 발행은 셀프호스트 이미지 계열이며 라이브 서버 무변경(전례 동일).

### ② [grok] 발행 문면 현행화 + SELF_HOST §6 정정 — 티켓 #1837
- 브리프: `2026-08-28-v013-docs-refresh-brief.md`. 게이트: ① 완료(digest 확정) 후 착수.
- 핵심: §2-B digest pin v0.1.3 갱신(현행 문면은 라벨 v0.1.1·digest는 v0.1.2 혼재 — 정합화 포함), **§6 "오늘 안 되는 것" 단락 정정**(#1820으로 messages:read 개방 — 현행 문면 "읽기 스코프를 넣어도 REST는 403"은 이제 거짓), llms.txt 정합 확인.
- 검수·랜딩·정본화=Fable.

### ③ [Fable] VM 스택 갱신 — 그록봇 릴레이(데스크탑 앱 자율 제어)
- **pull 새 digest + up만. 설정 재생성 금지.** SPIKE-HD 수동 배선 5종 보존 확인이 릴레이의 절반:
  1. `livekit.yaml` turn 섹션(enabled·external_tls·tls_port 8443·domain)
  2. compose: livekit 8443/tcp → 127.0.0.1:8443 바인드(huddle 프로파일)
  3. tailscale funnel 매핑: 8443 tls-terminated-tcp · :10000 시그널 · 443 웹
  4. `MOMO_LIVEKIT_URL=wss://<host>:10000`
  5. **CSP connect-src의 `wss://<host>:10000`** — ⚠️ 최고 위험. 그록봇이 수동 추가한 위치가 컨테이너 내부면 이미지 교체로 소실된다. 갱신 후 **외부에서 CSP 헤더 재검증 필수**, 소실 시 재적용 릴레이.
- 사후 헬스(외부 망, Fable 직접): `/healthz` 200·livekit healthy·`:10000` 200·8443 TLS 악수(openssl, RELAY.md 재실행 명령).
- 적립 메모: 셀프호스트 생성기가 `MOMO_LIVEKIT_URL` 오리진을 CSP에 자동 반영하지 않는 갭 — 종합 테스트에서 재확인 후 티켓 후보.

### ④ [Fable] 데스크탑 검수 앱 재빌드
- main(=v0.1.3 빌드 커밋) 기반 Tauri debug 재빌드 → `~/Desktop/oort-uxui-review.app` 교체, "빌드 원본" 고지와 함께.

### ⑤ [성재+Fable] 테스트 세팅
- **owner 로그인 1회=성재 몫**(자격 경계 — Fable은 비밀번호 비취급). 로그인 상태에서:
  - 외부 도구 자격 발급: `scopes:["messages:write","messages:read"]` (read는 비-default라 명시 필수, SELF_HOST §6 절차).
  - 그록봇 에이전트가 테스트 채널에 초대돼 있는지 확인.
- 도어벨 재시험(벤더+루틴 key 재발급)은 별도 선결이 있어 **이 배치 포함 여부=성재 결정**(미포함이 기본).

## 3. 시나리오와 PASS 기준

### S1 허들 (SPIKE-HD 4·5·6 승계 — #1825 AC 종결)
| 단계 | 절차 | PASS |
|---|---|---|
| S1-a | 외부 브라우저(Fable 맥, tailnet 밖) 허들 참여 → webrtc-internals | ICE에 `turns:<host>:8443?transport=tcp`(리라이트 발동) + candidate pair=**relay/tls** |
| S1-b | 2대 왕복: Fable 맥 + **성재 폰 LTE(Wi-Fi off, ~3분)** | 양방향 오디오 상호 확인 |
| S1-c | 60분 soak(Fable 관측 루프) | 1001 드롭 무재현, 재현 시 관측치 기록(#18827 대조) |
| S1-d(선택) | 3인 대역폭 | 체감 판정 기록 |

### S2 터미널 관전 (TC-1 + #1777·#1778)
- 에이전트 작업 콘솔 세션 개시 → `remote_attach_available=true` 실측 → 데스크탑 관전 도크 attach → 라이브 출력 스트림.
- 소유자 관전차단 토글 on→관전 불가, off→복귀 (400 재현 없음).
- PASS: attach 성립 + 토글 왕복 + 도크 UI 정상.

### S3 그록봇 연동 (+#1785)
- 채널에서 그록봇 에이전트 멘션 → 응답 왕복(실시간 레일 GREEN).
- ACP 이벤트 릴레이: 왕복 중 이벤트가 기록되는지 Fable이 확인(멱등·outbox 경유).
- PASS: 왕복 성립 + 이벤트 기록 실존.

### S4 외부 도구 이중 (#1797 + #1820)
⑤에서 발급한 generic 자격으로 (hosted 3상태 403·교차 테넌트 RLS는 컨포먼스 기증명 — 실측은 generic 경로만):
| 호출 | 기대 |
|---|---|
| POST 채널 메시지 | 201, 에이전트 이름으로 게시 |
| GET 채널 히스토리 | **200** (#1820 개방분) |
| GET 스레드 replies | **200** |
| GET 단일 메시지 | 403 (계속 닫힘) |
| POST replies | 403 (계속 닫힘) |
- PASS: 매트릭스 전항 일치.

### S5 UXUI 스팟 (성재 자유 검수)
- 최근 랜딩 포인트: role_labels 편집(설정>워크스페이스 — operator만·한글 16자·빈값=기본 복원·비운영자 대비 뷰), 허들 UI, 컴포저·스레드·사이드바 buzz 파도.
- 방침: 즉흥 수리 금지 — **피드백 전량 티켓화→시리즈 편성**(2026-08-10 인테이크 방침).

## 4. 기록과 폐곡선
- 증거 정본: `claudedocs/comprehensive-test-20260828/` (S1 webrtc-internals·soak 로그, S2 캡처, S4 응답 원문 — 시크릿 비유입).
- 종료 시: #1825 실검증 이월분 종결 코멘트, SPIKE-HD REPORT 4·5·6 상태 갱신, 발견 결함=전량 티켓화.
- 폴백: S1 실패 시 P2(운영자 TURN) 기결재 경로. S2·S3 실패는 해당 축 티켓화(배치 재시도는 수리 후).

## 5. 성재 액션 요약 (최소 4점)
1. v0.1.3 발행 창 승인 + `release` environment 승인 클릭.
2. VM owner 로그인 1회 + 자격 발급(⑤) — Fable이 명령 시트 제공.
3. S1-b 폰 LTE 3분.
4. 종합 검수 세션(S2·S3·S5 — Fable 배석, S4는 Fable 대행 가능).
