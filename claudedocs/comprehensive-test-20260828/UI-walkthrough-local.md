# UI 실사용 워크스루 — 로컬 셀프호스트 (2026-08-28 저녁, Fable 직접 수행)

> 성재 위임("직접 입력해서 해봐" — 임시 스택 발급 자격 직접 사용). playwright chromium(fake 마이크), 스크린샷 증거 `scratchpad/ui-walkthrough/`.

## A. 발행 v0.1.3 번들 (http://localhost:8088)
1. **로그인**: owner@oort.local 폼 로그인 → 앱 셸 진입. Comptest-fable 계정도 별도 컨텍스트 로그인 그린.
2. **명부**: 사람 2(데모 사용자·Comptest-fable)+에이전트 1(comptest-generic) 렌더. Comptest-fable 프로필 다이얼로그 — **역할은 읽기 전용 Fact**(v0.1.3 번들엔 #1855 미포함, 기대와 일치).
3. **타임라인**: #general에 **S4 에이전트 게시물 렌더 실증** — `@comptest-generic · Comptest-fable 님이 관리 · 18:39 "S4 매트릭스 검증 게시물"` + 새 메시지 구분선. 외부 도구 쓰기 → 사람 UI 도달 폐곡선.
4. **허들 (실 UI)**: owner "허들 참가" 클릭 → Live 배지·마이크 끄기·허들 나가기 컨트롤 활성. **2번째 컨텍스트(Comptest-fable)도 UI로 참가 → 양쪽 화면 참가자 롤 "데모 사용자, Comptest-fable" 상호 표시.** (증거: owner-08-huddle-two-party.png)
5. 로그아웃 스텝은 스크립트가 "설정" 텍스트 직클릭을 시도해 실패 — 설정 진입이 아바타 메뉴 뒤에 있는 구조(#1858로 티켓화된 그 동선). 제품 결함 아님, 스크립트 경로 문제로 기록.

## B. 역할 변경 UI (#1848/#1855) — track/uxui dev 번들 + 로컬 v0.1.3 api (proxy)
> v0.1.3 번들엔 역할 UI가 없으므로(오늘 랜딩), vite dev(MOMO_PROXY_TARGET=127.0.0.1:8080)로 신 클라 × 구 서버 조합 검증.
1. operator(owner) → Comptest-fable 프로필: **셀렉트+적용 노출**, 현재값 admin 정확.
2. **admin→member 강등 적용**: 셀렉트 값 member 반영 + 명부 행 라벨 "멤버"로 갱신(roster invalidate 실동작).
3. **self 프로필**: 컨트롤 미노출(H-2 게이트).
4. **member→admin 복원** 그린. — 신클라·v0.1.3 서버 와이어 호환 실증.

## 판정
- 로컬 종합테스트에서 UI 레벨까지: 로그인·명부·프로필·타임라인(에이전트 게시물)·**2자 허들 실 UI**·역할 변경 UI(신 클라) 전부 PASS.
- 잔여: S2·S3(그록봇 필요 — 복구 대기), S5 성재 자유 검수(스택 가동 중), VM 축(S1-a/b/c·결함 B 서버 적용).
