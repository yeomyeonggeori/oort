# 도어벨 E2E 재시험 런북 (RERUN)

> 2026-08-25 작성. 1차 런(REPORT.md)은 서버 절반 전 구간 GREEN, cursor 벤더 엔드포인트 500 RED로 종료.
> 리그·터널은 회수됨(스택 down, **볼륨은 보존** — `oort_*` 네임드 볼륨에 워크스페이스·커넥션·drive 상태 잔존).
> 이 문서는 벤더 회복 후 재시험을 세션 무관하게 재현하기 위한 절차다.

## 0. 선결 조건 (사람 액션 포함)

| # | 항목 | 담당 | 비고 |
|---|---|---|---|
| 1 | 스파이크 루틴 `oort-doorbell-spike` 삭제 또는 sender key 재발급 | **성재** (그록봇 계정) | 1차 런 key는 세션 한정 원칙 — oort 측 도어벨 시크릿은 이미 DELETE 200으로 무효화됨. 재시험엔 새 key 필요 |
| 2 | 벤더 회복 확인 | 아무 세션 | 루틴 webhook URL에 **무인증 POST** → `401`이면 회복, `{"code":"internal"}` 500이면 아직 장애. key 불필요한 프로브 |
| 3 | 루틴 지시문 = 프로덕션 지시문인지 확인 | 성재+오케스트레이터 | 정본: `SELF_HOST_AGENT.md` §4 (WD-3 랜딩분) — inbox pull→응답 post→15분 스윕 |

## 1. 리그 재기동

1차 런은 `wd1-doorbell` 워크트리 빌드였으나, **도어벨 서버는 이제 main에 랜딩됨**(#1739, WD-1+WD-3). 두 경로 중 택1:

- **A. 볼륨 재사용(빠름)**: 같은 compose 파일 세트로 `-p oort` 재기동 — 기존 워크스페이스·hosted 커넥션·drive 상태 유지.
  ```
  cd ~/projects/momo-tracks/momo-worktrees/wd1-doorbell/infra/rust
  docker compose -p oort -f docker-compose.rust.yml -f local.override.yml -f docker-compose.rust.build.yml up -d
  ```
  ⚠ wd1-doorbell 워크트리가 회수되면 이 경로는 소멸 — 그 경우 B로.
- **B. main 기반 신선 리그**: main 체크아웃에서 동일 compose 세트로 빌드(도어벨 포함). 신선 볼륨이면 아래 §2 수동 우회 2번이 다시 필요.

## 2. 수동 우회 2건 (#1747 랜딩 전까지 필수)

1. **`MOMO_HOSTED_DELIVERY_ENABLED=true` 수동 배선** — compose가 api·webhook-sender에 이 선행 게이트를 전달하지 않음. 빠지면 멘션이 hosted inbox로 라우팅되지 않아(`hosted_delivery_not_enabled` skip) 도어벨이 울릴 대상이 없는 **조용한 실패**. `MOMO_DOORBELL_ENABLED=true`와 함께 둘 다 켤 것.
2. **drive 볼륨 chown** — 신선 볼륨은 root 소유라 앱 uid(10001)가 못 써 api 부팅 루프. 볼륨 재사용(A)이면 이미 처리됨.

#1747이 track/engine에 랜딩되면 이 절은 삭제.

## 3. 터널 + 도어벨 재등록

1. `cloudflared tunnel --url http://127.0.0.1:8088` → 발급된 quick-tunnel URL 기록.
   - 각주: 태스크 #13 시절 RA-5 판정(그록봇 egress=CF 대역 공유로 quick tunnel 1015 구조 노출) — 재발 시 Tailscale Funnel 전환 검토.
2. 그록봇 루틴 지시문에 새 터널 URL 반영(자연어 릴레이 — CDP 금지, 성재 결재 2026-08-22).
3. hosted 커넥션 상태 확인 — 1차 런에서 1개 expired. 필요 시 **오퍼레이터 루프백 부트스트랩**(REPORT.md 각주: pairing·active handshake를 `POST /v1/mcp/agent-port` + `mcp-method` 헤더로 오퍼레이터가 직접 — 그록봇과 바이트 동일, 커스터디 모델 불변. 페어링 TTL ~19분 내 완주).
4. 도어벨 등록: 커넥션 단위 REST(SELF_HOST_AGENT.md §4)로 새 webhook URL + 새 key 등록.

## 4. 수용 런 + 판정

- 멘션 POST → `doorbellLastFiredAtMs` 갱신 + `doorbellLastStatus=ok` 확인 → 그록봇 run → inbox pull → 응답 랜딩.
- **수용 기준: 멘션→응답 p50 ≤ 90s** (패킷 기준. 1차 실측: 도어벨 발화까지 18s, 스파이크 POST→ACK 9s라 여유).
- 실패 모드별: 도어벨 500이면 벤더 장애(§0-2 재확인), `hosted_delivery_not_enabled`면 §2-1 누락, api 부팅 루프면 §2-2.

## 5. 종료 회수 (매 런 의무)

- 도어벨 시크릿 DELETE → 성재 측 루틴 key 재발급/삭제 → `docker compose -p oort down` + cloudflared kill.
- Docker 잔재 확인: `docker compose ls -a` — momo* 게이트 스택 잔류 시 down (발열 이슈, `~/.local/bin/momo-docker-reclaim.sh` 참고).
