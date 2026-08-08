# oort — App Privacy 데이터 매핑 (영양성분표 입력 소스)

> App Store Connect "App Privacy" 입력값의 1:1 소스. **신규 앱·업데이트 제출 시 필수.**
> 출처: https://developer.apple.com/app-store/app-privacy-details/
> 제3자 SDK 수집까지 포함해야. **법률 자문 아님 — 실제 수집 코드와 대조 검증 필수(TODO).**

## 데이터 유형 × 수집 여부 × 목적 (초안 — schema_v0.sql 기반, 검증 필요)
| Apple 데이터 카테고리 | oort 수집? | 데이터 | 목적 | 사용자 연결 | 추적 |
|---|---|---|---|---|---|
| Contact Info (이메일) | 예(추정) | 계정 이메일 | 앱 기능(로그인/식별) | 예 | 아니오 |
| User Content (메시지) | 예 | 메시지 본문, 첨부 | 앱 기능(메신저) | 예 | 아니오 |
| User Content → 제3자 | 예 | 메시지 → LLM(hermes/OpenAI 호환) | 앱 기능(에이전트 응답) | 예 | 아니오 |
| Identifiers (계정 ID) | 예 | user/workspace UUID | 앱 기능 | 예 | 아니오 |
| Identifiers (디바이스/APNs) | 조건부 | APNs 토큰 | 앱 기능(푸시) | 예 | 아니오 |
| Usage Data / Diagnostics | 검토 | 로그·진단(있으면) | 분석/성능 | TBD | 아니오 |
| Financial / Location / Health | 아니오 | — | — | — | — |

## 체크포인트
- [ ] "Data Not Collected" 주장 가능 카테고리 vs 수집 카테고리 확정.
- [ ] LLM 제3자 전송을 개인정보처리방침(§5)·에이전트 고지(§10)와 정합.
- [ ] iOS/iPadOS 26 SDK 이상 빌드(2026-04-28 게이트) — C2 타깃 확인.
  출처: https://developer.apple.com/app-store/submitting/
- [ ] 실제 수집 코드(서버 로그/분석 SDK 유무) 대조 후 표 확정.

> TODO(Codex): 표 확정 → ASC App Privacy 입력값과 1:1 매칭표로 마감.
