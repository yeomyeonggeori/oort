# 리서치 — Prime Agent · ADE 트렌드 · herdr (2026-08-06)

> 발제: 성재 — ADE 구조(1 로컬+2 클라우드 스플릿뷰 트래킹·랩탑 닫아도 클라우드 지속)가 oort 지향점 + prime agent 리서치(테스트 활용·향후 지원). 전문은 오케스트레이션 기록 — 요지만 보존.

## ① Prime Agent (Prime Intellect, 2026-08-05 공개)
- **정체**: CLI 코딩 에이전트 하네스(Claude Code·Codex CLI와 같은 층). **MIT**(게이트 통과). 완전 로컬 — 백그라운드 데몬이 세션 소유(append-only JSONL·attach/detach·fork). RLM(컨텍스트=변수·서브에이전트=함수·유일 도구=영속 IPython 커널) + Continual Harness(프롬프트·스킬을 런타임 CRUD·/refine 자기수정). ARC-AGI-3 95.5%(Opus 5). $130M Series A @$1B(2026-07).
- **통합 표면**: `--mode rpc` = stdin/stdout JSONL — prompt/**steer**(실행 중 지시 주입)/follow_up/abort/fork/clone + 이벤트(델타·툴 실행) + **extension_ui_request**(confirm/select를 호스트에 위임 — oort 승인 카드로 렌더 가능). pi(badlogic/pi-mono) 기반.
- **oort 평가**: hermes/codex와 같은 층의 3번째 하네스 — 붙이는 비용 낮음. `steer`가 우리에 없던 "실행 중 끼어들기" UX 자산. 리스크: 샌드박스 아님(컨테이너 필수)·출시 1일차 API 불안정·자기수정 하네스의 감사성(JSONL 세션을 증거로 링크+수정 사실 채널 이벤트로 방어). 계약 요건: ADR-0004(키는 워커 호스트 로컬 /login만)·단일 쓰기경로(RPC 델타→어댑터 버퍼→REST만, Centrifugo 직결 금지)·seq 권위=PG·에이전트=member·RLS.

## ② ADE 트렌드 (Conductor·ADE app·Orca·Cursor Cloud·Codex cloud·Claude Code web·Devin)
- **업계 수렴 3가지**: ⑴ **worktree/브랜치=세션 경계**(사실상 전 제품) ⑵ **working/blocked/idle 3상태 배지**가 관제의 핵심(herdr·Orca — "몇 개를 안 봐도 되나"가 지표) ⑶ **resume(로컬 히스토리) vs teleport(원격 인수) 어휘 분리**(Claude web이 최성숙 — 사전조건 4종 선검사·실패를 "무엇을 하면 되는지"로·expired 배지·부분 복원 정직 표기).
- **차용**: blocked=멘션급 우선순위(채널 목록 상태 점)·diff 인디케이터(+42 -18)를 메시지 카드에·인라인 코멘트→다음 지시 첨부 리뷰 루프·비대칭(초기 단방향) 숨기지 않기.
- **함정**: 리뷰 병목(agentic PR pickup 5.3배 — 세션 늘리는 UI만 만들면 병목 이동)·6+ 병렬이면 병목=운영자·완료 알림 전부 푸시하면 음소거(blocked만 푸시)·레이트 리밋이 진짜 상한.

## ③ herdr — 실존 (ogulcancelik/herdr, Rust 단일 바이너리, 24.8k★, 2026-06 Trending #1)
- "에이전트 인식 tmux" — 데몬이 세션 소유(재부팅 생존)·워크스페이스>탭>페인·페인별 idle/working/blocked/unknown(screen detection+룰, `agent explain`이 판정 근거 설명)·Unix 소켓 API(JSON — 에이전트가 페인 생성·타 에이전트 프롬프트 주입 가능).
- **라이선스 주의**: 1차(리포 LICENSE)=Apache-2.0, 2차 출처 다수=AGPL 듀얼 주장 — **코드 재사용 전 재확인 필수**(실행만 하면 어느 쪽이든 무오염).
- **oort 관계**: 겹치지 않음 — herdr=터미널 관제 하위층, oort=사람+에이전트 대화 공간. 우리 tmux 팀메이트 좀비화 전례를 정확히 겨냥(blocked 감지). 가장 싼 실험=상태→oort 메시지 릴레이 어댑터(소켓 폴링+REST POST). 100일 1인 프로젝트 — 버전 핀 필수.
