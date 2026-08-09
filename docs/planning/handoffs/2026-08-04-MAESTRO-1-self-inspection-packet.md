# 핸드오프 패킷 MAESTRO-1 — 모바일 자동 검수 레인 (오케스트레이터 셀프 인스펙션)

- status: **ready** · worker: Opus 5 · 기준: `origin/track/engine` 최신 · 새 워크트리
- 발단: 성재 지시 원문 — *"maestro나 뭔가 써서 알아서 확인좀 하고, 최종검수(파이널 체크)같은거에만 날 부르면 안돼?"* → 이후 배치의 폰 UI 검수를 오케스트레이터가 시뮬레이터에서 자동 수행한다.

## Goal — `npm run lane:phone` 한 번이면: 로컬 스택 → 시뮬 설치 → Maestro 플로우 → PASS/FAIL 보고

1. **로컬 서버 스택**: 레포의 기존 게이트 스택 패턴 재사용(compose, 격리 포트·프로젝트명 — `docs/MULTI_SESSION_OPS.md` §4·`compose_janitor` 규약 준수, 끝나면 `down -v`). provider는 **`internal-host-mock` 모드**(서버가 목 응답 — ChatGPT 불요)로 세팅.
2. **픽스처**: `scripts/verify_web_login_smoke.sh:118-137`의 기성 패턴 그대로 — 일회용 멤버+비밀번호(`momo_password_hash`)를 데모 워크스페이스에 INSERT(시드 불변). 에이전트 1명 + `enabled_tools=["work.session.end"]`(승인 플로우용).
3. **시뮬 앱**: `scripts/build-sim.sh` 재사용(iPhone 17 Pro 계열). 앱의 서버 주소를 로컬 스택으로 프리필하는 방법은 connect 흐름(`serverBase.ts`·mDNS/수동 입력)에서 실측 — launch env/딥링크가 있으면 그걸, 없으면 Maestro로 입력 단계 자동화.
4. **Maestro 플로우** (`clients/mobile/maestro/*.yaml`, Maestro는 `~/.maestro` 설치본 — 설치 스크립트 포함):
   - `00-login`: 서버 연결→로그인→채널 목록
   - `10-mention-working`: 멘션 전송→(목 provider 지연 응답)→**「작업 중」 표시 단정**→응답 도착
   - `20-stop`: 턴 중 중단 탭→확정 문장 단정→확정→영수증+취소 시스템 라인
   - `30-approval`: 툴콜 유도(목이 tool_call을 내게)→결정 대기 탭→무장→확정 문장→승인→영수증
   - `40-agents-tab`: 에이전트 탭 상태·재우기 토글·자고 있음 시스템 라인
5. **러너**: `clients/mobile/scripts/lane-phone.sh` — 스택 기동→픽스처→빌드/설치→플로우 순차→**플로우별 PASS/FAIL + 실패 시 스크린샷 경로**를 마지막에 표로 출력→스택 회수. 목 응답에 **지연 편차**를 넣어 「작업 중」이 실제로 관찰 가능하게(#839 규율).

## 함정·계약

- 목 provider가 tool_call을 낼 수 있는지는 `internal-host-mock` 구현에서 실측 — 안 되면 그 목을 최소 확장(서버 코드 수정 허용, 목 경로 한정)하고 이탈 보고.
- 시뮬은 푸시(APNs)가 없다 — `30-approval`은 인앱 결정만 검증하고 잠금화면 푸시는 "실기기 파이널 체크 항목"으로 러너 출력에 명시.
- 성재 로컬 Docker 발열 전례([[momo-docker-resource-accumulation]]) — 스택은 반드시 회수, 러너 재진입 시 고아 스택 청소 선행.
- 수정 범위: `clients/mobile/**`(maestro/·scripts/) + 로컬 스택 셋업 스크립트 + (필요시) mock provider 한정 서버 수정. 프로덕션 접촉 금지.

## 검증

러너 2회 연속 실행 전 플로우 green(두 번째는 청소 경로 검증) + 일부러 결함 주입(예: 작업 중 단정 셀렉터 제거) 시 이름 있는 FAIL — red proof.
