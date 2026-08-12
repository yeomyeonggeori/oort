# Grok Bot trial-first 스파이크 보고서 — MCP transport·Routine 측정 완료 (#1344)

- 관측 시각: **1차 2026-08-12 19:07 KST / 10:07Z · 2차 2026-08-12 20:44 KST / 11:44Z · 3차 2026-08-12 후속 세션(정밀 시각 미기록)**
- 환경: macOS 26.5 · Apple Silicon (`arm64`)
- 범위: 공식 앱 설치 무결성, team·personal account 접근, private custom-MCP loader 왕복, Routine manual execution, 개별 cleanup 표면
- 판정: **PASS(측정 goal) — transport와 manual routine은 검증, auth·pairing·tool call·full E2E는 HAP-E2/E3 이후로 이관**

이 보고서는 #1344의 trial-first 실측을 비밀정보 없이 재현 가능한 결과로 남긴다. 첫 team account 시도는 강제 Privacy Mode에서 막혔지만, personal account에서는 별도 trial entitlement/start 문구나 결제·구독 UI 없이 테스트 Bot 1개와 기본 채팅, private Plugin, Routine을 실행했다. 공식 MIT `Create Plugin`이 만든 local plugin의 MCP loader는 oort 공개 endpoint까지 실제 요청했으며, 서버 route가 아직 없어 HTTP 404에서 멈췄다. 결제·구독 구매는 0건이다.

## 1. 공식 앱 공급망 확인

| 항목 | 관측 결과 |
|---|---|
| 다운로드 | `https://downloads.cursor.com/sand/stable/darwin-arm64/0.16.0/Grok_Bot_0.16.0.dmg` |
| DMG SHA-256 | `6dae3cc5259eecd749b28e3622fe9f0333d7aacb32dd71c03dc7fac658617cd4` |
| DMG 컨테이너 | `hdiutil` checksum valid |
| 앱 버전 | `0.16.0` |
| bundle identifier | `com.anysphere.sand` |
| 실행 아키텍처 | `arm64` |
| 코드 서명 | strict verification valid |
| Gatekeeper | `accepted` · source=`Notarized Developer ID` |
| 서명 주체 | Anysphere Incorporated (`DCNK4UB866`) |

검증 결과만 기록했고 원본 명령 출력이나 로컬 사용자 경로는 커밋하지 않았다. 설치는 성재의 명시 승인 뒤 수행됐다.

## 2. 계정·trial·접근 게이트 관측

계정은 구체적인 사용자·team·organization 이름을 제거하고 **조직 관리 team account**로만 기록한다.

| 신호 | 관측값 | 해석 범위 |
|---|---|---|
| trial eligibility | `true` | 현재 계정에 trial 자격 신호가 존재한다. “trial 미노출”이 아니다. |
| 앱 접근 상태 | `PAYMENT_REQUIRED` | UI/runtime 상태 코드다. 아래 명시적 차단 원인과 함께 해석한다. |
| 차단 원인 | `TEAM_PRIVACY_MODE` | billing 자체가 아니라 team privacy policy가 이름 붙은 차단이다. |
| 강제 privacy mode | `NO_STORAGE` · team-enforced | 사용자가 이 앱 안에서 임의로 완화할 수 없는 조직 정책이다. |
| UI 상태 | `Request sent` | 정책 변경 요청이 제출된 상태로 표시됐다. 대상 team·사용자 식별자는 기록하지 않았다. |
| UI 권고 | personal account 사용 | 다음 최소비용 재시도 경로다. 로그인·MFA는 성재가 직접 처리한다. |
| 구매·유료 전환 | **0건** | 결제 화면 진행·구독 구매를 하지 않았다. 별도 trial activation 화면이나 시작 문구도 관측하지 않았다. |

`trialEligible=true`와 `TEAM_PRIVACY_MODE`/`NO_STORAGE`가 동시에 관측됐으므로 `PAYMENT_REQUIRED`만 떼어 “유료구독이 필수”라고 결론내리지 않는다. 이번 시도가 입증한 것은 **현재 team 계정은 조직 privacy policy 때문에 trial 제품 표면에 진입할 수 없다**는 사실뿐이다.

## 3. personal account 접근·제품 표면 관측

성재가 personal account 로그인과 앱 인증을 직접 완료했다. 계정 이메일·표시명과 생성한 Bot의 표시명은 기록하지 않았다.

