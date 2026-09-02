# 워커 브리프 — M0m 기기 연결 폰 절반: ConnectScreen 「QR로 연결」 (mobile · ADR-0180 · M0s 랜딩 후)

> 워커: grok 4.6 · base=origin/track/uxui(`clients/mobile`은 UXUI 트랙) · 시작 절차: `git merge origin/main --no-edit` · `npm ci` 루트+`clients/mobile`, iOS pod은 시뮬레이터 빌드가 필요할 때만.
> 정지 조건: 머지·이슈 close 금지. 서버 무접촉. 웹 무접촉(코어 `packages/momo-core`는 DTO/딥링크 파서 가산만). MCP 금지. 토큰 원문은 로그·테스트 출력 비유입.
> 정본: **ADR-0180 D2·D3·D4·D7** + `docs/onboarding-deeplink.md` `oort://link` 절(M0s가 추가) + 폰 규칙 `docs/design-system/README.md` + `clients/mobile/src/design/tokens.ts`. 실사: ConnectScreen(`clients/mobile/src/screens/ConnectScreen.tsx`)에 서버 주소·초대·로그인 + `oort://join` 프리필(`src/deeplink/joinLink.ts`), 세션은 키체인(`src/storage/secureSession.ts`), MMKV는 비시크릿.

## 구현 계약
1. **딥링크**: `oort://link?server=…&token=…`(+`momo://` 흡수)를 `joinLink.ts` 동형 파서로 — 파라미터 2개·순서 무관·미지 파라미터 무시. 카메라 앱으로 QR을 찍어도 앱이 열려 같은 경로로 들어온다.
2. **ConnectScreen 「QR로 연결」**: `expo-camera`(Expo 모듈 57에 포함 여부 실사 — 없으면 **낱개 추가**, ADR-0137 D1 문법) 스캔 시트 → `oort://link` 파싱 → `POST /v1/auth/device-link/redeem {token, device:{name, platform:"ios"}}`(공개 라우트) → `LoginResponse`+`pendingSas`. `pendingSas=true`면 SAS 4자리 화면(서버가 준 값) + 「데스크톱에서 확인을 누르면 진행돼요」 대기(폴링/재시도) → 활성화 후 세션 키체인 저장 → 워크스페이스 착지. 카메라 권한 거부는 문장형 안내 + 「주소로 연결」 폴백.
3. 오류: 만료(401)·2회 사용(409)·형식 오류는 각각 다른 한 문장. 재시도는 「QR 다시 찍기」.
4. Maestro 플로 1본(시뮬레이터 카메라 목 — 딥링크 직접 투입으로 스캔 단계 우회 허용, 문서화).

## red proof (선행 커밋)
- 파서: 파라미터 순서 무관·`momo://` 흡수·미지 파라미터 무시·잘못된 server 거부 · redeem 401/409 분기 문장 · `pendingSas` 분기 · 토큰이 로그/스토리지(MMKV)에 남지 않음(키체인만).

## 완료 절차
`npm --prefix clients/mobile run typecheck`·`npm --prefix clients/mobile test`·`make ts-check`·`scripts/verify_merge_tree.sh`·Maestro 플로(가능한 환경이면; 불가면 정확한 명령과 함께 NOTES) → 커밋 → `git push -u origin feat/m0m-device-link-phone` → `gh pr create --base track/uxui` → 정지.

## 규율
폰 토큰만(`tokens.ts`), 터치 타깃 44pt, 낭독 문장. 막히면 보고 후 정지.
