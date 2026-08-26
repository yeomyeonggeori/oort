# E2E 도어벨 수용 런 — 서버 폐곡선 GREEN, 벤더 엔드포인트 RED (2026-08-24)

성재 "E2E 하자" 지시. Fable이 로컬 셀프호스트 리그(track/engine wd1-doorbell 빌드, `MOMO_DOORBELL_ENABLED=true`)로 직접 수행.

## 판정 요약

- **GREEN — oort 서버 절반 전 구간 실증**: 멘션 POST → `hosted_agent_inbox_event` 적재 → webhook-sender drain → **도어벨 POST 발화**(projection `doorbellLastFiredAtMs` 23:44:24) → Agent Port `oort_inbox_read` 3건 pull(멘션 seq 1·2 + agent_job) → `oort_message_post` 응답 랜딩(general seq 3). ADR-0171 설계대로 상수 페이로드·마스킹·게이트 전부 실동작.
- **RED(벤더, 우리 밖) — cursor webhook 엔드포인트 500**: `doorbellLastStatus=http_500`. 같은 URL/key가 오전(17:51)엔 200 `runUuid`였으나 저녁엔 상수 페이로드·오전 성공 페이로드 양쪽 모두 `{"code":"internal","message":"Error"}` 500(5.6s 지연). = cursor/그록봇 백엔드 장애. **ADR-0171 D5의 15분 스윕 폴백이 대비한 정확한 실패 모드**(undocumented 베타 표면 불안정).
- **결론**: 도어벨 기능(서버·문서·UI)은 완성·실증. 실시간 그록봇 응답의 마지막 고리는 벤더 엔드포인트 가용성에 종속 — 우리 코드 밖. 도어벨은 가속기, 정본 전달(durable inbox)은 GREEN이므로 스윕 폴백으로 회수 가능.

## 측정치

| 지점 | 값 |
|---|---|
| 멘션 T0 | 23:44:06 |
| 도어벨 발화 | 23:44:24 (drain 주기 내) |
| 도어벨 POST 지연(오전 스파이크 실측) | 9s (POST→ACK), 서버 왕복 0.95s |
| inbox pull | 3 events, hasMore=false, nextCursor 발급 |
| 응답 랜딩 | general seq 3, Agent Port 경유 |

## 부트스트랩 방식 각주

hosted 커넥션 수명주기(pairing→detected→confirm→active unpause)는 사람 릴레이 왕복이 페어링 TTL(~19분)을 소진하는 마찰이 있어(첫 시도 값 누락 붙여넣기로 커넥션 1개 expired), **오퍼레이터가 루프백으로 부트스트랩**했다: pairing handshake·active handshake 모두 `POST /v1/mcp/agent-port` + `mcp-method` 헤더로 오퍼레이터가 수행(그록봇이 하는 것과 바이트 동일한 호출). 자격증명은 그록봇으로 전달되는 커스터디 모델 불변 — 리그 부트스트랩만 대행. 멘션→inbox→도어벨→pull→응답의 **의미 있는 전 구간은 실제 서버 경로**로 실증.

## 발견된 셀프호스트 갭 2건 (적립 필요)

1. **`MOMO_HOSTED_DELIVERY_ENABLED`가 compose에 미배선**: `docker-compose.rust.yml`이 `MOMO_DOORBELL_ENABLED`만 서비스 env로 전달하고, 그 **선행 게이트**인 hosted-delivery 플래그는 전달하지 않는다. 이게 off면 멘션이 hosted inbox로 라우팅되지 않아(`hosted_delivery_not_enabled` skip) 도어벨이 울릴 대상 자체가 없다. 도어벨을 켜도 멘션 배달이 안 되는 조용한 실패. → api·webhook-sender env 블록에 `MOMO_HOSTED_DELIVERY_ENABLED: ${...}` 배선 필요(리그에선 수동 추가로 통과).
2. **drive 볼륨 초기 권한**: 신선 `oort-drive` 볼륨이 root 소유로 생성돼 앱 uid(10001)가 못 써 api가 `MOMO_DRIVE_LOCAL_DIR ... not writable`로 부팅 실패·재시작 루프. 최초 chown 부트스트랩 부재. → 엔트리포인트 또는 compose init에서 볼륨 chown 필요(리그에선 수동 chown으로 통과).

## 정리(회수)

- 스파이크 루틴 `oort-doorbell-spike` sender key는 이 리그에서 도어벨 등록에 사용됨(세션 한정). **E2E 종료 후 재발급/루틴 삭제로 무효화 예정**(#27).
- 리그 스택·터널은 검증 후 down(누적 Docker 자원 리클레임 병행).
