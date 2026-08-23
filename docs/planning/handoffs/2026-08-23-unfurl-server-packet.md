# #1698 링크 언퍼얼 — 서버 표면 패킷 (ADR-0170 집행 1/2)

> Status: `ready`(게이트=ADR-0170 Accepted — 충족 2026-08-23) · Planner: Fable · Integrator: momo-main
> 트랙=engine · 워커=grok · 검수=Fable. **이 패킷은 서버 절반만** — 클라 렌더·개인 설정(D5)은 엔진 랜딩 후 별도 uxui 티켓.

## 계약 (ADR-0170 — 이 워크트리 docs/adr/0170에 전문)

1. **파생 레코드**: 신규 마이그레이션(번호는 현행 최고+1)으로 `message_unfurl` 계열 테이블 — message 참조·URL 정규화 키·제목/설명/도메인/이미지 프록시 키·상태(pending/ok/failed/blocked)·workspace_id(RLS FORCE — 기존 테넌트 관례 그대로). `schema_v0.sql` 불변.
2. **비동기 워커 루프**: 메시지 랜딩 후 본문에서 URL 추출(최대 3개/메시지)→fetch→OG/Twitter 카드 파싱→레코드 upsert→**outbox 이벤트로 광고**(단일 쓰기경로·message.seq 불변 — 언퍼얼은 파생이지 본문 수정이 아님). 캐시=정규화 URL 키, TTL 24h(재사용 시 fetch 생략).
3. **egress 가드(D3)**: 기존 OutboundHTTPPolicy 재사용 — 사설망/링크로컬/루프백 차단(redirect 매 홉 재검사·상한 3), HTML 512KB·이미지 5MB 상한, 타임아웃, UA 명시. `MOMO_UNFURL_ENABLED`(기본 0 — **옵트인**, 셀프호스트 egress 보수 기본값) 인스턴스 스위치.
4. **온오프 서버 절반(D4)**: 워크스페이스 설정 REST(관리자, off면 fetch 자체 생략) + 메시지 단위 제거 REST(발신자 본인, 레코드 삭제·재생성 안 함). 개인 설정은 클라 몫(비접촉).
5. **이미지 프록시**: 클라가 원격 호스트에 직접 붙지 않도록 서버 경유 콘텐츠 라우트(캐시 저장은 drive archive 재사용 여부 워커 판단 — 단순 메모리/디스크 캐시면 족하고 과설계 금지).
6. **P9 경계(D2)**: 코드 주석+SELF_HOST 문서 1절 — "서버는 링크 대상만 읽는다, 본문 판독 아님". 에이전트 발신도 동일 취급.

## AC
- 단위: URL 추출(코드블록·이메일 제외)·정규화·OG 파싱·SSRF 가드(사설망 3계열 거부 red proof)·redirect 상한.
- 통합(pg): 메시지→언퍼얼 레코드→outbox 이벤트 왕복(mock HTTP 서버 픽스처 — mock_hermes 관례)·off 시 fetch 0회·제거 REST 왕복·TTL 캐시 재사용.
- openapi 갱신(신규 라우트)·docs 게이트 그린.

## 함정
- 시크릿 금지·RLS FORCE·`MOMO_UNFURL_ENABLED` 기본 0(라이브 각성은 배포 창 결정). 클라 변경 0(웹/폰 비접촉 — 렌더는 2/2 티켓).
- worker는 PR(base=track/engine) 후 정지, merge/close 금지. docker 게이트=오케스트레이터.
