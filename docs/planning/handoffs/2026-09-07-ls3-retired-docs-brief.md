# 워커 브리프 — LS-3 은퇴 문서·INDEX 재작성·Codex 잔재·G3 문서 (engine/docs · #2182 · ADR-0183 D6 + 1차 목표 결정 §5-3)

> 워커: grok 4.6 · base=origin/track/engine · 워크트리 `momo-worktrees/wls3`(`feat/ls3-retired-docs`) · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. **보호 경로 허용 목록(감사)**: `AGENTS.md`(Codex 문면 일반화·죽은 행) · `scripts/check_docs_commands.py`(GATED_DOCS/GLOBS 대상이 삭제되면 목록 정합) · `scripts/verify_public_edge_centrifugo_contract.sh`(RUNBOOK 재지정 1행) · `.github/ISSUE_TEMPLATE/codex-goal.md`→`goal.md` 개명. 그 밖의 `scripts/**`·`.github/**` 무수정. `docs/adr/**` 무수정. `docs/SELF_HOST*.md`·`SELF_HOST_AGENT*.md`는 §1-4의 「회전 절 이식」 외 무수정. 시크릿 금지.
> **보존(삭제 금지)**: `docs/external-agent-provider/**`(케이스 B hermes 합류 런북 재작성 대상 SH-9) · `docs/PUSH_RELAY_RUNBOOK.md`·`docs/cicd/12-*`(SH-10) · `docs/runbooks/pgbackrest-pitr.md`·`selfhost-pg-dump-restore.md`·`local-resource-reclaim.md`·`cubesandbox-host-install.md` · `docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md`(ITO 팩) · `docs/GWS_INTERNAL_CONSENT_RUNBOOK.md` · `docs/onboarding-deeplink.md` · `docs/INBOUND_MCP.md` · `docs/legal/**`·`legal/**`.
> 근거: ADR-0183 D6 · 후보 §1 #11·#20, §2.2 · `2026-09-07-first-goal-two-cases.md` §5-3(G3 문서 삭제) · LS-0/1/2 결과(RUN·DEPLOY·BACKLOG의 명령·경로는 이미 죽음).

