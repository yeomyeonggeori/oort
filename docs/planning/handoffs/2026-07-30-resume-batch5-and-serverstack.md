# 재개 세팅 — 2026-07-30 (배치 5 완료 + 서버 스택 재검토 지점)

> **이 문서 하나로 재개한다.** compaction 후에도 여기부터. 워커 모델 = **Opus 5**(effort 핀 없음).
> 병렬 실행 = **Workflow**(`/workflows` 관전) 또는 **이름 없는 백그라운드 서브에이전트**. `name:` 준 팀메이트 금지(성재 지시).

## 0. 지금 상태 한 줄

**배치 1~5 전부 랜딩·main 반영 완료**(main=engine=uxui=`39e45765`). 실작업 PR 0건(열린 PR은 dependabot뿐). **진행 중 작업 없음.** 성재가 **서버 스택 재검토(Swift→?)**를 P0 방향 결정으로 올렸고, 리서치·판단 완료 → **성재 결정 대기**.

## 1. 서버 스택 — **결정됨 (2026-07-30 성재)**: buzz fork + Rust, 지금 착수

**성재 결정: buzz fork + 고유 이식(§7 A안) · 지금 최우선 착수.** → **ADR-0145 Accepted**(`docs/adr/0145-server-stack-buzz-fork-rust.md`).

**스파이크 완료 → A안(fork) 불성립 판정.** momo 하드 불변식 3개(단일 쓰기경로·gapless seq·RLS FORCE)가 buzz의 Nostr relay 코어(클라 직접 서명 publish·created_at 순서·RLS 전무)와 **정면 충돌**. buzz는 momo 고유(T3·workstream·과금) 전무 → fork 절감 실질 증발. (곡선도 다름: buzz=secp256k1 Schnorr, momo=Ed25519.) **스파이크 권고 = B안(참조 재작성): 서버=Rust/Axum·workd Rust·지금 착수는 유지하되 momo 불변식 3개 보존, buzz는 코드 레퍼런스로만.** → **성재가 B안 전환 승인해야 이행 착수.** ADR-0145에 스파이크 판정 기록됨. buzz clone: scratchpad/buzz.

(원래 착수 첫 단계였던 buzz 대조 스파이크는 완료됨) buzz(github.com/block/buzz) 코드를 읽고 ①Nostr 이벤트 모델 ↔ momo 불변식(PG=SoT·단일 쓰기경로·RLS FORCE) 화해 가부 ②buzz 스키마 ↔ momo 59 마이그레이션 대조 ③재사용 층 vs momo 고유(T3·workstream) 경계 ④이식 계획·fork 방식 판정. **스파이크 결과가 ADR-0145 세부를 확정. 스파이크 없이 fork 코드 착수 금지.**
- 스파이크 완료 시: 결과 검토 → 이행 배치(메신저 코어 검증→T3 이식→workstream 이식→클라이언트 재배선) 설계.
- **Nostr 수용이 momo 불변식과 안 맞으면 A안→B안(참조 재작성) 후퇴** — 스파이크가 그 판정.
- 병행: NCP smoke는 서버 스택과 독립(§2)이라 계속 가능.

정본(판단 근거): `docs/planning/2026-07-30-server-stack-reassessment.md` (§0~§7).

**핵심 결론**:
- **Swift 서버 = 잔재 확정.** momo가 참조한 **buzz(Block/Dorsey, 2026-07 출시, github.com/block/buzz)가 서버를 Rust/Axum으로 짰고** momo만 Swift로 어긋났다. buzz ↔ momo 스택이 1:1 대응(Rust/Axum·PG·Redis→Centrifugo·S3·TS+React 클라이언트).
- 성재 축(정합성·스케일·내구성)으로 재평가 시 **Rust/Axum 유력**(TS/Encore.ts 차점, Hono는 철회 — 엣지용이라 부적합). 내 첫 TS 권고는 "개발속도" 가중치였는데 성재가 낮춤.
- **buzz가 Apache 2.0** → "재작성 언어"보다 상위 결정: **자체구축 유지 vs buzz 코어 기반**. §7에 3방식(A fork / B 참조재작성 / C upstream), **B 권고**.
- momo 고유(T3 work runtime·workstream)는 어느 방식이든 우리가 짠다 — buzz는 메신저 하부층만 대체.

**성재에게 물을 것(AskUserQuestion 준비됨)**: ①방향(buzz기반 / Rust재작성 / TS재작성 / Swift유지) ②타이밍(지금·사용자0이 가장 쌈 / T3·workstream 안정 후 / 출시 후). **compaction으로 질문이 유실되면 이 문서 §1 보고 다시 물어라.**

## 2. NCP T3 smoke — 서버 스택과 독립, 디스크 결정만 남음

