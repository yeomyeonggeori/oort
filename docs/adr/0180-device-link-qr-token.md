# ADR-0180: 기기 연결 — 1회용 QR 링크 토큰으로 폰 세션 발급

- 상태: **Proposed** (2026-09-02 기안 Fable — 성재 결재 대기. 2026-09-02 모바일 발제 "QR만 찍으면 연동, iOS 전용" + 편성 D-10)
- 발제: `docs/planning/2026-09-02-launch-program-plan.md` §6 M0 / 브리프 §3 UX-R2
- 관련: ADR-0162(hosted pairing — 15분 1회용 pairing 값 선례) · ADR-0166(첫 소유자 claim token — 1회용·TTL·소비 시 무효 선례) · ADR-0004(자격 비유입) · ADR-0167(same-origin·`--public-origin`) · ADR-0120(푸시 — `devices` 라우트는 푸시 등록용, 본 ADR 비접촉) · `docs/onboarding-deeplink.md`(`oort://join` 정본) · buzz `desktop/src-tauri/src/commands/pairing.rs`(NIP-AB: QR→SAS→릴레이 신원 전송)

## 맥락

폰 클라(RN, iOS)는 서버 주소·초대 코드·이메일·비밀번호를 손으로 치거나 `oort://join` 딥링크 프리필로만 붙는다. 이미 데스크톱에 로그인한 사용자가 폰을 붙이는 데 다시 자격을 입력해야 하고, 셀프호스트 주소(Funnel/Railway 도메인)는 폰에서 치기 가장 나쁜 문자열이다. buzz는 데스크톱 QR → 폰 스캔 → 양쪽 6자리 SAS 대조 → 릴레이로 신원(nsec)을 전송한다. 우리는 서버 계정 모델이므로 "신원 전송"이 아니라 **"이미 인증된 세션이 새 기기 세션을 발급"**하면 된다 — 더 짧고, 서버가 감사·해제를 가진다.

현행 자산: `POST /v1/auth/login|refresh|logout`(access+refresh, `momo-auth` token_store가 세션 토큰을 기록·회수), `POST /v1/join`(공개·초대 코드), `POST /v1/claim`(1회용 토큰 소비 선례), 폰 키체인 세션 저장(`secureSession.ts`), 딥링크 소비 `oort://`·`momo://` 이중 등록.

## 결정

- **D1 토큰.** 인증된 사람 멤버가 `POST /v1/auth/device-link` 로 **링크 토큰**을 발급한다: 발급자 세션·멤버·워크스페이스에 귀속, **TTL 120s**, **1회 소비**, 원문은 응답에만 실리고 저장은 해시. 토큰은 자격이 아니라 **교환권**이다 — 그 자체로는 어떤 API도 호출할 수 없다.
- **D2 QR 페이로드 = 딥링크.** `oort://link?server=<percent-encoded base>&token=<base64url>` — `onboarding-deeplink.md`의 `join` 문법(파라미터 2개·순서 무관·미지 파라미터 무시·`momo://` 흡수)을 그대로 따른다. 폰 카메라 앱으로 찍어도 앱이 열린다(QR 전용 스캐너가 유일한 문이 아님).
- **D3 소비.** 폰이 `POST /v1/auth/device-link/redeem {token, device:{name, platform}}` (공개 — `/v1/join`과 같은 사유로 인증 미들웨어 밖, per-IP 레이트리밋) → 서버는 토큰 검증·소비 후 **그 멤버의 새 세션**(access+refresh, `realtime_web_socket_url`)을 `LoginResponse` 동형으로 발급하고, 발급자 화면에 "연결됨: <기기명>"을 수렴시킨다(폴링 GET `…/device-link/{id}` — outbox 이벤트 없음 v1, 리마인더·사이드바 무-outbox 전례).
- **D4 SAS는 모드별.** 서버가 `MOMO_CENTRIFUGO_WS_URL=same-origin`+`--public-origin`으로 **공개 오리진 모드**임을 알 때만 양쪽에 4자리 SAS(토큰 해시 파생)를 표시하고 발급자가 "일치" 확인 후에야 세션이 활성화된다(중간자 QR 바꿔치기 방어). 루프백/LAN 모드는 SAS 생략(TTL 120s·1회 소비·TLS가 경계). 모드 판별은 서버 config에 이미 있는 값만 쓴다 — 새 env 없음.
- **D5 감사·해제.** 소비 시 `audit_event(kind='device.linked')` + 세션 토큰에 기기 라벨. 설정 › 기기 목록에서 즉시 회수(`revoke_member_session_tokens` 재사용). 발급 토큰은 TTL 만료·소비·발급자 로그아웃 중 먼저 오는 것으로 무효.
- **D6 경계.** `require_human`(에이전트 세션은 링크 토큰 발급 불가 — 에이전트 자격은 ADR-0173 경로). 토큰 원문은 로그·감사·진단 번들에 비유입(ADR-0004 규율 동형). 푸시 `devices` 라우트와 무관 — 푸시 등록은 세션 발급 뒤 현행 경로.
- **D7 표면.** 웹/데스크톱: 설정 › 기기 "폰 연결" 카드(QR·120s 카운트다운·재생성·SAS(모드별)·연결됨 수렴) + 온보딩 S5 "폰에서도 쓰기" 진입점(UX-R2). 폰: ConnectScreen "QR로 연결"(expo-camera) → redeem → 키체인 저장 → SAS(모드별) → 워크스페이스 착지. Maestro 플로 1본.

## 기각 대안

- **buzz식 신원 전송(refresh 토큰 자체를 QR에)**: QR이 자격이 된다 — 사진·화면 공유로 유출 시 즉시 세션 탈취. 기각.
- **초대 코드 재사용(`oort://join`)**: 새 계정 생성 문법이라 "같은 사람의 두 번째 기기"를 표현하지 못하고 멤버가 둘이 된다. 기각.
- **SAS 상시 필수**: 로컬 루프백에서까지 4자리 대조를 시키면 "QR만 찍으면"이 깨진다. 공개 오리진 모드에 한정(D4).
- **outbox 이벤트로 즉시 수렴**: v1 폴링(≤2s)으로 충분, 실시간 배선은 후속.

## 영향·게이트

- 서버: 라우트 2(발급·소비) + 상태 GET 1, 테이블 `device_link_token`(해시·member·session·expires·consumed_at·sas) 마이그레이션 1본, RLS 동일. `schema_v0.sql` 무접촉.
- red proof: ①만료 토큰 소비 401 ②2회 소비 409 ③에이전트 발급 403 ④발급자 로그아웃 후 소비 401 ⑤공개 오리진 모드에서 SAS 미확인 시 세션 비활성 ⑥루프백 모드 SAS 생략 ⑦토큰 원문 로그 0건(grep 게이트).
- 클라: 웹 카드 design-review, 폰 Maestro 1본 + 시뮬레이터 카메라 목. 딥링크 정본 문서에 `link` 절 추가.
- 티켓: M0s(engine) → M0w(uxui) → M0m(mobile). Railway E2E(SH-5a)의 마지막 수용 칸.