## 1. 구현 계약
1. **삭제(`git rm`)**: `docs/RUN.md` · `docs/DEPLOY.md` · `docs/BACKLOG.md` · `docs/RELEASE_PLAYBOOK.md` · `docs/MACOS_ALPHA_UPDATE_CHANNEL.md` · `docs/LOCAL_SOLO_ALPHA_ROADMAP.md` · `docs/HANDOFF_2026-07.md` · `docs/AWS_INTERNAL_ALPHA.md` · `docs/INTERNAL_ALPHA.md`·`INTERNAL_ALPHA_FEEDBACK.md`(AWS 알파 전제; ITO 인테이크 규칙은 §1-3의 INDEX 「내부 테스트」 절 3줄로 흡수) · `docs/QA_GATE.md` · `docs/IOS_TESTFLIGHT_RUNBOOK.md`(G3 진입 때 RN 기준 재작성) · `docs/SECRETS_BACKUP_RUNBOOK.md`(infra/prod SOPS 전제 — 살아 있는 절은 `docs/runbooks/pgbackrest-pitr.md`·`selfhost-pg-dump-restore.md`가 이미 담음; 없는 절이 있으면 §1-4로 이식) · `docs/specs/04-context-packet-v0.md` · `docs/cicd/04-codex-tickets.md`·`09-qa-codex-tickets.md`·`10-ios-signing-identity-runbook.md`(Swift 서명; RN 서명은 `clients/mobile` 문서) · `docs/runbooks/turn-host-install.md`(infra/prod 전제; TURN은 #1792 연기) · `docs/runbooks/aws-internal-alpha-deploy.md`(LS-0에서 이미 삭제됐으면 무시) · `CODEX.md` · `.codex/` · `.conductor/`(worktree-bootstrap 산물, `docs/MULTI_SESSION_OPS.md`가 참조하면 그 문장 정정) · `.sops.yaml.example` · `BUILD_TICKETS.md`의 `[swift]` 등급 행.
2. **`docs/runbooks/ncp-rust-deploy.md`**: `verify_public_edge_centrifugo_contract.sh`가 단정하는 절(`## CENT_PROXY_SECRET 회전`·`### 회전 롤백`·SHA-256 문장·`--edge-url` 문장·boundary 스크립트 이름)을 `docs/SELF_HOST.md` 「공개 오리진으로 열기」 아래 **「Centrifugo 프록시 시크릿 회전」 절로 원문 이식**(en) + `SELF_HOST.ko.md` 대응 절 → 계약 스크립트의 `RUNBOOK=` 경로를 `docs/SELF_HOST.md`로 재지정(1행, 감사) → 게이트 초록 확인 → `ncp-rust-deploy.md` `git rm`.
3. **`docs/INDEX.md` 재작성**: ADR-0183 D1 정본 목록 그대로 — §0 스택 한 눈(Rust 서버·web/Tauri/RN·momo-core·infra/rust·Agent Port) · §1 루트 정본 · §2 셀프호스팅(SELF_HOST·FIRST_DAY·SELF_HOST_AGENT·RELEASING·NEXT_CHANNEL·runbooks 현행분) · §3 에이전트 연동(SELF_HOST_AGENT·external-agent-provider·PUSH_RELAY·INBOUND_MCP) · §4 기획(planning README·PIPELINE·TRACKS·ADR 색인·first-goal) · §5 게이트(LOCAL_PR_GATE·GITHUB_OPS·cicd 현행분) · §6 내부 테스트(ITO 팩 + 인테이크 3줄) · §7 불변식. 링크는 전부 실재 파일(검사 명령을 PR에). `README.md` 디렉터리 절도 D1 목록으로.
4. **Codex 잔재 일반화**: `AGENTS.md`·`docs/GITHUB_OPS.md`·`docs/MULTI_SESSION_OPS.md`·`.github/ISSUE_TEMPLATE/codex-goal.md`(→`goal.md`, 본문 「워커」로) · `scripts/github/*.tsv`의 codex 라벨 문면은 **무수정**(보호, LS-6 후속) — 문서에서 「Codex」를 하네스 불가지론 「워커 레인(PIPELINE §1)」으로. `docs/LOCAL_PR_GATE.md`(906줄)은 프로파일 표만 남기고 `local_gate.sh --help`를 정본으로 가리키는 축약판(≤200줄).
5. **문서 명령 게이트**: 삭제 문서가 `check_docs_commands.py` GATED_DOCS/GLOBS에 있으면 제거(감사). 삭제 파일을 링크하던 살아 있는 문서의 행 정정(`git grep` 목록을 PR에).

## 2. red proof
- 계수: `docs/` 루트 md 34 → 실측 · `docs/cicd`·`runbooks` 수 · `git ls-files | wc -l`.
- 삭제된 모든 basename에 대해 `git grep -lF <name> -- . ':!docs/planning/JOURNAL.md' ':!docs/planning/archive' ':!STATUS.md' ':!docs/adr' ':!docs/planning/research' ':!docs/planning/handoffs'` = 0(재현 한 줄).
- `INDEX.md`·`README.md`의 모든 상대 링크가 실재(검사 스크립트 한 줄, PR에).
- `PYTHONPYCACHEPREFIX=/tmp/momo-pycache python3 scripts/check_docs_commands.py` 0 broken · `scripts/local_gate.sh --profile docs` PASS(공개 엣지 계약 게이트가 SELF_HOST.md 절을 읽어 초록) · 사보타주: 이식한 회전 절 제목 하나를 스크래치에서 바꾸면 계약 게이트 RED.

## 3. 완료 절차
커밋 순서: ①회전 절 이식+RUNBOOK 재지정(게이트 초록) ②삭제 ③INDEX·README 재작성 ④Codex 일반화·LOCAL_PR_GATE 축약 ⑤명령 게이트 정합. push `feat/ls3-retired-docs` → PR(base `track/engine`): 계수·grep 0·링크 검사·게이트 원문·**보호 경로 변경 파일 목록**. 마지막 출력 `DONE / COMMITS / GATES / PR / NOTES`.

## 4. 규율
규칙으로 지운다(보존 목록 우선). 살아 있는 절은 옮기고 지운다(원문 불변 이식). 막히면 보고 후 정지.
