# oort — CI/CD 1회 셋업 런북 (사람이 직접, 순서대로)

> Codex는 코드/워크플로우 파일을 만들 수 있지만, **Apple 계정 액션·비밀값 등록은 사람이 1회** 해야 한다.
> org=`yeomyeonggeori`, repo=`oort`. 검증 표기는 docs/cicd/00 참조.

## 사전 요건
- Apple Developer Program 멤버십(유료, 연 $99 — 법률/계약 변동 가능, 본인 확인). 등록주체 결정, D-U-N-S(조직 선택 시), 사람 handoff 절차는 `docs/legal/01-entity-apple-runbook.md`를 먼저 따른다.
- App Store Connect에 **App 레코드 생성** + Bundle ID 등록. **어떤 번들 ID에 어떤 capability와
  프로파일이 필요한지는 `docs/cicd/10-ios-signing-identity-runbook.md`가 정본**이다
  (iOS 앱 `app.momo.ios` + 알림 확장 `app.momo.ios.NotificationService`는 **각각** 필요,
  macOS는 `com.dawnkim.momo`). 이 문서를 보고 번들 ID를 짐작하지 말 것.
- macOS 직접배포면 **Developer ID Application 인증서** 권한(Account Holder/Admin).

## 1. App Store Connect API Key(Team Key) 발급
1. App Store Connect → Users and Access → Integrations → App Store Connect API → **Team Keys** → `+`.
2. 역할 **App Manager** 이상.
3. `AuthKey_XXXX.p8` 다운로드(**1회만 가능**) → 안전 보관.
4. **Key ID**, **Issuer ID** 기록.

## 2. signing repo 생성 + match 최초 동기화 (개발자 머신)

> `momo-signing` 은 구·신 org 양쪽에서 404 다(2026-08-10 실측 — #1236 항목 4). 아직 만들어진 적이 없으므로 아래 org/이름은 **성재가 실체를 정한 뒤** 확정한다. 나머지 `--repo` 대상은 전부 현행 `yeomyeonggeori/oort` 로 재조준됐다. 상세: [`02-secrets-inventory.md`](02-secrets-inventory.md).

```bash
# 별도 private repo
gh repo create Dawn-kim-official/momo-signing --private

# 리포 루트에서
bundle install
export MATCH_GIT_URL="https://github.com/Dawn-kim-official/momo-signing.git"
export MATCH_PASSWORD="<강한 패스프레이즈>"
export ASC_KEY_ID="..."; export ASC_ISSUER_ID="..."
export ASC_KEY_P8_BASE64="$(base64 -i AuthKey_XXXX.p8 | tr -d '\n')"

bundle exec fastlane match init            # Matchfile 확인
# iOS — Matchfile 기본값이 앱 + 알림 확장 둘 다라 한 번에 처리된다.
bundle exec fastlane match appstore
# macOS — 번들 ID도 타입도 다르다. 명시하지 않으면 iOS 기본값이 잘못 쓰인다.
bundle exec fastlane match developer_id --platform macos --app_identifier com.dawnkim.momo
```

> 위 두 명령 전에 App Group·App ID capability를 먼저 만들어 두면 재작업이 없다 —
> `docs/cicd/10-ios-signing-identity-runbook.md` §1~2. 실행 전후로
> `./scripts/verify_ios_signing.sh`(자격증명 불필요)로 식별자 정합을 확인한다.

## 3. GitHub Secrets 등록 (docs/cicd/02 목록)
```bash
gh secret set ASC_KEY_ID        --repo yeomyeonggeori/oort --body "$ASC_KEY_ID"
gh secret set ASC_ISSUER_ID     --repo yeomyeonggeori/oort --body "$ASC_ISSUER_ID"
printf '%s' "$ASC_KEY_P8_BASE64" | gh secret set ASC_KEY_P8_BASE64 --repo yeomyeonggeori/oort
gh secret set MATCH_GIT_URL     --repo yeomyeonggeori/oort --body "$MATCH_GIT_URL"
gh secret set MATCH_PASSWORD    --repo yeomyeonggeori/oort --body "$MATCH_PASSWORD"
gh secret set MATCH_GIT_TOKEN   --repo yeomyeonggeori/oort --body "<signing repo 접근 PAT>"
```

## 4. 동작 확인
```bash
# 로컬 비대화형 리허설(시뮬레이터 빌드만)
bundle exec fastlane ios ci_build

# 게이트 PASS 후: TestFlight 1회
bundle exec fastlane ios beta
```

## 5. 트러블슈팅 (검증됨 이슈)
- `Authentication credentials are missing` → API Key 미주입. `app_store_connect_api_key` 호출 누락 점검. (fastlane discussion #18100)
- `pilot` 빌드 처리 hang(#20645) → `skip_waiting_for_build_processing: true` + 별도 폴링.
- fastlane notarize + API Key 버그(#22055) → release-macos.yml의 "직접 notarytool" step 활성(`if: true`).
- match 2025-05 Apple API 변경(#29498) → `bundle update fastlane`로 최신 고정.
- Developer 역할 키는 빌드정보/테스터 갱신 불가 → **App Manager** 키 사용. (pilot docs)
</content>