- 서버 `momo-t3-smoke`(인스턴스 143929369) **RUN**, 공인 IP `101.79.11.189`, **SSH 접속 확인됨**(pem 직접 로그인 불가 — `getRootPassword`로 비번 복호화 후 `sshpass`, 비번은 `scratchpad/.ncp-root-pw` 0600).
- Ubuntu 22.04.3 · 2 vCPU · RAM 7GB · **디스크 가용 4.4GB** · docker 미설치.
- **내가 틀렸던 것(성재 지적)**: prod는 소스 빌드가 아니라 **이미지 pull**(`infra/prod/docker-compose.prod.yml` 전 서비스가 `image:`, api는 `${MOMO_API_IMAGE}`). 그러니 Swift 툴체인 불요 — 4.4GB로 충분할 수 있다. dev compose로 소스빌드하려던 게 오류였다.
- **다음 한 걸음**: `MOMO_API_IMAGE`가 어느 레지스트리에 퍼블리시됐는지 확인(안 됐으면 퍼블리시 선행) → 서버에 Docker 설치 → prod compose로 스택 → **BYOC 등록→세션→과금→종료** smoke → `MOMO_T3_ENABLED` 판단.
- 도구: NCP MCP(`scratchpad/NCP-Claude-Project/ncp-mcp`) + venv(`scratchpad/ncp-venv`, mcp 1.x). 자격 `~/.ncp/credentials.env`. **MCP 한계**: `provision_server`는 구형 XEN 전용 → KVM(Ubuntu22)은 `scratchpad/ncp-create-kvm.py` 형태(serverImageNo+serverSpecCode+networkInterfaceList). 자원 생성은 성재 트리거(승인 분류기가 막음).
- **비용**: 시간당 100원대, 켜져 있음. 안 쓰면 정지 권고. **API 키 명령줄 노출 — 종료 후 재발급 권고.**

## 3. 열린 티켓 (배치 6 후보)

- **#925 [우선]** verify_plugin_registry·grant_roundtrip 선존재 red(base 재현). "projected capability 1개 기대인데 2개" — **서버가 실제로 권한을 두 번 투영하는지 먼저 판정**(그러면 사용자에게 권한 중복 표시). bisect + 무회귀 세트 편입.
- **#926** Workstream/작업세션 잔여(M7 목표 역링크 상태·M8 `?work=` 착지 전 소비 + Nitpick 5).
- **#893** 랩탑 90초 슬립 세션 죽음 — **ADR-0141 방향(A 복귀재부착 / B unreachable 중간상태) 성재 결정 선행**. 보류 중.
- 랜딩됐는데 안 닫힌 이슈들(#888·#885·#882·#875·#861·#860·#859·#858·#857·#856·#855): 일괄 close가 classifier에 막힘 — 개별 확인 후 정리 필요.
- 성재 몫: `legal/privacy-policy.md` 빈칸(출시 차단) · #837 RN 실기기 · ADR-0138(온보딩)/0113 증보(3자 OAuth) · **ADR-0144 승인 시 Kata PoC(베어메탈 노드)**.

## 4. 배치 1~5 요약 (완료, 재검증 불요)

- **배치 1**(#897·#898·#870·#865): provider 어댑터+E2B 제거·workstream 계층·데몬 reconciliation·게이트 완주.
- **배치 2**(#903·#892·#869): **ADR-0140 이행 완결**(T-2·T-3·T-4)·**ADR-0139 재부착 실왕복 검증**.
- **배치 3**(#911·#910·#912·#909): 과금 정밀도·스펙 부채 소거·attach 후속·동의모달/danger 위계(J 2R).
- **배치 4**(#916·#917·#918): 스펙 승격·동의 Medium·Workstream 웹 표면(N 2R).
- **배치 5**(#922·#923·#924): local_gate 무신호 해소·매니페스트 한국어화·Workstream 잔여(Q 2R).
- ADR: 0140~0144 Accepted, 0141 보류.

## 5. 파이프라인 교훈 (누적)

- 결함은 워커가 못 돌리는 **docker 계층**에 몰린다 — 오케스트레이터가 곧 그 계층 테스터.
- **게이트가 한 국면만 보면 그 밖은 없는 것과 같다**(배치5 Q: High 2가 전부 게이트 1440px만 봐서). 신규 공용 컨트롤은 가장 좁은 실사용 폭에서 단정.
- **대비 단정은 합성해서 재라**(opacity는 계산된 color를 안 바꿈 → 그것만 읽는 단정은 회귀 통과).
- 선존재 검증기 red 반복(#903·#925) — **무회귀 세트 밖 검증기는 언젠가 조용히 red**. 세트 편입을 티켓 수용기준에.
- **푸시된 커밋 amend/force-push 금지**(배치4 N 위반) — 새 커밋으로. 배치5부터 공통 규율.
- "아무 non-2xx나 통과" 단정 금지(404와 거부 구분 못 함).
- 워커 자기신고 이탈이 정착 — 대부분 타당(근거와 함께).
