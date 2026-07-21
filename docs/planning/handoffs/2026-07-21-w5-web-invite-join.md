# W-5 핸드오프: 초대 링크 웹 합류 — 무설치 온보딩 관통 (ADR-0119 + ADR-0121 D2)

> 발급: 2026-07-21 Fable (성재 "진행해줘"). 정본: ADR-0119 파생 W-5 + ADR-0121 D2(universal link 초대)·D3(초대 보안). 선행 전부 main(53c457a): W-2/W-3/W-4·JoinRoutes(redeem/join·ban 검사)·LinkShort 서비스(services/LinkShort)·초대 REST.
> 트랙: 엔진/인프라 · base = main · PR base = track/engine · 도메인 = clients/web + infra(prod compose·Caddy `/i/*` 예약분 실행) + docs.

## 목표
"초대 링크 받음 → 브라우저에서 클릭 → 가입 → 채팅 시작"이 **앱 설치 없이** 완주. 셀프호스트 온보딩의 마지막 관통(0121 D2의 1차 랜딩 표면 = 웹).

## 구현 범위
1. **웹 초대 랜딩 라우트**: SPA에 `/join` 라우트 — URL 쿼리/경로에서 초대 코드 추출(`/join?code=...` + `/i/<code>`가 SPA로 폴백된 경우 경로 파싱). 코드 존재 시: 서버 URL은 현재 오리진 고정(같은오리진 서빙 전제 — 원격 서버 입력란 숨김), 가입 폼(표시명·handle·이메일·비밀번호) → `POST /v1/join`(기존 계약 — W-2 클라이언트에 join 함수 기존재 시 재사용) → 성공 시 세션 저장·홈 진입. 실패(만료/소진/**banned 403**)는 사유별 인라인 메시지(재시도 아닌 명확한 종결 카피).
2. **LinkShort prod 연결**(W-3 주석 예약분 실행): prod compose에 LinkShort 서비스 추가(pinned 이미지 규율 — install.sh 이미지 목록 가산) + Caddy `{$APP_DOMAIN}` site의 `/i/*` → LinkShort reverse_proxy(**SPA 폴백보다 먼저**). LinkShort의 redirect 대상이 `{$APP_DOMAIN}/join?code=...`가 되도록 env 문서화(LinkShort README 계약 확인 — public base URL env 기존재).
3. **로그인 화면 정돈**: 기존 "초대 코드로 가입" 흐름과 /join 랜딩의 코드 프리필 일원화(중복 화면 금지 — 같은 컴포넌트 재사용).
4. **verifier 가산**: `verify_web_serving.sh`에 `/i/*` 프록시 단정 1개 가산(e2e web 프로파일에 LinkShort 컨테이너 추가, 28074 뒤 새 포트 필요 시 28075) + `/join` SPA 폴백 200 단정. 웹 vitest: 코드 파싱·폼 검증·에러 사유 분기(만료/소진/banned) ≥6.

## 하드 경계
- JoinRoutes/서버 무변경(계약 소비만 — ban 검사는 524까지 main에 있음). 시크릿/실도메인 커밋 금지. 토큰·코드를 로그에 남기지 않음(초대 코드는 URL에 있으므로 히스토리 정리: 가입 성공 시 `history.replaceState`로 코드 제거).
- **선례 함정**: bash 3.2 배열·포트 사전검사·컨테이너 curl 금지(호스트 curl). 카피 verb-first·em-dash 금지.

## 수용 기준
- vitest 가산(≥6)·lint·typecheck·build PASS. verifier 신규 단정 2개(문법까지 — 실런은 오케스트레이터). DEPLOY.md에 초대 관통 흐름(생성→단축링크→웹 합류) 절 추가.
- 실왕복(초대 생성→링크→가입→메시지 1건)은 오케스트레이터 게이트 — STATUS runtime-unverified 명기.

## 규율
- 커밋 자주. PR 후 멈춤(base=track/engine). merge/close·docker·브라우저 금지(게이트=오케스트레이터).
