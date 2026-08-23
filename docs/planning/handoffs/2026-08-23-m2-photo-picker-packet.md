# M-2 폰 사진·파일 picker 전송 패킷 — P0-② 복원 후반부

> Status: `ready`(착수 게이트=**ADR-0168 Accepted — 충족, 2026-08-23 성재 승인**) · Planning ID: PLN-20260823-UX · Planner owner: Fable · Integrator: momo-main
> 발급: 2026-08-23 · 기준: track/uxui 최신 · 워커: sol(codex) · 검수: Fable+design-review · 트랙=uxui
> 근거: ADR-0168(의존성 결정 전문) · UXUI 파도 계획 §2 M-2(게이트 2) · M-1(#1681, 표시면 랜딩)

## 1. 현황 (실측 좌표)

- 폰 첨부 **표시**는 M-1이 랜딩: `clients/mobile/src/features/attachments/AttachmentList.tsx`·`content.ts`(3상태 미리보기 모델). **전송(고르기→업로드→발송)이 공백** — `conversation/Composer.tsx`에 첨부 진입점 없음.
- 코어에 컴포저 첨부 모델이 이미 있다: `packages/momo-core/src/features/attachments/model.ts` — 업로드 이슈 분류(too-large/forbidden/no-archive/mismatch/blocked/unavailable)·카피·다음 행동, 웹 컴포저가 소비 중. **폰은 이걸 재사용한다(카피 재발명 금지).**
- 업로드 REST는 웹과 동일 `/v1` 첨부 경로(uploads 세션→콘텐츠 업로드) — **서버 비접촉**.
- `expo-file-system`은 M-1이 이미 hoist(이탈 노트 기결). Expo 57/RN 0.86.2/New Arch.

## 2. 작업 계약

1. **의존성(ADR-0168 채택 그대로)**: `expo-image-picker`·`expo-document-picker` Expo 57 정합 버전을 `clients/mobile/package.json`에 추가. bare iOS라 config plugin 없이 `ios/` Info.plist에 `NSCameraUsageDescription`·`NSPhotoLibraryAddUsageDescription`(+카메라 촬영 지원 시) 수기 — **카피는 ux-bible 문법**(용도를 사람 말로, 위협 어조 금지). PHPicker 경로라 사진 '선택'만으로는 권한 문자열 불요 — 실제 필요한 키만 추가하고 근거를 커밋 메시지에.
2. **Composer 첨부 진입점**: 사진/파일 선택 시트(2행이면 충분 — 과설계 금지) → 선택물을 코어 모델 트레이로. 트레이 UI는 AttachmentList 문법(3상태)과 정합, 웹 트레이와 어휘 동일(momo-core 카피).
3. **업로드→발송 배선**: 코어 모델의 업로드 상태기계 소비. 실패 4상태(선택 취소/권한 거부/초과/보관소 미연결) 인라인 렌더 — 토스트 금지. 발송은 기존 메시지 REST에 attachment id 합류(웹과 동일 계약).
4. **테스트**: 모델/배선 단위 테스트 + 렌더 테스트(mobile 관례 — 기존 `clients/mobile` 테스트 스위트 문법). 시뮬레이터 실행 검증은 `runtime-unverified`로 명시(오케스트레이터 몫). 폰 프리플라이트 부재는 보고 문면에 명시(OMD.md §완료 경로 4).

## 3. AC

- 사진 1장·파일 1개: 선택→트레이 표시→업로드 상태→발송 성공 경로가 코드·테스트로 성립.
- 권한 거부 상태가 화면에 렌더(설정 이동 안내 카피 — ux-bible 문법).
- 실패 카피 전부 momo-core `uploadIssueCopy`/`uploadIssueNext` 재사용(폰 로컬 카피 신설 0).
- `npm --prefix clients/mobile test` 그린 + tsc 그린. openapi·서버·schema 비접촉.

## 4. 함정

- iOS 폴더(`ios/`)의 pbxproj 수정은 최소화(pod autolinking이 처리) — NSE·entitlement·서명 비접촉.
- 100MB 상한·보관소 미연결(no-archive)은 서버가 판정 — 클라 선검사 재발명 금지(크기 사전 표시는 허용).
- worker는 merge/close 금지 — PR(base=track/uxui) 생성 후 정지. 시크릿 커밋 금지.