| 표면 | 관측 결과 | 판정 |
|---|---|---|
| 앱 접근 | `0.16.0`에서 Bot 1개 생성 후 기본 채팅 실행 | **검증됨** |
| 비용 게이트 | 결제·구독 UI 미노출, 구매·유료 전환 0건; 별도 trial entitlement/start 문구 미관측 | **이번 경로 검증됨**, 영구 무료 tier 추정 금지 |
| Plugin Marketplace | Gmail·Calendar·Drive·Slack 등 remote MCP 설명 plugin과 공식 `Create Plugin` 진입점 노출 | **표면 검증됨** |
| Create Plugin provenance | `https://github.com/cursor/plugins`의 MIT `Create Plugin`을 공식 UI로 설치하고 측정 뒤 helper를 uninstall | **검증됨** |
| Private custom plugin | 미게시 local `oort-integration-trial`을 `.cursor-plugin/plugin.json`과 `mcp.json` 두 파일로 생성하고 공개 `https://app.oor7.com/v1/mcp/agent-port` 등록 | **검증됨**; credential 0 |
| Plugin Yours | connector가 `Added manually`·`HTTP`·공개 URL·`Tools 0`로 표시 | **표면 검증됨** |
| Loader network | 실제 legacy-era `POST initialize`와 fallback `GET` 모두 Caddy를 거쳐 HTTP/2 404 empty response; UI `Failed to load` | **transport 검증됨**; oort Rust route 부재, 요청 protocol version 미수집 |
| Auth/discovery/tool | 404가 auth challenge와 initialize success보다 먼저 발생 | `runtime-unverified`; mode·header/OAuth·tool 추정 금지 |
| Routine draft/trigger | `Active`, `Delete`, `Test run`, `Name`, `Instruction`, schedule·Slack·Git·Teams·Linear·Sentry·PagerDuty 확인 | **표면 검증됨** |
| Routine persistence | Active off·monthly trigger를 가진 안전 routine을 저장 | **검증됨** |
| Routine Test run | manual run 약 1분 뒤 exact `OORT_ROUTINE_TRIAL_OK`, 상태 `Succeeded` | **manual execution 검증됨**; MCP tool·scheduled wake는 미검증 |
| Routine Delete | 확인창 없이 즉시 실행되고 routine 목록에서 제거 | **개별 UI cleanup 검증됨** |
| Connector Uninstall | connector 목록에서는 제거됐지만 local plugin directory와 두 source file은 잔류. 관측 뒤 test source만 recoverable Trash로 이동 | **부분 cleanup 검증됨**; 목록 제거≠local source 제거 |
| Bot 삭제 | context menu의 Delete가 agent와 chat history를 영구 삭제한다고 경고해 최종 삭제 취소 | 공식 문서는 Bot-owned routine 제거를 설명하지만 live 미실측; connector/local source 연쇄는 미문서·미실측 |

Bot 삭제 확인창에는 routine이나 plugin/connector가 함께 정리되는지 명시되지 않았다. 공식 문서는 Bot 삭제가 그 Bot의 profile·conversation·owned routines를 제거하고 shared files/sign-ins는 남을 수 있다고 설명하지만, 최종 삭제를 취소했으므로 live cascade 증거로 세지 않는다. connector/local source cascade는 공식 문서에서도 확인하지 못했다. Routine은 trigger를 지정해 persistent artifact로 만든 뒤 Active off 상태에서 수동 실행했고, 개별 Delete 뒤 목록에서 사라진 것을 확인했다. connector Uninstall은 provider 목록에서만 제거됐고 local source는 남았으므로 두 cleanup 대상을 구분해야 한다. 측정 뒤 test source는 경로를 기록하지 않은 채 recoverable Trash로 옮겼으며, 이 수동 조치는 provider Uninstall의 cleanup 능력으로 세지 않는다.

private plugin의 `mcp.json`에 임의 HTTPS URL을 등록하고 loader HTTP가 도달한 것은 실제 증거다. 그러나 404 empty response는 MCP initialize 성공, header/OAuth auth, pairing credential 교환 또는 tool call의 증거가 아니다. 이 항목은 HAP-E2/E3 route가 선 뒤 별도 E2E로 검증한다.

## 4. #1344 수용기준 판정

