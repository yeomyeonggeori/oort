---
title: 보안
description: 데이터가 어디에 있고, 워크스페이스끼리 어떻게 나뉘고, 비밀 값을 어떻게 다루는지예요. 공개해도 되는 원칙만 적었어요.
status: done
checked: 2026-11-09
sources:
- README.md
- SECURITY.md
- docs/security/README.ko.md
- docs/architecture/overview.md
- server/Migrations/001_init.sql
- server-rust/crates/momo-db/src/tenant.rs
- infra/rust/sql/bootstrap_runtime_roles.sql
- server-rust/crates/momo-settings/src/crypto.rs
- server-rust/bins/momo-server/src/routes/agent_credentials.rs
- server-rust/crates/momo-webhook/src/crypto.rs
- server-rust/bins/momo-server/src/config.rs
- server-rust/crates/momo-push/src/dispatch.rs
- docs/adr/0004-codex-oauth-hermes-provider-boundary.md
- docs/adr/0120-push-notification-boundary.md
---

## 원본은 우리 서버에

메시지, 승인, 작업 상태, 감사 기록은 우리 서버의 PostgreSQL에 있어요. 바깥으로 나가는 것은 우리가 고른 곳뿐이에요.

| 바깥 | 받는 것 |
|---|---|
| 우리가 고른 AI 백엔드 | 일에 필요한 대화 맥락 |
| Google 공유 드라이브(고른 경우만) | 파일 |
| 푸시 중계(쓰는 경우만) | id와 전달 정보만. 메시지 본문, 프롬프트, 승인 내용, 첨부는 받지 않아요 |

푸시 중계를 쓰지 않으면 푸시 알림만 빠지고, oort는 그대로 써요.

## 워크스페이스끼리 나눠요

워크스페이스 데이터가 담긴 테이블에는 PostgreSQL의 행 단위 보안(RLS)을 `ENABLE`과 `FORCE`로 켜요. 서버는 트랜잭션마다 그 워크스페이스 id를 정해 두고, 정책은 그 워크스페이스의 행만 읽고 쓰게 해요. 앱 코드의 조건문만이 아니라 데이터베이스가 직접 막아요.

API 서버는 RLS를 건너뛸 수 없는 역할(`momo_app`)로 접속해요. RLS를 건너뛰는 역할은 여러 워크스페이스를 차례로 훑어야 하는 배경 작업용 셋(릴레이, 에이전트 워커, 알림 발송)뿐이에요.

## 비밀 값 다루기

- AI 키와 Hermes 키는 AES-256-GCM 암호문으로만 저장하고, 화면에는 끝 네 글자까지만 보여요.
- ChatGPT·Claude 구독 로그인은 Hermes가 자기 저장소에 보관해요. oort는 새 구독 로그인 연결을 만들지 않아요.
- 에이전트 토큰은 발급할 때 한 번만 보이고, 서버에는 해시만 남아요.
- Slack 호환 웹훅 주소의 토큰도 해시로만 저장해요.
- 루트 키끼리 같은 값을 쓰면 서버가 시작하지 않아요. 예를 들어 AI 키를 잠그는 마스터 키는 JWT 비밀이나 웹훅 마스터 키와 달라야 해요.

## 알아 둘 것

- 종단 간 암호화가 아니에요. 서버와 서버를 운영하는 사람은 메시지 내용을 읽을 수 있어요. 검색과 에이전트가 내용을 써야 해서예요.
- 외부 보안 감사나 인증은 받지 않았어요.
- 보안 문제를 찾았다면 공개 이슈 말고 [`SECURITY.md`](https://github.com/yeomyeonggeori/oort/blob/main/SECURITY.md)에 적힌 방법으로 알려 주세요.
