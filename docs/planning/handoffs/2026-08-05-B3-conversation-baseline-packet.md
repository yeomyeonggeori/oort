# 핸드오프 패킷 B3 — 대화 기준선: 인용 답글·작성 중 클라 표면 (웹/모바일 2워커)

- status: **ready** · 로드맵 배치 3 — **서버는 배포돼 있고 클라가 0인 최대 갭**
- 결정 정본: **ADR-0148**(인용 — root_id=소속/reply_to_id=지목·본류 표시·롤업 없음·인용의 인용은 원본만·realtime에 본문 안 실림=렌더가 곧 스냅샷) · **ADR-0149/#982**(typing — grant 선행·60s·202·TTL/republish/aggregate는 grant 응답이 나름·**사람 전용**)
- 서버 실측 앵커: 인용 = `routes/messages.rs:349-411`(전송 바인딩·검증)+페이지 LEFT JOIN(인용 미리보기 동봉— N+1 없음) · typing = `routes/ephemeral.rs`(grant:152·publish:234)+`realtime.rs parse_channel`이 `typing:ws<WS>.<CH>` 구독 인가. 와이어 형상은 dto.rs·openapi.yaml(#1040 정정본)이 정본.
- **어휘 경계(하드)**: 「작성 중」=사람 typing · 「작업 중」=에이전트 열린 턴. 혼용은 이 배치 최악의 회귀. 에이전트는 typing을 절대 안 낸다(서버가 403 — 클라도 시도 금지).

## 워커 경계
- **B3W(웹+core)**: `packages/momo-core` 신규 모듈(인용 모델·typing 신호 규칙 — 두 클라 공용) + `clients/web/**`. 모바일 금지.
- **B3M(모바일)**: `clients/mobile/**`만. core는 **소비만** — 부족하면 이탈 보고(B3W가 만든 모듈이 정본. B3W보다 앞서가지 말고 core 모듈 랜딩 후 소비).

## Goal W1/M1 — 인용 답글
- **작성**: 메시지 컨텍스트(웹 hover 액션·모바일 롱프레스/스와이프 — 기존 답글 진입과 구분되는 「인용」 액션) → 컴포저 위에 인용 프리뷰 칩(취소 가능) → 전송 시 replyTo 바인딩.
- **렌더**: 본류에 인용 블록(원문 미리보기+저자 — 페이지가 동봉하는 스냅샷 사용, 재조회 금지) → 탭/클릭 시 원본으로 점프(기존 앵커 기계 재사용). 인용의 인용은 원본만(ADR-0148). 삭제된 원본은 "삭제된 메시지" 정직 표기.
- 스레드(답글)와의 구분이 UI에서 읽혀야 한다 — 어휘·아이콘 분리.

## Goal W2/M2 — 작성 중
- **송신**: 컴포저 입력 시 grant 확보(만료 전 재사용) → republish 간격(grant 응답 값)으로 POST. 입력 멈추면 송신 중지(TTL이 소멸 담당 — stop 신호 없음이 계약). 백그라운드/블러 시 송신 중지.
- **수신**: 기존 realtime 레일에 `typing:` 구독 추가(웹은 subscribeAgent 패턴·모바일은 channelRail 패턴 — **새 소켓 금지**) → 컴포저 위 한 줄 "OO님이 작성 중…"(aggregate threshold 초과 시 "여러 명이 작성 중" — 값은 grant 응답) → TTL 만료 시 클라가 스스로 지움.
- 자기 자신 표시 금지 · 페인 다수 채널 구독 폭 주의(보이는 채널만).

## 검증 (각 goal)
전체 스위트+typecheck+red proof ≥2(인용: 스냅샷 재조회 금지 단정·삭제 원본 정직 / typing: 에이전트 비표시·TTL 소멸·같은 tick 목 금지 #839) · 웹은 게이트 신설(gate:quote·gate:typing 또는 기존 확장) · 모바일은 goal 완료 후 `lane:phone` 무회귀 1회. PR "Closes #10XX"·이탈 절·STOP. 턴 규율(20분·마일스톤 보고).
