# 오픈소스화 + 단일 이미지 셀프호스팅 — 실행 계획 (2026-08-10)

> 성재 지시: "오픈소스랑 단일 이미지 셀프호스팅을 목표로 작업계획 구체화 및 작업 진행" — 진단 관문 ①·②를 목표로 확정, 관문 ③(운영)은 이 계획 밖(별도 결정).
> 입력 정본: `research/2026-08-10-buzz-launch-diagnosis.md` + 축별 전문 A·B·C·E.

## 방침 (이 계획이 전제하는 판단 — 전부 가역)

- **라이선스 정책**: CONTRIBUTING의 MPL 금지 문구를 **MPL-2.0 allow로 정정**(감사 A 권고·buzz 동일 정책). 의존 30건 교체는 비현실적, MPL-2.0은 파일 단위 약한 카피레프트로 배포 모델과 충돌 없음. 성재가 뒤집으면 deny.toml 한 줄 수정으로 복귀.
- **단일 이미지 정의**: 웹 SPA를 서버 이미지에 굽는다(감사 B 권고 — buzz 방식이자 **oort Swift 경로의 선례 복원**). 스택 전체 단일 컨테이너 주장은 하지 않는다(PG·Centrifugo·Caddy는 compose 동반 — 종전 README의 정직한 정의 유지).
- **공개 형태·시점·범위(378파일)·레포명은 성재 결정으로 남는다.** 이 계획은 "공개 가능 상태"까지 만들고 공개 버튼은 만들지 않는다.
- **engine→main 동기화(S10)가 공개 전 필수 선행**이 된다 — 공개 대상은 main인데 개발선은 engine. 랜딩은 규율대로 track/engine, 동기화는 성재 승인 게이트 유지.

## 트랙 1 — 오픈소스 준비 (관문 ①)

| 티켓 | 내용 | 근거 | 발사 |
|---|---|---|---|
| **#1224** 공개 전 정리 | SECURITY.md 구 org 링크 → 실소유 · 비DNS IP 노출 제거 · 개인 Gmail 기본값 4곳 일반화 · `mobile-spike` debug.keystore 처리 · `.gitleaksignore` 60건 근거 주석 고정 · NOTICE `TODO(Codex)` 해소 | A §즉시 처리 | **W-O1 지금** |
| **#1225** 라이선스 게이트 이설 | `deny.toml` 신설(cargo 644 커버·화이트리스트+근거 주석) · npm 체크를 `web-legacy`→`clients/web`+`clients/mobile`+`packages/momo-core` 이설 · CONTRIBUTING MPL 문구 정정(위 방침) · `local_gate.sh` 편입 · red proof(금지 라이선스 주입 시 빨강) | A 상위 2·3 | **W-O2 지금** |
| **#1226** 진입 문서 현행화 | `AGENTS.md`·`CODEX.md`·`docs/RUN.md`·`docs/INDEX.md`·`docs/TRACKS.md`에서 Swift 스택 교육 제거(swift build 39회→0)·Rust/TS 현행화 · `infra/rust/README.md` 루트 링크 · `Makefile` build/test를 현행 스택으로 | E 상위 1 | **W-O3 지금** |

README는 완료(2026-08-10 `b9e2f579`). CI 잡 승격(라이선스·PR CI)은 공개 전환(Actions 과금 해소)과 연동 — 성재 결정 ② 뒤.

## 트랙 2 — 단일 이미지 셀프호스팅 (관문 ②)

| 티켓 | 내용 | 근거 | 발사 |
|---|---|---|---|
| **#1227** 최초 소유자 부트스트랩 + 온보딩 함정 | 최초 소유자 생성 경로를 1급으로(현행: 문서 0·실패 시 DB 파기 강제) — 서버의 기존 능력 실측 후 최소 구현+문서 · `CENT_API_URL` 호스트 실행 함정(주석·경고) · env 템플릿 누락 키(`PROVIDER_LINK_MASTER_KEY` 등 — infra/rust README 첫 명령 exit 1 수리) | C 치명 1·3, B 부수 | **W-O4 지금** |
| **#1228** compose 레포화 + 단일 이미지 | 라이브 3오버레이(t3·caddy·cent-origin) 구조 레포화(성재 대행 덤프 B-2가 입력) · caddy 서비스 정의 신설(회수된 Caddyfile의 주인) · 웹 SPA를 서버 이미지에 굽기(Dockerfile 확장+정적 서빙 경로) · 버전 스탬핑(웹·API 커밋 환원 가능) | B 상위 1·3 | **덤프 도착 후 W-O5** |
| **#1229** time-to-hello 재작성 | "clone → You're in" quickstart — 명령 다섯 개 이하·분기 0 목표, C의 e2e smoke를 수용기준으로(실주행 재측정) | C | #1227·#1228 랜딩 후 |

## DAG

```
W-O1·W-O2·W-O3·W-O4 — 전면 병렬 (지금)
성재 ! 대행(B-1~B-4 덤프) ──> W-O5(#1228) ──> #1229 ──> 재실측(time-to-hello)
공개 버튼: 성재 결정(시점·범위·레포명) + engine→main 동기화(S10)
```

## 완료 정의

- 트랙 1: gitleaks 재실행 0신호 · 라이선스 게이트가 현행 스택 전체를 재고 red proof 성립 · 진입 문서에서 `swift build` 0
- 트랙 2: 새 기계에서 문서대로 clone→메시지 왕복이 **임기응변 0회**로 성립(C 방식 재실측) · 웹이 이미지 안 · 라이브 compose가 레포 파일로 재현
