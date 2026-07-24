# 핸드오프 패킷 — WH-2 (#706): 코드 실행 호스트 GUI (자동 페어링 + 엔진 선택)

> ADR-0114 증보1 WH-2 (UXUI). base=**track/uxui** · worktree=`../momo-worktrees/706-momo-580-work-host-gui-adr-0114-1-wh-2`. **design-review 에이전트(신선 컨텍스트) + momo-design-taste, Blocker 0·High 0 종료조건.**

## 목표
관리자 설정에 "코드 실행 호스트" 화면: (1) work host(사이드카/로컬) 페어링 상태 표시, (2) 실행 엔진 선택(opencode 기본/goose/codex-local), provider GUI("AI 연결", 574)와 **한 설정 셸에서 구분 표기**(LLM provider vs 코드 실행 호스트).

## 재사용 (정본 모델 — 새로 만들지 말 것)
- `clients/macOS/Sources/MomoMac/MomoProviderLinkSettingsView.swift`(574 "AI 연결") — **설정 셸·상태 행·저장/오류 상태·권한 없음 안내("서버 운영자에게 문의")·로컬라이제이션(isKorean) 패턴을 그대로 따를 것.**
- `MomoProviderLinkRESTClient.swift` — REST 클라이언트 패턴(이걸 모델로 work host engine 클라이언트 작성).
- `MomoProviderLinkModels.swift` — 모델/상태 패턴.
- `MomoWorkHostIdentityStore.swift` — 기존 work host 신원/페어링(`MOMO_WORK_HOST_ID` A-11) 상태. 페어링 표시는 이걸 소비/확장.
- 설정 진입 enum: `MomoMacRootView.swift`의 `case aiConnection` 인접에 `case workHost` 추가(`MomoAppLocalization`에 "코드 실행 호스트" 라벨/부제).

## REST 계약 (MOMO-582 서버가 제공 — 이 계약을 소비)
- `GET /v1/provider/work-host-engine` → `{engine:"opencode|goose|codex-local", source:"database|default", updatedBy?, updatedAtMs?}`.
- `PUT /v1/provider/work-host-engine` `{engine}` → 저장 결과 동일 형태. 비관리자 403, 잘못된 값 400.

## 수용기준
- [ ] "코드 실행 호스트" 설정 화면: 엔진 선택(Picker, opencode 기본/goose/codex-local, 각 한 줄 설명 — opencode/goose=동봉, codex-local=사용자 호스트 연결), 저장, 상태(연결됨/오프라인/도구 목록은 있으면 표시).
- [ ] 페어링 상태 섹션: 사이드카/로컬 호스트 연결 상태 표시(MomoWorkHostIdentityStore 소비). 자동 발견/페어링 코드 UX는 가능 범위에서(서버 계약 부재분은 표시-only + deferred 기록).
- [ ] provider GUI와 구분: 한 설정 그룹/인접 화면에서 "LLM provider(AI 연결)" vs "코드 실행 호스트"를 분명히.
- [ ] 권한 없음 시 574와 동일한 안내. 빈/로딩/오류/오프라인 상태 전부.
- [ ] 스냅샷 테스트(기준이미지 기록 금지 — 오케스트레이터 환경 기준, gated `MOMO_VERIFY_706_SNAPSHOTS`). 순수 로직은 단위테스트.

## design-taste 하드 룰 (momo-design-taste)
- 시맨틱 색/텍스트 스타일만(raw Color/hex/Font.custom/system(size:) 금지). spacing ∈ {4,8,12,16,24,32}. em-dash(—/–) user-visible 문자열 0. 시스템 컨트롤 우선(Picker/Form/LabeledContent/Section). 동사-우선 버튼 카피. 빈 상태=한 줄+액션. 키보드 경로. reduceMotion. pre-flight grep 0 hit.

## 하드 룰
- PR base=track/uxui. PR 후 STOP. merge/close/gate 금지. 서버/마이그레이션 건드리지 말 것(582가 담당). swift build+테스트 커밋 전 통과. design-taste pre-flight 통과.
