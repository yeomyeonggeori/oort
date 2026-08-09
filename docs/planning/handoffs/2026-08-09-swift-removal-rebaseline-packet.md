# 핸드오프 패킷 — Swift 삭제 판정재료 생산 (감사 재기준화 + 증보 1 복원 초안 + 11패밀리 3칸 표)

> 발주: 2026-08-09 Fable 세션 (성재 편성 승인). **성재 판정의 입력을 만드는 일**이다 — 판정 자체는 내리지 않는다.
> 배경: 감사 정본 `docs/planning/research/2026-08-09-swift-removal-audit.md` §0-1이 Blocker 판정("삭제 게이트 ADR-0145 증보 1이 머지 `a749d765`에서 유실, 13패밀리 중 2만 충족"). 브리프의 "선행조건 충족"은 오기이며 별도 정정된다.

## 0. 규율 (전부 하드)

- **삭제 0줄, 코드 변경 0** — 산출물은 문서만.
- 작업 브랜치: `main` 기준 `docs/swift-removal-rebaseline`. **PR 만들고 STOP**(머지는 오케스트레이터가 성재 승인 후).
- ADR 본문을 Accepted로 바꾸지 말 것 — 증보 1 복원은 **초안**(제안 상태 명시)으로.
- 판정 칸은 **비워 둔다**. 채우면 그 표는 버려진다.

## 1. 임무 3건

### T-A. ADR-0145 증보 1 복원 초안
- 원문: `git show 06677ee3:docs/adr/0145-server-stack-buzz-fork-rust.md`에서 증보 1(판정표) 절 추출.
- 유실 경위: 머지 `a749d765`가 engine 측(증보 없음)을 취하며 증보 2만 되붙임 — 감사 §0-1에 전말 있음.
- 복원 시 그 뒤 랜딩분 반영: work-controls·work-auto-approvals는 이식 **완료**로 표기(감사 §3-1 근거).
- 산출물: `docs/adr/0145-server-stack-buzz-fork-rust.md`에 증보 1 절 복원(도입부에 "2026-08-09 복원 초안 — 성재 승인 대기" 명시).

### T-B. 감사 재기준화 (origin/track/engine 기준)
- 감사는 구 main(`8b9a898d`) 기준인데 engine이 **36커밋 앞선다**. 전 file:line 주장 중 engine에서 달라진 것을 찾아 정정 절(§ 추가)로 반영.
- 이미 실측된 소거 대상(직접 재확인 후 명시적으로 닫을 것):
  - T9(웹훅·이벤트구독 설정 표면) → `9a6feea2`·`33930f94`(engine-only)
  - T10(첨부 클라 표면) → `2dae0e06`(engine-only)
  - 따라서 R7 리스크("macOS 폐기와 함께 첨부·웹훅 표면 소실")는 과대평가 — 재판정 서술.
- 산출물: 감사 문서에 "§8 재기준화(2026-08-09, engine 기준)" 절 추가. 원문 §들은 지우지 말 것(정정은 추가 절로).

### T-C. 11패밀리 + agentRunHistory 3칸 표
- 대상: 증보 1 "보류" 13패밀리 중 미이식 11(plugins·webhooks·mcp·memories·huddles·workstreams·event-subscriptions·work-tool-profiles·bans·members 잔여·platform — 감사 §3-1 목록이 정본) + agentRunHistory.
- 각 행 3칸, **전부 현행 origin/track/engine 기준 실측**:
  - (a) Rust 서버에 있나 (라우트/서비스 실재 — 파일:줄)
  - (b) 웹/RN 클라가 부르나 (호출부 실재 — 파일:줄)
  - (c) 폐기하면 무엇이 사용자 눈에서 사라지나 (표면 서술 1~2줄)
  - (판정) — **공백**
- 산출물: `docs/planning/research/2026-08-09-swift-family-disposition-table.md` 신설.

### (부수) Xcode Cloud 전환 잔여 ⑥ 확인
- `docs/planning/research/2026-08-06-xcode-cloud-transition.md`의 "워커 가능 6건" 중 ①~⑤ 완료 실측됨. ⑥(문서 등재)의 현재 상태를 확인하고, engine 브랜치 문서(`docs/cicd/10` §8)로 이미 충족이면 **보고에만 적고 손대지 말 것**(engine 문서는 이 PR 범위 밖).

## 2. 보고 규약

- 최종 보고 = PR 번호 + 산출물 3건 경로 + T-B에서 소거/정정된 항목 수 + T-C 표에서 (a)(b) 모두 "없음"인 패밀리 목록(폐기 유력 후보 — 판정은 아님).
- 중간 보고 없음. 완주 후 최종 보고 1회.
