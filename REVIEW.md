# REVIEW.md — oort 검수 기준 (정본)

워커·검수 에이전트(design-review·보안·코드)·사람이 같은 기준으로 PR을 보게 하는 문서예요. 검수 프롬프트에는 2~5절을 그대로 넣어요(복사용 요약은 7절).

이 문서는 **계약을 바꾸지 않아요.** 계약의 정본은 그대로예요.
- UI는 독립 design-review **Blocker 0·High 0**([AGENTS.md](AGENTS.md)). 화면 검수의 단계와 세부 SLA는 [review-rubric](.claude/skills/momo-design-taste/references/review-rubric.md)가 정본이에요.
- 보안 경계는 독립 보안 검수와 시험 의무예요([ADR-0214](docs/adr/0214-security-claims-need-tests.md)).
- 트랙 머지 전 병합 트리 확인은 **1회**예요. 같은 base·patch면 결과를 재사용하고 다르면 다시 돌려요. 스택 PR은 착륙 때 `--typecheck-only`, 전체는 스택 검증에서 1회예요([PIPELINE](docs/planning/PIPELINE.md) §5).
- 정책 파일은 지정 owner의 감사 코멘트와 승인 라벨이 필요해요([GITHUB_OPS](docs/GITHUB_OPS.md)).

여기서 정하는 것은 「무엇을 지적하고 무엇을 지적하지 않는지」, 「지적을 어떤 모양으로 내는지」, 「몇 번 보는지」뿐이에요.

## 1. 보는 질문
「이 변경에서 무엇이 잘못될 수 있고, 어떤 검사가 그걸 잡나」를 봐요. 검수는 diff를 읽는 일이고, 검증은 실제로 돌려 보는 일이에요. 「빌드 통과」는 증거가 아니에요. 변경 종류에 맞는 증거를 봐요: 명령줄은 실제 명령, 화면은 캡처, 마이그레이션은 실제 입력, 저장은 다시 읽기.

## 2. 막는 것 (Blocker·High — 고치기 전에는 못 가요)
- **보안 경계.** 인증·권한·테넌트 격리(`workspace_id`·RLS FORCE·tx마다 `SET LOCAL app.workspace_id`), 비밀·토큰 노출, 바깥 입출력 가드(서명 검증·SSRF), 공개 API·DB 계약.
- **데이터 손실·불변식 깨짐.** 단일 쓰기 경로(REST send → `channel_seq` 증가 + message INSERT + outbox INSERT 단일 tx → relay → Centrifugo), `message.seq` 순서, `client_msg_id` 멱등성, 클라이언트 직접 publish, `schema_v0.sql` 수정.
- **사용자 눈에 보이는 회귀.** 이전에 되던 흐름이 안 되거나 화면이 깨져요(시험·캡처로 확인한 것).
- **거짓 단정.** 일부러 깨 봐도 빨개지지 않는 시험·가드예요. 호출 경로를 거치지 않는 시험, 비어도 통과하는 단정, 삼킨 실패(`try{}catch{}`), 이름 허용목록이 그 예예요.

## 3. 막지 않는 것
- **스타일·취향.** 「나라면 다르게 짠다」, 린트·포매터가 잡는 것.
- **호출 경로를 확인하지 않은 가정형 지적.** 「~일 수도 있다」는 호출 경로나 재현을 적어야 지적이에요.
- **이 PR이 만들지 않은 기존 코드의 문제.** 「기존」으로 표시하고 후속으로 보내요.
- **Medium·Low(디자인 검수의 Nitpick).** 같은 PR에서 고치지 않아요. PR 본문 「남은 것 / 인계」의 후속 작업에 적고, planner가 이슈로 만들어요.
- **사소한 지적 부풀리기.** 큰 문제를 못 찾았고 사소한 것만 있으면 「코드는 괜찮다」고 말해요. 에이전트 작성자에게는 지적 하나가 커밋 하나와 재검수 한 바퀴예요.

## 4. 지적 형식
- 맨 위에 **개수 요약**을 적어요: `Blocker n · High n · Medium n · Low n · 기존 n`. 이어서 **「문제 없음」** 또는 **「막는 것 있음」**을 분명히 적어요.
- 모든 지적에 `파일:줄`을 붙여요. 화면 지적은 캡처 경로를 붙여요.
- **같은 종류는 하나로 묶어요**(종류 → 위치 목록). 작성자가 한 번에 다 고치게 하려는 거예요.
- 무엇이 깨지고 왜 중요한지를 말해요. 고치는 방향은 말해도 코드를 대신 쓰지 않아요. 검수자는 파일을 고치지 않아요.

## 5. 회차 규칙
| 등급 | 검수 |
|---|---|
| 0·1 | **1회**. 막는 것만 고치면 끝이에요 |
| 2 | 최대 **2회**. 2회차는 1회차 지적과 그 수리 diff만 봐요 |

- 2회차는 이미 본 것을 다시 지적하지 않아요. 새로 생긴 막는 것만 더해요.
- 고친 뒤 확인은 바뀐 곳 시험만 돌려요. 전체 시험·캡처·사보타주는 PR 직전 1회예요.
- **3회째가 필요해 보이면 멈추고 planner에게 알려요.** 접근을 다시 봐야 한다는 신호예요.

