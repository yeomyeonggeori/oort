# ADR-0166: 셀프호스트 첫 소유자 클레임 — 1회용 claim token 부트스트랩

- Status: **Accepted** (2026-08-22 기안 · 같은 날 성재 승인 — 파도 진행 결재("ㄱㄱ 계속 진행", T-1 게이트 해제 문맥). T-1=#1651)
- 관련: ADR-0100(결정 거버넌스), ADR-0121(셀프호스트 배포·온보딩), ADR-0101(에이전트 신원·bearer — 본 ADR 비접촉), ADR-0162(1회용 pairing secret 선례), ADR-0004(자격 비유입 경계)
- 리서치: `docs/planning/research/2026-08-22-grokbot-one-click-selfhost-plan.md`(PLN-20260822-01 — D10 결재·§9 성재 결정), `docs/planning/research/2026-08-22-grokbot-vm-persistence-ra4.md`(RA-4)
- 제품 문장: **서버를 깔아준 에이전트는 비밀번호를 모른다.** 오퍼레이터(그록봇)는 1회용 셋업 링크만 회신하고, 비밀번호는 사용자가 첫 접속에서 스스로 만든다.

## Context

그록봇 원클릭 셀프호스트 파이프라인(PLN-20260822-01)에서 오퍼레이터 에이전트가 사용자 대신 oort 스택을 구동한 뒤, 사용자에게 **접속 크레덴셜을 어떻게 전달하느냐**가 미해결 경계다.

현행 부트스트랩 경로(전부 실측 좌표):

- `scripts/self_host_env.sh:729`가 초기 비밀번호를 생성(`openssl rand -hex 12`)해 `:822-823`에서 env 파일(0600)에 `MOMO_INITIAL_OWNER_EMAIL/_PASSWORD` 평문 기록.
- `server-rust/bins/momo-migrate/src/main.rs:531` `bootstrap_owner`가 migrate 종료 시 `infra/prod/bootstrap_owner_if_absent.sql:20-21`(`\getenv`, 멱등 — 없을 때만 기록)로 첫 owner를 심는다. compose 주입은 `infra/rust/docker-compose.rust.yml:159-160`(migrate 서비스만 소비).
- 사람은 `docs/SELF_HOST.md:195` 안내대로 env 파일을 `grep`해 비밀번호를 읽는다. **1회용 claim URL 개념은 현재 부재.**

이 경로는 "설치자=사용자 본인, VM 셸 접근 가능"을 전제한다. 그록봇 파이프라인에서는 전제가 둘 다 깨진다:

1. **설치자는 에이전트다.** 에이전트가 env의 비밀번호를 읽어 대화창으로 회신하면 provider(xAI) 로그에 크레덴셜이 유입된다 — D10에서 이 방식을 명시 기각했고, ADR-0004의 자격 비유입 경계와 정면 충돌한다.
2. **사용자는 VM 셸에 접근하지 않는다.** "env 파일을 grep하라"는 핸드오프가 성립하지 않는다.
3. **터널 URL은 사실상 공개 주소다**(R-2 실측 — quick tunnel). 초기 크레덴셜이 비어 있거나 고정값이면 URL을 아는 제3자의 선점(first-visit takeover) 위험이 실재한다.

## Options

- **A. 현행 유지 + 에이전트가 비밀번호를 대화로 전달** — 기각. 크레덴셜이 provider 로그에 영구 유입(D10 기각 사유·ADR-0004 위반).
- **B. "첫 방문자가 owner가 된다"(Mattermost 방식, 무토큰)** — 기각. 터널 URL이 공개 주소라 선점 위험이 방식 자체에 내장된다.
- **C. 1회용 claim token URL** — **채택.** 부트스트랩이 owner 계정을 비밀번호 미설정(claim-pending) 상태로 만들고 1회용 토큰을 발급한다. 오퍼레이터는 `https://<터널주소>/claim/<token>` URL만 사용자에게 회신한다. 사용자가 첫 접속에서 토큰을 소비하며 스스로 비밀번호를 설정한다. 토큰은 TTL·단회 소비라 대화로그 유입의 파급이 시간·횟수 양쪽으로 봉쇄된다.

## Decision

C를 채택한다. 구현 계약(레포 내 기존 선례 2개의 조합이 최소 변경 경로):

1. **토큰 원문·저장**: 32바이트 랜덤. DB에는 해시만 저장하고 원문은 발급 시점에 한 번만 유출한다 — 초대 코드 선례(`server-rust/bins/momo-server/src/routes/invites.rs:11-15`, 원문은 201 응답 1회·DB엔 sha256)와 동형. 서버 로그에 원문 비기록.
2. **TTL·단회 소비**: `expires_at` + `consumed_at` 원자적 단회 소비 — hosted pairing 선례(`server-rust/crates/momo-auth/src/hosted_connection.rs:155` `mint_pairing`, `:188` TTL+`pairing_consumed_at`)와 동형. 소비는 비밀번호 설정과 같은 트랜잭션에서 원자적으로 일어난다.
3. **라우트**: 무인증 공개 엔드포인트(claim 제출) 1개 — `POST /v1/join` 선례(`server-rust/bins/momo-server/src/routes/join.rs:1-20`, 무인증 공개 쓰기 + per-IP rate limit, 마운트 `lib.rs:1068`)와 같은 방식으로 auth 미들웨어 바깥에 마운트하고 같은 rate limit 규율을 적용한다.
4. **발급 경로**: `momo-migrate` 부트스트랩 확장 — claim 모드에서 owner를 claim-pending으로 생성하고 토큰(원문)을 부트스트랩 출력으로 1회 내보낸다. **기존 `MOMO_INITIAL_OWNER_PASSWORD` 경로는 그대로 유지**(후방 호환 — 현행 `docs/SELF_HOST.md` 경로 불변, claim 모드는 opt-in).
5. **클라이언트**: 웹 로그인 표면에 `/claim/<token>` 라우트(비밀번호 설정 폼) — 데스크탑은 같은 web 번들이므로 별도 작업 없음.
6. **범위 경계**: claim token은 **첫 owner 1인 전용**이다. 이후 사용자 추가는 기존 초대(`invites`) 경로, 에이전트 합류는 ADR-0162 pairing 경로 — 본 ADR은 둘 다 건드리지 않는다. RLS FORCE·단일 쓰기경로 불변식 비접촉.

미소비 claim-pending 상태의 owner로는 로그인할 수 없다(비밀번호 부재 = `momo_password_verify()` 통과 불가 — `server-rust/crates/momo-messaging/src/identity.rs:365` 경로에서 자연 거부되는지 T-1에서 단정으로 증명).

## Slack·업계 비교

Slack은 이메일 매직 링크(1회용 로그인 링크)로 비밀번호 없는 진입을 오래 운영해 왔고, Discourse는 첫 관리자를 설치 시 이메일 화이트리스트로 봉인한다. Mattermost류의 "첫 방문자가 admin"은 사설망 전제라 터널-공개 구조에서는 선점 위험이 된다(Option B 기각 사유). Home Assistant·Sandstorm 등 셀프호스트 제품군의 onboarding claim 흐름이 본 결정과 가장 유사하다 — **토큰 보유 = 클레임 권한**이라는 모델은 "주소를 아는 것"과 "설치를 소유하는 것"을 분리한다는 점에서 공개 터널 구조의 표준 해법이다.

## Consequences

- (+) 셀프서브 퍼널 성립: 사용자는 VM 셸 없이 URL 클릭만으로 소유권을 가진다. 크레덴셜의 provider 로그 유입 0. 공개 터널 선점 위험 봉쇄.
- (+) 대화로그에 유입되는 값은 토큰뿐이며, 소비 즉시 무효 + TTL로 파급이 한정된다(ADR-0004 정합).
- (−) 무인증 쓰기 표면이 1개 늘어난다 — join.rs 동형의 rate limit·해시 저장·TTL로 완화하고, T-1 수용기준에서 남용 케이스를 단정한다.
- (−) 부트스트랩 경로가 2계(기존 env 비밀번호 / claim 모드)가 된다 — 문서·테스트 유지 비용. claim 모드를 opt-in으로 두어 기존 사용자 경로 불변으로 상쇄.

## 검증 계약 (Accepted 후 T-1 수용기준 골자)

발급→미소비 상태 로그인 거부→claim 제출로 비밀번호 설정→로그인 성공→**토큰 재사용 거부**→**TTL 만료 거부**→DB에 토큰 원문 부재(해시만) — 전부 단정 테스트로. 서버 로그에 원문 비출현 grep 단정 포함.

## Accepted 후 구현 티켓에서 봉인할 파라미터

TTL 값(제안 24h), 라우트 경로명, claim 모드 활성 env 이름, per-IP rate limit 예산, claim-pending 상태의 표현(스키마 컬럼 vs 상태값).
