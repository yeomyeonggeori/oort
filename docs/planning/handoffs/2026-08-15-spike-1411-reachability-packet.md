# SPIKE #1411 핸드오프 패킷 — 브라우저→CubeSandbox 도달성 실측 (ADR-0165 D3 증보 선행)

> 2026-08-15 Fable 발급, 성재 결재(2026-08-15 "스파이크 선행" + "남은 작업 순차 진행 ㄱㄱ"). 워커: 단발 무명 Opus 5.
> 정본 goal: GitHub Issue **#1411**. 산출물=research 정본 1건(코드 변경 없음). planning ID PLN-20260815-01.
> 선례 필독: `docs/planning/research/2026-08-09-cubesandbox-d42-spike.md`(§1 호스트 준비 45분 절차·§5 네트워크 실측) · `2026-08-09-cubesandbox-u1-verdict.md` · ADR-0157(+증보 1 — eBPF deny_out) · ADR-0165 D3.

## 0. 실측된 현재 좌표 (2026-08-15 Fable 선행 정찰)

- NCP VPC 계정에 서버 2대: **momo-t3-smoke**(101.79.11.189 / 10.0.1.6, Ubuntu 22.04·2vCPU·8GB — 스모크/점프 호스트, cubelet 없음, **읽기 전용으로만 사용·변경 금지**) · factsheet-data405-worker(**타 프로젝트 — 접촉 절대 금지**).
- **d42의 CubeSandbox 호스트(10.0.1.8)는 회수돼 없음** → 폐기 측정 VM을 새로 만든다.
- 자격: `~/.ncp/credentials.env`(API 서명 v2 — 이 세션이 검증한 조회 스크립트 `scratchpad/ncp_list_servers.py` 참조 가능) · `~/.ncp/momo-t3-smoke.pem`(getRootPassword 복호화용 선례). 신규 VM은 **createLoginKey로 새 키 생성 → pem을 `~/.ncp/`에 저장**.
- 외부 사점(vantage) = 이 맥(브라우저 입장). momo-t3-smoke는 "같은 VPC 내부 사점"으로 읽기 전용 활용 가능.

## 1. 미션 — 3형상 실측 비교

폐기 Rocky 9 VM(d42 §1.1 사양 참조 — nested virt 필수, **Rocky 9 필수**(Ubuntu는 multipathd `+cpu` 차단 함정, d42 실측)) + CubeSandbox 표준 KVM 설치(d42 §1 절차) + microVM 1기에 테스트 리스너(WS 에코 + UDP 에코)를 놓고, **외부(맥)→VM 도달성**을 형상별로 실측:

| 형상 | 실측 항목 |
|---|---|
| **0. 기준선** | ACG 기본(22만 개방)에서 외부→호스트 임의 포트·외부→VM = 차단 확인(d42 §5.4 재현) |
| **A. 호스트 리버스 프록시** | ACG에 1포트(예: 8443) 개방 + 호스트에서 VM tap으로 WS 프록시(nginx 또는 websockify) → 외부에서 WS 왕복 성공 여부·지연 |
| **B. TURN 동형(호스트 UDP 릴레이)** | ACG UDP 포트 개방 + 호스트 socat/coturn 릴레이 → 외부에서 UDP 에코 왕복(=ICE relay 후보의 성립 조건) |
| **C. 샌드박스별 공인 포트** | 호스트 DNAT(포트→VM tap) + ACG 개방 → 외부 직결 왕복·**ADR-0157 eBPF deny_out과의 상호작용**(인바운드 응답이 outbound 필터에 걸리는가 — 핵심 미지) |

각 형상에 대해: 성공/실패·경로(어느 층이 막았나)·운영 표면(ACG 규칙 수·호스트 상주 부품·포트 소진)·보안 표면(무인증 노출 여부)을 기록. **WebRTC 실 미디어까지는 불요** — WS 시그널링 왕복+UDP 왕복이면 ICE 성립 조건 판정에 충분(브라우저 실연결은 LIVE-2 E2E에서).

## 2. 안전 규율 (위반=중단)

- **폐기 VM 전용**: 신규 VM은 전용 ACG·전용 이름(`momo-spike-1411-*`)으로 생성. **운영/기존 서버·ACG 불가침**(momo-t3-smoke 포함 — 조회만). factsheet-* 자원 접촉 금지.
- ACG 개방은 **신규 VM 전용 ACG에만**, 가능하면 소스 IP를 이 맥의 공인 IP로 좁혀라.
- **종료 시 회수 의무**: 측정 완료 후 VM terminate + 공인 IP 반납 + 로그인키 삭제(d42가 "그대로 둠"으로 남겨 유실된 전례 — 이번엔 회수가 수용기준). 회수 불가 상황이면 동결+보고.
- 비밀번호·pem·API 키는 산출물 문서에 비유입(경로명만). 계정 식별자 비유입.
- 설치 실패·nested virt 불가 등 막히면 추측 금지 — 실측 증거와 함께 동결+보고.

## 3. 산출물 (수용기준)

`docs/planning/research/2026-08-15-reachability-spike-1411.md`:
1. 형상 0/A/B/C 실측표(성공/실패·차단 층·증거 명령/출력 요약).
2. 3형상 비교(운영·보안·비용 표면) + **권고 1택**(실측 근거 명시).
3. **ADR-0165 D3 증보 초안 문단**(권고 형상을 D3 규칙으로 — TURN이면 "oort 운영분만" 조항과 정합).
4. LIVE-2 실화면 E2E 개방 조건(무엇이 더 필요한가) 1절.
5. 회수 증명(terminate·IP 반납·키 삭제 확인).

## 4. 작업 규율

단발 무명·중간 보고 없음·repo 코드 변경 0(research 문서만)·측정 스크립트는 scratch. 완주 후 최종 보고 1회: 실측표 요약·권고·회수 증명.