## 6. 위험 등급
분류는 작성자가 아니라 **바뀐 곳**으로 해요. 여러 곳을 바꾸면 가장 높은 등급이에요. 경로로 먼저 정하고([부록 A](#부록-a-경로표-시험이-잠가요)) 애매하면 planner가 정해요.

| 등급 | 바뀐 곳 | 검수 | 시험·증거 |
|---|---|---|---|
| 0 | 문서·문구·작은 고정값 | 가벼운 새 맥락 리뷰 1회 | 자동 검사만. 사보타주 없음 |
| 1 | 일반 기능(화면·서버) | 1회, Blocker·High만 | 바뀐 곳 시험 + **이 PR이 바꾼 단정만** 사보타주, 바뀐 화면 캡처(스택 PR은 스택 검증에서) |
| 2 | 보안 경계·인증·권한·마이그레이션·CI·정책 파일·업데이터·배포 | 보안 검수 최대 2회 | 사보타주 전체, 실 PG |

- 등급은 검수의 **깊이와 횟수**를 정해요. 계약을 면제하지 않아요. 화면에 보이는 변경은 등급과 무관하게 독립 design-review Blocker 0·High 0이 먼저예요(스택 PR은 승격 전 스택 검증에서 한 번에). 등급 2의 owner 승인 경계(정책 파일 감사·라벨, M7 배포 등급)도 그대로예요.
- 일부 반복 검수는 실제로 불필요했어요. 하지만 보안 검수 1회차의 High는 진짜였어요. 그래서 등급 2의 보안 검수는 줄이지 않아요.

## 7. 검수 프롬프트에 넣을 요약 (복사용)
```
이 PR의 위험 등급은 <0|1|2>예요. REVIEW.md 기준으로 봐요.
- 막는 것만 지적해요: 보안 경계, 데이터 손실·불변식(단일 쓰기 경로·RLS·client_msg_id), 사용자 눈에 보이는 회귀, 거짓 단정(깨 봐도 안 빨개지는 시험).
- 스타일·취향, 호출 경로를 확인하지 않은 가정, 이 PR이 만들지 않은 기존 코드는 지적하지 않아요(기존이면 「기존」으로 표시).
- 모든 지적에 파일:줄. 맨 위에 Blocker/High/Medium/Low/기존 개수와 「문제 없음」 여부. 같은 종류는 묶어서.
- 큰 문제가 없고 사소한 것뿐이면 「코드는 괜찮다」고 말해요.
- <2회차라면> 1회차 지적과 그 수리 diff만 봐요. 이미 본 것을 다시 지적하지 않아요.
- 파일을 고치지 않아요.
```

## 부록 A. 경로표
**표에 없는 경로는 등급 1로 시작해요.** 여러 줄에 걸리면 가장 높은 등급이에요. 애매하면 planner가 정해요.

### 등급 2 — 정책 파일 (`policy_path()` 전체, 시험이 잠가요)
이 목록은 `scripts/verify_policy_integrity.sh`의 `policy_path()`와 **같아야** 해요. 어긋나면 `scripts/tests/test_pr_ci_guardrails.sh`가 빨개져요(양쪽 모두: 함수가 아는 파일이 표에 없어도, 표에 있는 경로를 함수가 몰라도). 이 목록의 경로가 바뀐 PR은 pr-ci의 정책 회귀 레인도 돌아요.

<!-- risk-tier:policy-paths:begin -->
- `AGENTS.md`
- `CONTRIBUTING.md`
- `.github/workflows/*`
- `.github/labels.json`
- `deny.toml`
- `osv-scanner.toml`
- `.github/dependabot.yml`
- `scripts/check_advisories.py`
- `docs/security/claims.yaml`
- `scripts/check_security_claims.py`
- `scripts/tests/test_security_claims.sh`
- `scripts/tests/test_advisory_gate.sh`
- `scripts/tests/fixtures/advisories/*`
- `scripts/check_branch_skew.sh`
- `scripts/check_track_alignment.sh`
- `scripts/github_track_guardrails.sh`
- `scripts/hooks/pre-push`
- `scripts/install_branch_skew_hook.sh`
- `scripts/local_gate.sh`
- `scripts/verify_merge_tree.sh`
- `scripts/check_npm_licenses.mjs`
- `scripts/check_cargo_licenses.sh`
- `scripts/github_bootstrap.sh`
- `scripts/verify_web_generated_types.sh`
- `scripts/verify_policy_integrity.sh`
- `scripts/verify_policy_integrity_from_base.sh`
- `docs/GITHUB_OPS.md`
- `docs/LOCAL_PR_GATE.md`
- `docs/TRACKS.md`
- `docs/adr/0153-ci-stack-selfhosted-runners.md`
- `scripts/tests/test_track_alignment_guard.sh`
- `scripts/tests/test_github_track_guardrails.sh`
- `scripts/tests/test_pr_ci_guardrails.sh`
- `scripts/tests/test_local_gate_hardening.sh`
- `scripts/tests/test_license_gate.sh`
- `scripts/tests/test_policy_integrity_gate.sh`
- `scripts/tests/test_trusted_policy_runner.sh`
- `scripts/tests/fixtures/policy-integrity/*`
<!-- risk-tier:policy-paths:end -->

### 등급별 경로 (안내 — 시험이 잠그지 않아요)
옛 경로가 남거나 새 보안 경로가 생기면 이 표를 고쳐요.

| 등급 | 경로 | 왜 |
|---|---|---|
| 2 | `.github/**` | CI·워크플로·소유자 |
| 2 | `SECURITY.md` | 공개 보안 주장 |
| 2 | `docs/security/**` | 보안 주장·「하지 않는 것」 |
| 2 | `server/Migrations/**` | 마이그레이션(정본 DDL) |
| 2 | `schema_v0.sql` | 수정·이동 금지 정본 |
| 2 | `scripts/migrate.sh` | 마이그레이션 실행 |
| 2 | `server-rust/bins/momo-migrate/**` | 마이그레이션 실행기 |
| 2 | `infra/rust/sql/**` | 역할·권한 부트스트랩(RLS) |
| 2 | `server-rust/crates/momo-db/**` | 테넌트 격리(RLS·`SET LOCAL`) |
| 2 | `server-rust/crates/momo-auth/**` | 인증 |
| 2 | `server-rust/bins/momo-server/src/auth.rs` | 인증 |
| 2 | `server-rust/bins/momo-server/src/work_host_auth.rs` | 작업 호스트 인증 |
| 2 | `server-rust/bins/momo-server/src/human_control.rs` | 사람 승인 서명 |
| 2 | `server-rust/bins/momo-server/src/rate_limit.rs` | 인증·쓰기 남용 방어 |
| 2 | `server-rust/bins/momo-server/src/cors.rs` | 브라우저 경계 |
| 2 | `server-rust/bins/momo-server/src/routes/auth_routes.rs` | 로그인·세션 |
| 2 | `server-rust/bins/momo-server/src/routes/device_keys.rs` | 기기 키 |
| 2 | `server-rust/bins/momo-server/src/routes/approvals.rs` | 승인 |
| 2 | `server-rust/bins/momo-server/src/routes/attachments.rs` | 첨부 접근 |
| 2 | `server-rust/bins/momo-server/src/routes/webhook*.rs` | 웹훅 입출구 |
| 2 | `server-rust/bins/momo-server/src/routes/push_*.rs` | 푸시 토큰 |
| 2 | `server-rust/crates/momo-agent/src/approval.rs` | 에이전트 승인 |
| 2 | `server-rust/crates/momo-agent/src/app_tool_grants.rs` | 도구 권한 |
| 2 | `server-rust/crates/momo-settings/**` | 비밀 저장·바깥 연결 정책 |
| 2 | `server-rust/crates/momo-egress/**` | 바깥 연결 가드(SSRF) |
| 2 | `server-rust/crates/momo-webhook/**` | 웹훅 서명 |
| 2 | `server-rust/bins/momo-webhook-sender/**` | 웹훅 전달 |
| 2 | `server-rust/crates/momo-unfurl/**` | 링크 미리보기 가드 |
| 2 | `server-rust/bins/momo-agent-worker/src/egress.rs` | 에이전트 바깥 연결 |
| 2 | `server-rust/crates/momo-push/**` | 푸시 |
| 2 | `server-rust/bins/momo-push-relay/**` | 푸시 중계 |
| 2 | `server-rust/crates/momo-blind-pty/**` | 종단 암호 PTY |
| 2 | `packages/momo-core/src/features/auth/**` | 클라이언트 인증 |
| 2 | `clients/web/src/features/auth/**` | 웹 인증 |
| 2 | `clients/mobile/src/features/deviceKey/**` | 폰 기기 키 |
| 2 | `clients/mobile/src/features/deviceLink/**` | 폰 기기 연결 |
| 2 | `clients/desktop/src-tauri/tauri.conf.json` | 업데이터·번들 설정 |
| 2 | `clients/desktop/src-tauri/capabilities/**` | 데스크탑 권한 |
| 2 | `clients/desktop/src-tauri/Entitlements*.plist` | 서명 권한 |
| 2 | `releases/**` | 업데이트 매니페스트 |
| 2 | `server-rust/Dockerfile` | 서버 이미지 |
| 2 | `infra/**` | 배포 구성 |
| 2 | `scripts/publish_next_build.sh` | 배포 |
| 2 | `scripts/release_manifest.sh` | 배포 |
| 1 | `REVIEW.md` | 검수 규칙(시험이 표를 잠가요) |
| 0 | `docs/**` | 문서(위 등급 2 문서 제외) |
| 0 | `CHANGELOG.md` | 변경 기록 |
| 0 | `ROADMAP.md` | 로드맵 |
| 0 | `README*.md` | 안내 |
| 0 | `llms.txt` | 안내 |
| 0 | `research/**` | 조사 기록 |
