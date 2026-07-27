# goal #854 — MOMO-646: 허들 전사 v1 — 1단계는 구현이 아니라 **실측 하니스**다

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/engine`.** 모델: gpt-5.6-sol medium.

## 0. 착수 전 필수
1. `git status` clean 선검사. 2. **자격증명 탐색 금지·`.env` 읽기 금지.** 3. **PR 후 STOP.**
4. docker·실오디오·게이트 실행은 오케스트레이터 몫. 5. 심볼은 grep으로 실재 확인.

## 1. 범위 — 이번 PR은 **하니스 + 파이프라인 골격**까지. 모델 확정은 실측 뒤다.

ADR-0122 D2가 정한 설계를 바꾸지 마라: 참가자별 Track egress → **트랙별 전사 → 타임스탬프 병합**(화자분리 모델 금지 — 트랙=사람) · whisper.cpp/faster-whisper(MIT) **사후 배치** · 실시간 캡션 금지 · Mattermost rtcd/offloader **코드 참조 금지(AGPL)**.

### 1-1. 한국어 실측 하니스 (이번 PR의 본체)
- 입력: 오디오 파일 디렉터리(오케스트레이터가 채운다 — **네가 오디오를 구하려 하지 마라**) + 참조 전사 텍스트.
- 실행: small / medium / large-v3-turbo 3종을 같은 입력에 돌려 **CER + 처리시간/스레드**를 표로 낸다. 재현 가능하게(모델 버전·커밋 핀).
- 출력: `docs/research/` 보고서 템플릿 — 모델·CER·RTF(실시간 대비 배율)·판정란은 비워둔다(성재/오케스트레이터 기입).
- 참고 기준선: Mattermost 실측 10분 통화 = tiny 2m20s ~ small 16m50s @1스레드. large-v3 KsponSpeech CER 11.13%(낭독체).

### 1-2. 파이프라인 골격 (모델 미정 상태로 돌 수 있게)
- LiveKit Egress 컨테이너를 compose **옵트인 profile**로(기존 `huddle` profile 선례, 버전 핀·healthcheck). **Egress는 Redis가 필요하다** — prod는 redis가 이미 있고(`infra/prod/install.sh:66`) dev compose(`infra/docker-compose.yml`)에는 없다. dev에서는 profile에 redis를 포함해라. Centrifugo 설정을 건드리지 마라.
- 회의 종료 → 전사 job 기동 → 트랙별 전사 → 타임스탬프 병합 → **화자 라벨 스크립트** 산출까지의 job 골격. 모델 이름은 설정값으로.
- 산출물 저장은 **기존 파일 트랙 계약(ADR-0113/0116) 경유** — 새 저장 경로를 만들지 마라.

### 1-3. 동의 게이트 (fail-closed)
- **동의 없이 녹음이 시작되는 경로가 없어야 한다.** V-1 스키마의 동의 기록 자리를 재확인하고, 녹음 시작 REST가 동의 기록 없이는 거부하게. 채널 시스템 메시지 고지 포함(ADR-0122 "전원 고지+Continue/Leave").
- 웹 동의 UI는 **이 티켓 범위 밖**(uxui 후속) — 서버가 막고 있으면 UI는 나중에 얹어도 안전하다.

## 2. 하지 말 것
- 외부 ASR 연동(옵트인 설계는 ADR-0122 증보 뒤). 요약·액션아이템(V-5 별도). 실시간 캡션. 모델 확정.
- `schema_v0.sql` 수정 금지. 시크릿 커밋 금지.

## 3. 검증
- 서버 빌드·테스트 무회귀. 하니스는 **더미 무음 오디오로 셀프테스트**(파이프라인이 도는지만 — 품질 판정 아님).
- 오케스트레이터 실행 목록을 PR에: compose profile 기동 · 실오디오 하니스 런 · 동의 게이트 레드 증명(동의 기록 없이 녹음 시작 시도 → 거부).

## 4. PR
`feat/854-momo-646-transcription-v1` → `track/engine`. 본문: 하니스 사용법(오디오 넣는 곳·명령), Egress/Redis 구성 판단, 동의 게이트 설계, 계획 이탈. **PR 후 STOP.**
