# oort v0.1.4 — buzz 패리티 3파도(BZ·BF·BT)·리마인더·커스텀 상태·사이드바 섹션·검색 스코프·mark-unread

빌드 커밋 `main=e39e9427`. 다중 아키텍처(linux/amd64+linux/arm64) manifest list, SLSA v1 provenance 검증 PASS(앱·postgres 각 1본).

## 운영자 pin (불변 manifest list digest)

| 대상 | 불변 이미지 |
|---|---|
| 앱 | `ghcr.io/yeomyeonggeori/oort@sha256:7426d282b67270ff3d52c4cbf1f5136ea038ae104a2c9dbb971ef71f8694d37f` |
| PostgreSQL 18 + pgBackRest | `ghcr.io/yeomyeonggeori/oort-postgres@sha256:563ee793c3e8fb9417dfc8bd6b72fdfa70680d48de81c3633d75b820f507e3b5` |

아키별 digest(발행 런 actions/runs/33616349789): 앱 amd64 `sha256:1338d77572cbe45d65b6c4370f5ed4cad92858e325f4158de9fdca58d237d251` · arm64 `sha256:913ae998a6d41e42a7ade5748707529db9c00c74d203ec46a83ee21d8bf51ecb` / postgres amd64 `sha256:1e97948679004df03b0742f6374eca07a7a3088293f8b203aeb79b24937ed562` · arm64 `sha256:41bc9fd58640cf004853246e8e15f0664b08acf7fe74fdd3032d6883aa92473d`. 검증:

```sh
gh attestation verify "oci://ghcr.io/yeomyeonggeori/oort@sha256:7426d282b67270ff3d52c4cbf1f5136ea038ae104a2c9dbb971ef71f8694d37f" --repo yeomyeonggeori/oort --predicate-type https://slsa.dev/provenance/v1
gh attestation verify "oci://ghcr.io/yeomyeonggeori/oort-postgres@sha256:563ee793c3e8fb9417dfc8bd6b72fdfa70680d48de81c3633d75b820f507e3b5" --repo yeomyeonggeori/oort --predicate-type https://slsa.dev/provenance/v1
```

## v0.1.3 이후 주요 변화

**서버 (마이그레이션 082~085)**
- 메시지 리마인더 REST CRUD (#1888, ADR-0175) · 커스텀 멤버 상태를 프레즌스 표면에 (#1889, ADR-0176)
- 멤버 소유 사이드바 섹션 저장소 `member_sidebar_prefs` + `/members/me/sidebar-prefs` (#1932, ADR-0177)
- 검색 채널 스코프 `channel=` 파라미터 + 스코프 봉인 커서 (#1931)
- mark-unread 신호 `marked_unread_before_seq` + `read_intent`(explicit_open/background) — `last_read_seq` GREATEST 불변 (#1934, ADR-0178)
- 자기 표시 이름 변경 `PATCH members/me` (#1873) · 에이전트 대상 워크스페이스 role 변경 거부 (#1857)
- 셀프호스트 허들: `MOMO_LIVEKIT_NODE_IP` 노브(생성 env 기본 127.0.0.1, 소급 주입 없음) (#1856) · TURN 리라이트 setConfiguration 경로 (#1847)

**웹·데스크톱 — buzz 패리티 3파도**
- BZ: 사이드바 접기(타이틀바 토글) (#1864) · 채널 헤더 1줄+라운드 컨트롤 (#1865) · 라이트 헤어라인 완화 (#1866) · 설정 전면 페이지+Profile (#1867) · **온보딩 S0 오르트 랜딩·S1/S2 스텝 셸**(BZ-6a #1869) · **외양 액센트 시스템 1차**(새벽 기본·성운·홍염·혜성·감람, ADR-0174 #1868)
- BF: 리액션 이름 툴팁 (#1884) · 상단 안읽음 점프 필 (#1885) · 허들 마이크 디바이스 선택+게인 (#1886) · 알림 권한·종류별 토글 (#1887) · 크로스채널 초안 패널 (#1901) · 컴포저 선택 서식 트레이 (#1902) · 링크 프리뷰 rich/compact/off (#1903) · 채널 빈 상태 인트로 (#1904) · 리마인더 UI (#1888) · 커스텀 상태 UI (#1889)
- BT(버즈 토대): 사이드바 행 우클릭 컨텍스트 메뉴 (#1929) · 컴포저 `@`·`#`·`:` 자동완성 통일 (#1930) · 검색 범위 칩 (#1931) · 커스텀 섹션 CRUD·배치 (#1932) · 별표·정렬·무라이브러리 DnD (#1933) · **「여기부터 안 읽음」** — momo-core 합성 단일점·explicit_open 배선 (#1934)
- 계정: 명부 프로필에서 역할 변경 (#1848) · 프로필 메뉴 로그아웃(확인 다이얼로그) (#1858)

**문서·거버넌스**
- ADR-0174~0182 Accepted(외양·리마인더·커스텀 상태·사이드바 섹션·mark-unread·표현 축·QR 기기 연결·웰컴 킥오프·일시 확인 정책)
- 정본 경량화 로테이션(ROADMAP·STATUS·BUILD_TICKETS·JOURNAL·CURRENT_STATE) · `docs/planning/PIPELINE.md` 신설(레인·모델 단일 정본) · CODEX.md → AGENTS.md 병합
- 출시 프로그램 편성 정본 `docs/planning/2026-09-02-launch-program-plan.md`

**알려진 결함(이번 릴리스 무변경)**
- UnreadPill 복귀 방문 arming 비결정(#1966, 선재) · 폰은 mark-unread를 아직 소비하지 않음(#1964) · 셀프호스트 허들 외부 도달·웹훅 인바운드·work host는 SH 파도(#1925·#1265·#1927)

검증·계약 상세는 각 PR과 `docs/RELEASING.md`.
