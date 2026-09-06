# 워커 브리프 — SH-4a `docs/SELF_HOST_AGENT.md` → 영문 하네스 불가지론 정본 + 환경 분기 표 + 단계별 `oort doctor` 게이트 + 한국어판 (engine · SH-3a 후 · SH-2 랜딩 뒤 권장 · ADR 불요)

> 워커: grok 4.6 · base=origin/track/engine · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. 코드 무접촉(`docs/**`·`llms.txt`만; `README.md`는 SH-4b). `scripts/**`·`.github/**` 무수정 — SH-1 드리프트 게이트 `scripts/check_release_manifest.sh`(문서 `@sha256:` 리터럴 0건)가 새 파일을 못 보면 **NOTES에 적고 고치지 않는다**(정책 파일). 시크릿·실호스트·실계정 값 기록 금지.
> 근거: 편성 정본 §5 SH-4a(수용: 「Claude Code 복붙 무개입 설치 1회 실측」) · D-4(셀프호스팅 우선순위 = Claude Code 복붙 → Railway → 그록봇) · 두 기둥 브리프 「프롬프트 하나로 설치되는 셀프호스팅」. 현행: `docs/SELF_HOST_AGENT.md`(972줄, **한국어·그록봇 VM 전용 플레이북** — §0 전제, §1 코어 설치 1.1~1.7, §2 환경 분기[Funnel 기본·quick tunnel 폴백·숙련자], §3 이후 계정·앱), `llms.txt`(그록봇 전용 문구: 「own Grok Bot account and VM」·CDP 금지), `docs/SELF_HOST.md`(사람용 한국어 558줄), `scripts/oort doctor`(SH-3a, JSON 판정), `releases/latest.json`(SH-1), SH-2 공개 엣지 env 2키(`OORT_SITE_ADDRESS`·`OORT_CSP_CONNECT_SRC`, `--public-origin` 파생 — 랜딩 전이면 「SH-2 랜딩 후 갱신」 표기).

## 구현 계약
1. **`docs/SELF_HOST_AGENT.md` = 영문 정본, 하네스 불가지론.** 독자는 「사용자의 기계에서 사용자의 지시로 일하는 에이전트」(Claude Code · Codex · Grok Bot · OpenAI 호환 무엇이든). 구조: §0 Contract(what the agent must never do: leave the user's machine/account, paste secrets into chat, control apps by automation, run ACME against hosts it does not own) → §1 Choose your environment(**환경 분기 표**: Local machine / VPS with own domain / Grok Bot VM (Tailscale Funnel) / Railway / Fly / AWS / GCP — 열: prerequisites · edge(`Caddyfile.local` loopback vs public edge SH-2) · URL model · accounts needed · `oort doctor` command · "done" means) → §2 Core install(공통 6단계: clone → choose image mode(`releases/latest.json`, never a pasted digest) → env(`self_host_env.sh`) → up → **gate: `scripts/oort doctor --json` PASS** → login/claim) → §3 Per-environment branches(각 분기 1절, 각 단계 끝에 doctor 또는 curl 게이트 1줄) → §4 Day-2(pointer: `scripts/oort status/logs/upgrade/backup` — SH-3b 랜딩 전이면 §1.7 산문 유지) → §5 When stuck(doctor id → fix 표). 그록봇 VM 고유 절차(Funnel state·ephemeral·quick tunnel 경고)는 §3의 그 분기로 **이동**(내용 손실 0 — 이동 전후 절 대조표를 PR 본문에).
2. **한국어판 `docs/SELF_HOST_AGENT.ko.md`**: 같은 구조·같은 절 번호의 번역(요약 아님). 두 파일 머리에 서로 링크 + 「정본은 영문」.
3. **`llms.txt`**: 그록봇 전용 문장 → 하네스 불가지론(safety rules 유지: own machine/account only, no secrets in chat, no app automation, agent = operator following the playbook). 정본 raw URL은 그대로.
4. **digest·버전 규율**: 두 파일 어디에도 `@sha256:` 리터럴·버전 숫자 하드코딩 없음 — 항상 `releases/latest.json`을 읽는 명령. `scripts/check_release_manifest.sh` 초록 유지.
5. **실측 1회(수용 기준)**: 스크래치 클론에서 **영문 정본만 보고**(다른 문서 참조 없이) Local machine 분기를 끝까지 따라 `oort doctor` PASS + 브라우저 로그인. 사람 개입이 필요했던 지점 0이어야 하며, 있었다면 문서를 고치고 다시 잰다. 실측 로그(명령·판정, 시크릿 마스킹)를 `docs/planning/research/2026-09-06-sh4a-agent-install-run.md`에 남긴다(단계·소요·doctor 판정·막힌 곳).

## red proof (선행 커밋)
- 문서 gate: `grep -rn '@sha256:' docs/SELF_HOST_AGENT*.md llms.txt` = 0 · `grep -rn 'app.oor7.com\|Grok Bot only\|CDP' docs/SELF_HOST_AGENT.md llms.txt` = 0(그록봇 분기 절 제외) · 두 파일 절 번호 집합 동일(스크립트로 대조, PR 본문에 출력) · 이동 전후 대조표에서 「사라진 절 0」.
- 실측 로그가 실제 존재하고 doctor JSON verdict PASS가 인용돼 있다.

## 완료 절차
markdown lint(있으면) · `scripts/check_release_manifest.sh` 초록 · 실측 1회 → 커밋 → `git push -u origin feat/sh4a-selfhost-agent-en` → `gh pr create --base track/engine` → 정지.

## 규율
정본은 하나(영문), 번역은 구조 동일. 하네스 이름은 예시로만(문장이 특정 하네스에 기대면 실패). 막히면 우회 말고 보고 후 정지.
