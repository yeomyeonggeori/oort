# momo — CI/CD 1회 셋업 런북 (사람이 직접, 순서대로)

> Codex는 코드/워크플로우 파일을 만들 수 있지만, **Apple 계정 액션·비밀값 등록은 사람이 1회** 해야 한다.
> org=`dawnkim`, repo=`momo`. 검증 표기는 docs/cicd/00 참조.

## 사전 요건
- Apple Developer Program 멤버십(유료, 연 $99 — 법률/계약 변동 가능, 본인 확인).
- App Store Connect에 **App 레코드 생성** + Bundle ID `com.dawnkim.momo`(또는 실제 값) 등록.
- macOS 직접배포면 **Developer ID Application 인증서** 권한(Account Holder/Admin).

## 1. App Store Connect API Key(Team Key) 발급
1. App Store Connect → Users and Access → Integrations → App Store Connect API → **Team Keys** → `+`.
2. 역할 **App Manager** 이상.
3. `AuthKey_XXXX.p8` 다운로드(**1회만 가능**) → 안전 보관.
4. **Key ID**, **Issuer ID** 기록.

## 2. signing repo 생성 + match 최초 동기화 (개발자 머신)
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
bundle exec fastlane match appstore        # iOS App Store 인증서/프로파일 생성·업로드
bundle exec fastlane match developer_id    # macOS 직접배포(공증)용 Developer ID
```

## 3. GitHub Secrets 등록 (docs/cicd/02 목록)
```bash
gh secret set ASC_KEY_ID        --repo Dawn-kim-official/momo --body "$ASC_KEY_ID"
gh secret set ASC_ISSUER_ID     --repo Dawn-kim-official/momo --body "$ASC_ISSUER_ID"
printf '%s' "$ASC_KEY_P8_BASE64" | gh secret set ASC_KEY_P8_BASE64 --repo Dawn-kim-official/momo
gh secret set MATCH_GIT_URL     --repo Dawn-kim-official/momo --body "$MATCH_GIT_URL"
gh secret set MATCH_PASSWORD    --repo Dawn-kim-official/momo --body "$MATCH_PASSWORD"
gh secret set MATCH_GIT_TOKEN   --repo Dawn-kim-official/momo --body "<signing repo 접근 PAT>"
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