| 수용기준 | 누적 결과 | 상태 |
|---|---|---|
| 공식 앱 설치 승인·사용자 직접 로그인 경계 | 설치와 ADR 기술 방향을 성재가 명시 승인했다. 비밀번호·MFA를 전달받지 않았다. | 완료 |
| 앱 version·account tier·trial 노출 redacted evidence | 앱 `0.16.0`, team account eligibility/policy gate와 personal account 앱 접근·Bot 생성까지 기록했다. | 완료 |
| trial 노출 시 별도 승인 뒤 1회 시작·구매 0 | 성재가 personal account 인증을 완료했고 별도 trial activation 문구나 결제·구독 UI 없이 Bot·채팅·Plugin·Routine에 도달했다. 구매 0. | 무구매 접근 검증됨; entitlement는 단정하지 않음 |
| custom remote MCP discovery/auth UI | private local plugin에 임의 public URL을 등록했고 loader `POST initialize`/`GET`이 도달했다. route 404 때문에 auth challenge·initialize success는 미도달. | transport 완료 · auth/discovery `runtime-unverified` |
| Bot/routine connector 호출·cadence·provenance·retry | Active-off monthly routine의 manual Test run은 약 1분 뒤 exact sentinel과 `Succeeded`. MCP tool, scheduled cadence, retry는 미측정. | manual execution 완료 · 나머지 후속 |
| pairing challenge와 active credential 교환·갱신 | route가 없어 auth/pairing 전에 404로 종료됐다. | HAP-E2/E3 후속 `runtime-unverified` |
| routine·connector 비활성화/삭제·cleanup 증거 | routine Delete는 즉시 목록 제거. connector Uninstall은 목록 제거 뒤 local source 잔류. Bot 삭제는 취소했으며 공식 Bot-owned-routine cascade는 live 미실측이다. | 개별 UI 부분 완료 · connector/local-source full cleanup 후속 |
| trial 미노출 시 구매 없이 blocked evidence | personal 경로는 별도 trial entitlement 문구를 관측하지 못했지만 제품 접근이 성립해 blocked 조건은 성립하지 않았다. team 경로의 privacy policy 차단 증거는 별도로 남겼다. | 조건 불성립 · entitlement 미판정 |

#1344는 구현 전 측정 goal로서 personal access, custom-MCP transport, manual Routine, 개별 cleanup 동작까지 완료했다. auth/pairing/tool call/full disconnect는 아직 존재하지 않는 Agent Port route를 먼저 구현해야 하므로 HAP-E2/E3와 후속 Grok E2E로 이관한다. 따라서 #1344는 문서 게이트·리뷰 뒤 완료할 수 있지만, “Grok Bot 연결 검증됨” 또는 “Bot 삭제가 routine/plugin도 제거한다”는 카피는 아직 사용할 수 없다.

## 5. 후속 E2E 재현 절차

1. HAP-E2가 `/v1/mcp/agent-port`의 modern `server/discover`/per-request metadata와 exact legacy initialize compatibility, static-bearer challenge를 제공한 뒤 같은 형태의 private plugin을 새로 만든다. 이전 plugin source나 secret을 재사용하지 않는다.
2. raw secret을 screenshot·로그·prompt·URL에 남기지 않고 Grok/Cursor loader의 header/OAuth/redirect 동작과 실제 tool discovery를 측정한다.
3. HAP-E3의 one-time pairing과 별도 active proof를 거쳐 pair→detect→confirm을 재현하고 replay·wrong-audience를 거부한다.
4. deterministic routine으로 inbox tool→test reply를 한 번 실행한 뒤 oort local revoke를 먼저 확인한다.
5. routine 삭제, connector Uninstall, local plugin source 정리를 각각 확인한다. Bot은 `deleted` 또는 `preserved_intentionally` disposition을 명시하고, 삭제를 선택한 경우에만 별도 test Bot으로 연쇄 cleanup을 측정한다.

## 6. 비밀정보·개인정보 제외 확인

이 문서와 커밋에는 account email, 사용자·Bot 표시명, team/organization 이름, 내부 request/device/team/user identifier, pairing challenge, UUID, password, MFA code, cookie, token, 결제정보, 개인 workspace 내용, local plugin directory path, 원본 screenshot을 포함하지 않는다. 공개 제품 endpoint, test artifact 이름, 제품 상태 코드, 일반화한 UI label과 공급망 fingerprint만 기록했다.
