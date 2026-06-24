# momo — CI/CD 비밀값 인벤토리

> 전부 GitHub repo Secrets(`Dawn-kim-official/momo`). 로컬은 `.env`(gitignore됨) 또는 export.
> ⚠️ 어떤 비밀값도 로그/PR/커밋에 노출 금지. .p8는 base64로만.

| Secret | 용도 | 형식 | 발급처 |
|---|---|---|---|
| `ASC_KEY_ID` | App Store Connect API Key ID | 짧은 문자열(예 `7UD13000`) | ASC → Integrations → Team Keys |
| `ASC_ISSUER_ID` | API Issuer ID | UUID | ASC API 페이지 상단 |
| `ASC_KEY_P8_BASE64` | .p8 개인키(base64, 개행없음) | base64 1줄 | `base64 -i AuthKey_*.p8 \| tr -d '\n'` |
| `MATCH_GIT_URL` | 서명 저장소 URL | git URL | `Dawn-kim-official/momo-signing` |
| `MATCH_PASSWORD` | match 암호화 패스프레이즈 | 강한 문자열 | 직접 생성(보관 필수) |
| `MATCH_GIT_TOKEN` | signing repo 접근 토큰 | PAT(repo scope) 또는 deploy key | GitHub Settings |

## 선택(상황별)
| Secret | 용도 | 비고 |
|---|---|---|
| `TEAM_ID` | Developer Portal Team ID | 다중 팀 계정일 때 Appfile/명시 |
| `ITC_TEAM_ID` | App Store Connect Team ID(숫자) | 다중 팀 |
| `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD` | (대안) 앱전용 비번 | API Key 못 쓸 때만. 비권장. |
| S3 사용 시 `S3_ACCESS_KEY`/`S3_SECRET_ACCESS_KEY`/`S3_BUCKET`/`S3_REGION` | match S3 저장 | git 대신 S3 쓸 때 |

## 권한 모델 메모 (검증됨)
- API Key는 **Team Key**(Individual 불가: provisioning/notary 미지원).
- 역할 **App Manager 이상**(Developer 역할은 업로드만, 빌드정보·테스터 갱신 불가).
- macOS 공증은 같은 Team Key로 notarytool `--key/--key-id/--issuer`.
</content>
