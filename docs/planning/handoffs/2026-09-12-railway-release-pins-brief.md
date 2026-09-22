# Railway app/web 릴리스 pin 정합 수리

- status: ready
- planning ID: PLN-20260912-ASTRA-02
- owner/integrator: Astra (이번 배치)
- base: track/engine @ ed26b020
- supersedes: 없음
- worker: PIPELINE worker 레인, 사용자 지시대로 native Codex Grok 4.6
- GitHub binding: #2499

## Goal / Context
Railway 배포 카탈로그의 app 서비스와 Caddy가 복사하는 웹 자산이 `releases/latest.json`의 같은 릴리스 digest를 사용하게 한다. #2205의 실제 Railway 배포 완료는 이 작은 수리로 주장하거나 닫지 않는다.

## 파일 맵 / red proof
- `releases/latest.json`: v0.1.5 digest sha256:5481c14eccab99d3cbce51fd8b8710fe6fd671e673652cb3e30422b0e66f7a85 (읽기 전용 입력).
- `infra/railway/railway.json`: appImage 및 api/relay/webhook-sender/agent-worker는 v0.1.4 digest sha256:7426d282b67270ff3d52c4cbf1f5136ea038ae104a2c9dbb971ef71f8694d37f.
- `infra/railway/Dockerfile.caddy`: OORT_IMAGE ARG도 이전 digest.
- `scripts/tests/test_railway_template.sh`: 현재 engine에서 실행 exit 1, appImage != latest.json. 서비스별 값과 Caddy ARG 누락도 막아야 한다.
- `scripts/local_gate.sh`: docs 프로파일에서 위 시험을 이미 호출한다. 게이트 우회/약화 금지.

## Acceptance (정본)
1. 최신 manifest 기준 appImage, 네 app 서비스 image, Caddy 웹 자산 source ARG를 동일 digest로 고정한다. 외부 서비스 이미지는 변경하지 않는다.
2. 회귀 시험은 각 pin을 독립적으로 검사한다. appImage만 맞고 서비스 하나 또는 Caddy가 뒤처지면 실패한다. 누락/잘못된 source도 성공 처리하지 않는다.
3. 스크래치 사본에서 각 보호 값을 이전 digest로 개별 변조하면 실패함을 증명하고 원래 트리는 깨끗하게 복원한다.
4. 기존 Railway 계약 시험과 local_gate docs 완주. 검증 결과와 실제 플랫폼 재배포 미검증을 구분한다.

## 범위 / 정책 감사
허용 파일: infra/railway/railway.json, infra/railway/Dockerfile.caddy, scripts/tests/test_railway_template.sh, 필요한 경우 같은 디렉터리의 집중 회귀 시험, 이 패킷 metadata, STATUS 상단 1~3줄. scripts 수정은 이 시험의 강화만 명시적으로 허용한다. planner 독립 정책 감사가 필수다. .github/**·게이트 wrapper·release manifest 변경 금지. persistence/notifier/실제 Railway 계정 작업은 별도 goal.

기존 작업을 덮어쓰지 않는다. 이슈 전용 engine worktree만 수정. 공유 env/기존 컨테이너/데이터 사용 금지. 게이트 동시 실행 금지, 큰 게이트는 Astra에게 슬롯 확인 후 실행. 외부 MCP·배포·release 금지; 로컬 파일/셸·gh 구현 도구 허용.

## 착수 / 완료 / 이탈
AGENTS.md → TRACKS(엔진) → 패킷 → Issue → 최신 STATUS/ROADMAP/BUILD_TICKETS 순서. 시험을 먼저 red로 확인하고 수정한다. branch를 정렬 preflight 후 push, 1 Issue=1 PR로 track/engine에 제출하고 goal_release --review 후 정지. merge/issue close/정책 감사 자가 승인 금지.

DONE / COMMITS / GATES / PR / NOTES(계획 이탈), 수정 파일 목록을 보고한다. 패킷 canonical 선행 랜딩은 이 inherited docs 실패 때문에 수리와 같은 PR로 순서를 조정한다. 사용자 지시의 Astra/Grok 편성을 적용하되 기존 Fable PR은 인수하지 않는다.
