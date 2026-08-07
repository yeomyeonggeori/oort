# oort — 총비용 원장 (2026)

> 사실 = 1차 출처 확정. 추정 = 시장가(벤더 선택 시 실금액으로 교체). **법률/세무 자문 아님.**

## 고정/필수
| 항목 | 금액 | 주기 | 사실/추정 | 출처 |
|---|---|---|---|---|
| Apple Developer Program | $99 USD | 연 | **사실** | https://developer.apple.com/programs/whats-included/ |
| D-U-N-S (법인만) | $0 | 1회 | **사실** | https://developer.apple.com/help/account/membership/D-U-N-S/ |

## 인프라 (벤더 미정 — 선택 후 실금액 교체)
| 항목 | 추정 금액 | 주기 | 메모 | 출처 |
|---|---|---|---|---|
| `.com` 도메인 등록 | $10~20 | 연 | 갱신 $15~40/yr | https://www.hostinger.com/tutorials/domain-name-cost |
| VPS (server+relay+worker+Centrifugo 동거) | $4~80 | 월 | 사양 의존. 단일 VPS 셀프호스트로 묶기 가능 | https://www.digitalocean.com/solutions/vps-hosting |
| PostgreSQL 18 | $0(VPS 셀프) ~ $15~25(managed) | 월 | 셀프호스트면 VPS에 포함 | https://northflank.com/blog/best-postgresql-hosting-providers |

## 소규모 합계(추정)
- 월 약 **$20~25** + 도메인 연 **$10~15**.
- 단일 VPS 셀프호스트(PG·Centrifugo 동거) 시 월 $5~10 수준까지 가능(추정).

## 선택/조건부
| 항목 | 금액 | 조건 |
|---|---|---|
| OpenAI/LLM(hermes) 사용량 | 사용량 기반 | 에이전트 호출량 비례(서비스 자체 비용, 출시비용과 별개) |
| 변호사 검토 | 견적 | 개인정보처리방침/EULA/에이전트 고지 1회(권장) |
| APNs | $0 | Apple Developer 포함 |

> TODO(Codex): 벤더/플랜 확정 후 "추정" → 실금액 교체, "사실"로 갱신.
