# 핸드오프 패킷 — Swift 삭제 (ADR-0145 증보 3 후보, 2워커 순차)

- status: **ready** · 기준: `origin/track/engine` 최신 · 워커=단발 Opus 무명 · 성재 지시 2026-08-09("가능하면 swift 마무리 됐으면 그거 제거하는 작업도 해줘")
- 실측 전제(오케스트레이터 2026-08-09): Swift 트리 **584파일**(server 177·clients/macOS 327·clients/iOS 50·clients/Core 30) · **프로덕션 라이브는 `infra/rust` 스택(momo-rust 이미지)** — Swift `momo.Dockerfile`은 라이브 경로가 아니다(단 그 Dockerfile이 **web-legacy도 굽는다** — #1181 실측: web-legacy는 출하 이미지가 굽는 유일한 웹). 상시 빌드 3자리는 증보 2로 이미 퇴역.
- **경계**: 이 배치는 **삭제 준비와 실행을 분리**한다. W-R(감사)이 "무엇이 Swift에만 있는가"를 기계로 답한 뒤에야 W-S(삭제)가 돈다. 감사 결과 이식 잔여가 발견되면 **삭제 중단하고 잔여를 티켓화**(성재 판단 자리).

## 워커 R — 삭제 전 의존 감사 (선행·삭제 금지)
1. **참조 그래프 실측**: `server/`·`clients/{iOS,macOS,Core}`·`services/`(Swift 부분)를 가리키는 **살아있는 참조** 전수 — 빌드(Dockerfile·compose·Package.swift·xcodeproj)·CI(.github/workflows)·스크립트(scripts/**)·게이트·문서 링크·이슈 템플릿. 각 참조가 ①죽은 참조 ②이관 완료 ③**아직 Swift만 하는 일** 중 무엇인지 판정.
2. **기능 파리티 감사**: Swift 서버 라우트/기능 중 server-rust에 **미이식인 것**이 있는지 기계 대조(openapi 매니페스트·sampled-on-rust 53연산·라우트 목록 대조). macOS 클라 기능 중 웹/Tauri에 없는 것(성재 검수 표면이 데스크톱=Tauri·모바일=RN이므로 macOS 고유 기능은 폐기 대상이나, **폐기되는 기능 목록은 명시**되어야 한다).
3. **web-legacy 결속 규명**: `momo.Dockerfile`이 Swift와 web-legacy를 함께 굽는다 — Swift 제거 시 web-legacy 빌드 경로가 어떻게 되는지(별도 Dockerfile 필요? 이미 clients/web으로 대체 가능?) 판정. #1176/#1181 맥락 참조.
4. 산출: `/private/tmp/.../scratchpad/swift-removal-audit.md` — 삭제 가능/불가 목록·잔여 이식 티켓 후보·삭제 순서 제안·되돌리기 비용(git 이력은 남으므로 "참조 정본"의 실제 필요성 재평가). **PR 없음**(문서만·레포 커밋 금지 — 오케스트레이터가 검수 후 이식).

## 워커 S — 삭제 실행 (W-R 판정 후 오케스트레이터가 별도 발사)
- 범위는 W-R 산출이 정한다. 원칙: ①살아있는 참조 0을 먼저 만든 뒤 트리 삭제 ②web-legacy 빌드 경로 보전(대체 Dockerfile 또는 clients/web 승격 — W-R 판정) ③동결층(`app.momo.*` 번들ID·`MOMO-NNN`·env·role) 불변 ④게이트·레인·병합 트리 7레인 green 유지 ⑤삭제 후 남는 문서 참조는 "이식 원본은 git 이력"으로 갱신.
- 검증: 전 게이트(docs·web 프로파일)·병합 트리 7레인·`cargo test --workspace`·웹/폰 스위트·prod 이미지 빌드(Swift 제거 후에도 web-legacy가 구워지는지 실측). PR "ADR-0145 증보 3 — Swift 트리 삭제"·이탈 절·STOP.

## 공통
무명 단발 Opus·새 워크트리·시크릿/프로덕션 금지·중간 보고 없음. 스크래치 접두 `swiftaudit-*`/`swiftrm-*`.
