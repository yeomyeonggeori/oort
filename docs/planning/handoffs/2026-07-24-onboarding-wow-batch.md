# 핸드오프 패킷 — 온보딩 와우 배치 W-O1~4 (MOMO-584~588 / #719~723)

> 근거: `docs/planning/2026-07-24-onboarding-wow-audit.md`(레퍼런스 공식+격차, 성재 전체 배치 승인). 각 이슈 본문이 티켓별 수용기준 정본이며, 이 패킷은 공유 계약·재사용 포인터·함정을 담는다.

## 공유 계약 (584·585가 정확히 일치해야 함)
- **딥링크**: `momo://join?server=<percent-encoded base URL>&code=<invite code>` — 두 쿼리 파라미터만, 순서 무관, 알 수 없는 파라미터는 무시. server는 percent-decoding 후 기존 `validatedBaseURL()` 규칙으로 재검증.
- **mDNS**: 서비스 타입 `_momo._tcp`(586 광고 ↔ 587 브라우징), TXT 레코드 키 `base`=API base URL(예: `http://MacBook-Pro-2.local:28000`).

## 재사용 포인터 (새로 만들지 말 것)
- **585/587 chooser**: `clients/macOS/Sources/MomoMac/MomoServerSession.swift` — chooser `:1033~`, 경로선택 `:1176`, 크리덴셜 폼 `:1234`, 검증 `:87-108`, 카피 `:1922~`. 진입 앱: `MomoMacDevApp.swift`(WindowGroup) — onOpenURL은 여기 or 세션 루트. Info.plist: `clients/macOS/XcodeHost/Info.plist`(CFBundleURLTypes 신설).
- **584**: `infra/prod/momo-ops.sh` `run_invite_create`(:132~) + `create_invite.sql`. 코드 원문은 파일로만(기존 정책) — 딥링크 문자열은 운영자 전달용 stdout 허용(주석 근거).
- **586**: `scripts/internal_alpha_stack.sh`(compose()·redeploy·status 구조). dns-sd는 macOS 내장. pid 파일은 `${TMPDIR}` 아닌 프로젝트 상태 위치(기존 스크립트 관례 확인) — 광고 프로세스 누수 금지.
- **588**: `server/Sources/MomoServer/Routes/JoinRoutes.swift`(성공 경로), 메시지 작성은 `MessageRoutes`의 단일 쓰기경로 헬퍼 재사용(직접 INSERT 금지 — seq/outbox 불변식). 기본 채널=#general(`create_workspace.sql:106~` 참조), agent 멤버 조회=member kind='agent' status='active' handle 사전순. 멱등 마커는 메시지 metadata jsonb(스키마 관례 확인) 우선 — 새 테이블/마이그레이션은 정말 필요할 때만(041부터).

## 함정 (성문화된 것)
- Linux/@preconcurrency import Crypto·명시 의존(서버 코드 건드릴 때). PostgresNIO: bytea는 ByteBuffer, nil 파라미터는 `::text` 캐스트(577 전례). jsonb_build_object nil 타입 미추론 주의.
- 스냅샷 기준이미지 기록 금지(오케스트레이터 환경 기준, gated env). SNAPSHOT_TESTING_RECORD=all 전역 금지.
- 두 env 템플릿(.env.example·secrets.env.example) 동시 갱신(env 추가 시).
- em-dash 0·과장어 0(사용자 노출 문자열). 동사-우선 버튼.
- 588 인사 템플릿은 고정 한국어(+영어 로컬라이즈드), 내부 어휘(Context Packet 등) 금지, 이모지 남용 금지. 예시 골격: "@{새멤버} 님, 환영해요. 저는 {agent}예요. 채널에서 저를 멘션하면 요약이나 조사 같은 일을 맡길 수 있어요. 지금 한번 불러보세요."

## 공통 하드 룰
- 지정 worktree에서만. **PR/merge/close/gate 금지 — 커밋 후 STOP**(머지·docker·design-review는 오케스트레이터).
- schema_v0.sql 불변. 시크릿 커밋 금지. build+단위테스트 커밋 전 통과. 최종 보고는 스키마 그대로(placeholder 금지, 실제 결과만).
