# 핸드오프 패킷 — ADE 1단계 서버 축(#1114) + 스파이크 2건(#1120·#1121) (3워커 단발)

- status: **ready** · 기준: `origin/track/engine` 최신 · 워커=단발 Opus · 스크래치 파일명 고유
- 정본: **ADR-0154 Accepted**(D4 1단계·D5 트랙) · ADR-0125 D6-A(승인 카드 호스트 선택기 — Accepted 2026-07-19) · `2026-08-06-feature-gaps-roadmap.md` §④ · `research/2026-08-06-prime-agent-ade-herdr.md`

## 워커 1 — #1114 서버 축: work_control 이식 + spawn 도구 (대형)
- 이식 원본: Swift `work_control` 스폰 디스패치(서버 `server/` — `/work-controls`·`/work-controls/{id}/ack`, openapi :2529에 정의 기존재) + `work_auto_approve` 테이블(020_work_control.sql:76 — Rust 라우트 0). 실측 앵커: `tools.rs:51,100,111`(CATALOG·DECLARED_NOT_EXECUTABLE)·`work_sessions.rs:46,177,189`.
- 과업 체인: ①`/work-controls` 2라우트 + `/work-auto-approvals` 2라우트 이식(와이어=openapi 정의·camelCase 규율) ②`work.session.spawn` 도구 실행기 — **승인 필수 경로**(실행기+인자 검증기+자동승인 정책 3점 세트, work.session.end 전례) ③승인 요청 payload에 **호스트 후보 목록**(자격 호스트 판정 — 코어 `workSessionResumeTargets` 계열 재사용) 동봉 — 클라가 D6-A 선택기를 그릴 재료. 1차는 로컬/원격 2택+T3 자리 예약(ADR-0136 T3 기본 비활성).
- 경계: server-rust/**+openapi(신규 경로 등재)+코어 `createWorkSession` API 최소. 클라 UI는 범위 밖(2단계 — 승인 카드 선택기는 별도 배치). 불변식: 단일 쓰기경로·RLS·ADR-0004.
- 검증: cargo workspace+실DB 무회귀 · 신규 conformance 스위트(spawn 요청→승인 대기→결정→세션 생성 폐곡선) · red proof ≥2(미승인 spawn 거절·자격 없는 호스트 거절) · **병합 트리 3종**(verify_merge_tree.sh — 랜딩됨) · sampled-on-rust 등재(부분집합 왕복 성립 시). PR "Closes #1114 서버 축"(이슈는 클라 완료까지 열어둠 — 본문에 명시)·이탈 절·STOP.

## 워커 2 — #1120 prime agent 스파이크 (실험 — 레포 접촉 최소)
- 리서치 표 1의 최소 경로: 컨테이너(격리 필수 — 비샌드박스)에 prime-agent 설치 → `--mode rpc` JSONL 어댑터 프로토타입(prompt→응답 왕복·델타 버퍼링·steer 실험·extension_ui_request 관찰) → **로컬 스택**(infra/rust compose — 프로덕션 금지)의 채널에 REST로 중계.
- 자격증명: 스파이크는 **API 키 주입 없이 가능한 범위까지만**(로그인 필요 시 그 지점을 기록하고 멈춤 — 성재 `/login` 대행 요청은 보고서에). 산출: `docs/planning/research/2026-08-06-prime-agent-spike.md`(동작 실측·어댑터 스케치·정식 지원 판정 재료·깨진 것 정직 기록). 레포 커밋은 research 문서+실험 스크립트(scripts/spikes/ 아래)만. PR "Closes #1120"·STOP.

## 워커 3 — #1121 herdr 스파이크 (실험)
- herdr 설치(버전 핀 기록) → 우리 워커형 CLI(codex exec 류)를 herdr 페인에서 실행 → 소켓 API로 idle/working/blocked 상태 폴링 → 로컬 스택 채널에 상태 릴레이 프로토타입. **라이선스 실측 1순위**(리포 LICENSE 원문 vs 2차 출처 AGPL 주장 — 결론을 문서에) — 코드 재사용·번들 금지, 실행만.
- 산출: `docs/planning/research/2026-08-06-herdr-spike.md`(감지 정확도·explain 품질·릴레이 스케치·워커 좀비화 해독제로서의 판정). 레포 커밋은 research+scripts/spikes/만. PR "Closes #1121"·STOP.

## 공통
전 워커: 시크릿·프로덕션 접촉 금지 · Docker 자원 down -v · 이탈 절 · 머지 금지. 스파이크 둘은 실패해도 된다 — **"안 되는 이유의 실측"도 완주다**(추측 금지·재현 절차 기록).
