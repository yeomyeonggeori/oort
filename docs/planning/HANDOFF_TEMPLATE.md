# 핸드오프 패킷 템플릿

> 사용법: 이 파일을 `docs/planning/handoffs/YYYY-MM-DD-<slug>.md`로 복사해 채운다.
> 원칙: **worker에게 보내는 채팅 메시지는 3줄, 맥락은 전부 이 패킷에.** 패킷만 읽고 착수 가능해야 합격.
> 각 항목은 "왜 필요한가"가 아니라 "worker가 추론으로 못 얻는 것"만 담는다. 정본 문서는 링크하고 복사하지 않는다.

---

# HANDOFF: <배치 이름>

> Status: `draft | ready | active | superseded`
> Planning ID: `<ADR-01NN | PLN-YYYYMMDD-NN>` · Planner owner: `<Fable | GPT 5.6>` · Integrator: `momo-main`
> 발급: YYYY-MM-DD · 기준 커밋: `<full commit SHA>` · Supersedes: `<없음 | 이전 패킷 경로>`
> 근거 ADR: `<ADR-01NN (Accepted 날짜) | ADR not required: 근거>` · 대상 goal: <MOMO-NNN, ...> · 병렬 가능: <예/아니오 + 머지 순서>
> GitHub binding: `<미발급 | MOMO-NNN=#이슈, ...>`

`ready` 이후 계약을 바꿀 때 이 파일을 조용히 덮어쓰지 않는다. worker가 하나라도 착수하면 `active`로 전환할 수 있다. 계약 변경은 새 패킷을 만들고 이전 패킷을 `superseded`로 바꾼 뒤 Issue Context 링크를 갱신한다. Issue 번호 binding과 goal 상태만 추가하는 것은 metadata update로 허용한다.

## 1. 결정 요약 (왜 이 작업인가 — 3~5줄)
<ADR의 Decision을 worker 관점으로 요약. ADR 링크 필수.>

## 2. Goal 체인과 의존
| 순서 | goal | 이슈 | 의존 | 병렬 |
|---|---|---|---|---|
| 1 | MOMO-NNN <한줄> | #NN | — | — |

머지 순서: <명시. 오케스트레이터가 이 순서로만 머지한다.>

## 3. 파일 맵 (어디를 만지나 — 감사/기획 시점 기준)
| 대상 | 위치 | 지금 상태 | 해야 할 변경 |
|---|---|---|---|
| <컴포넌트> | `path/to/file.swift:줄` | <현재 동작> | <변경 방향> |

> 위치는 기획 시점 스냅샷이다. 착수 시 실제 코드와 대조하고, 다르면 코드가 진실 — 단, **계약이 다르면 멈추고 이탈 보고**.

## 4. 지켜야 할 계약 (이 배치에서 절대 깨면 안 되는 것)
- <불변식/ADR 경계/기존 계약. 예: ADR-0004 provider 자격증명 경계 유지>

## 5. 알려진 함정 / 컨텍스트
- <기획·감사 과정에서 발견한 함정, 레거시 플래그, 헷갈리는 지점>

### 5.1 공통 함정 (검수 실측 축적분 — 모든 패킷에 기본 포함, 2026-07-21 승격)
1. **nil String?/UUID? 바인딩** → `::text`/`::uuid` 명시 캐스트(jsonb_build_object 내 nullable 포함 — 489 전례).
2. **트랜잭션 내 HTTPError**는 `Database.withTenantTransaction` 중앙 unwrap이 처리 — 라우트별 ad hoc unwrap 금지(565 전례).
3. **verifier 규율**: bash 3.2 빈 배열 금지 문법(`${arr[@]+"${arr[@]}"}`) / api 컨테이너에 curl 없음(mock-hermes python 대체) / `psql -q`(명령 태그 오염 방지) / UUID 비교는 `lower()` / 포트 대역 신규 배정(기존 대역 회피·사전검사) / demo 계정 password 시드 확인 / 비동기 단정은 폴링.
4. **compose/infra 변경 후 컨테이너 재시작 필수**(config drift — MOMO-338 전례). PG 이미지 교체는 e2e/dev/prod+drift guard 동시.
5. **openssl 직접 호출 금지**(LibreSSL 게이트 함정 — 내부 Crypto 사용, 491 전례).
6. **Centrifugo 발행 payload에 props 탑재 확인**(X-9 전례 — 신규 이벤트도 REST↔outbox 일치 단정).
7. 게이트 실행 후 docker 회수(`momo-docker-reclaim.sh`, 배치 종료 시).

## 6. 검증
- 게이트: `scripts/local_gate.sh --profile <...>` + <티켓별 추가 검증>
- 수용기준 정본: `BUILD_TICKETS.md` `### MOMO-NNN 수용기준`

## 7. 이탈 보고 의무
수용기준·ADR과 다르게 구현하게 되면(또는 설계 결함 발견 시) PR `## 계획 이탈` 섹션에 기록하고, 판단이 필요하면 `scripts/goal_release.sh <issue> --blocked "<사유>"`로 멈춘다. 임의 재설계 금지.

## 8. 착수 절차 (worker가 그대로 실행)
```bash
scripts/goal_status.sh                 # 충돌 확인
scripts/goal_claim.sh <issue-number>   # branch/worktree/assignee lock
# 구현 → 게이트 → PR(이슈 1개, 이탈 섹션 포함) →
scripts/goal_release.sh <issue-number> --review --pr <PR URL>
# 여기서 정지. merge/close/로드맵은 momo-main 몫.
```

## 9. 컨텍스트 델타 (오케스트레이터/다음 planner용)
- 이 패킷이 기존 정본에서 새로 고정한 것:
- 의도적으로 결정하지 않은 것:
- 구현 결과에 따라 다시 기획해야 하는 질문:
