# 패키징(이미지 축소)·레포 토폴로지·code graph 리서치 (2026-07-23, Fable — 성재 발제)

> 발단: 성재 질문 — ① buzz의 "단일 이미지 셀프호스팅" 대비 momo 6이미지의 호스팅 부담 축소 계획 유무와 장단점 ② buzz 인프라/스택/철학/동작 ③ momo 모노레포 유지 vs 오가니제이션 분리 ④ code graph류 도구의 실효성과 적용 계획.
> 계보: PLN-20260722-02(buzz→Wave H) 후속 리서치. 근거 문서: `2026-07-22-buzz-competitive-analysis.md`(내부 4축 분석) + 본일 웹 검증 3축(buzz 배포 실체 / 패키징 패턴 / code graph 도구). **전부 제안 — 티켓/정본 반영 없음, 성재 결정 대기.**

## 1. buzz 배포 실체 — "단일 이미지" 인식 정정

- buzz는 **Block, Inc. 제품**(and Other Stuff 아님). Dorsey는 Block 의장으로서 발표·주도(2026-07-21 런칭, X 2.61M views). Apache-2.0, `github.com/block/buzz`, 런칭 +48h 기준 ~4.5K stars.
- **"이미지 1개" ≠ "컨테이너 1개"**: `ghcr.io/block/buzz:main` 하나에 `buzz-relay`/`buzz-admin`/`buzz-pair-relay` 바이너리+웹 에셋을 동봉하지만, 공식 셀프호스트 경로(`deploy/compose/`)는 **앱 이미지 + postgres:17-alpine + redis:7 + minio(+Caddy TLS 오버레이)** — 컨테이너 5~6개다. DB 내장 아님, supervisor 없음(단일 프로세스 entrypoint).
- 따라서 momo와의 실격차는 컨테이너 수(momo 상시 ~10 vs buzz 5~6)보다 **"커스텀 이미지 1개 vs momo 6개(api·relay·worker·migrate·web·linkshort)"** 와 owner 부트스트랩/day-2 표면이다. 후자는 Wave H3(560·561✅·562·563)가 이미 대응 중.
- 스택 요약(웹 검증, 내부 분석과 일치): Rust(Axum)+Tauri/React 데스크톱+Flutter 모바일(미출시), Nostr NIP-29 중심(자체 kind 81종), PG17(tsvector 검색 내장)+Redis fan-out+S3/Blossom 미디어, DM만 NIP-17 E2EE(채널 메시지는 서명 평문 — 서버 검색 가능 이유), 연합 없음("no P2P, no gossip"), APNs 전용 push-gateway 물리 분리. 자인된 갭: rate limit 스텁, 승인 게이트 suspend 미영속, 백업 문서 부실(`run.sh backup-hint`), 리소스 요구사항 미문서.

## 2. 패키징 스펙트럼 조사 (2026-07 웹 검증)

| 제품 | 형태 | 서비스 수 | 비고 |
|---|---|---|---|
| PocketBase | 단일 바이너리+SQLite | 0 | 2vCPU/4GB에서 10K 동시 realtime 실증 |
| Campfire(ONCE) | 단일 컨테이너(자체 supervisor 3프로세스: app+Thruster TLS/redis/workers) | 1 | SQLite+단일 볼륨=백업 1커맨드, 부팅 시 auto-migrate |
| Discourse | 단일 컨테이너(runit, PG/Redis/nginx 내장) | 1~2 | 12년간 유일 공식 설치 경로. rebuild=다운타임이 최대 불만 |
| Mattermost | 앱+PG(+nginx 오버레이) | 2~3 | **preview 올인원은 "production 금지·업그레이드 미지원" 명시 데모 전용**. Omnibus(.deb)도 병행 |
| buzz | 앱 이미지 1+PG+Redis+MinIO | 5~6 | momo와 동형 스펙트럼 |
| Zulip | 앱+PG+Redis+RabbitMQ+memcached | 5 | 공식은 "Docker가 오히려 유지비 증가" — VM 스크립트 설치 선호 |
| Supabase | 풀 fleet | 11 | 셀프호스트 난이도 악명 — 반면교사 |

**장단점 요지**: 단일화의 이득은 설치 마찰("docker run 한 줄"), 단일 볼륨 백업, 버전 스큐 제거, 지원 부하 감소(Discourse가 외부 PG를 거부하는 이유). 비용은 DB-in-container 데이터 유실 리스크, 업그레이드 커플링(앱 패치=DB 재시작), CVE 재출하 표면 확대, 스케일 천장 명시화, **배포판 이원화 유지비**(prod 토폴로지와 갈라지면 사고 클래스 2배 — Mattermost는 4개 배포판을 유지하는 비용을 감수). SQLite 노선은 Litestream v0.5로 DR은 해결됐지만 HA 아님 + PG=SoT 불변식과 충돌. realtime broker 제거는 Mattermost(인프로세스 WS hub+gossip)가 실증했으나 Swift에는 centrifuge 라이브러리 임베드 옵션이 없음(자체 구현 필요).

## 3. 옵션 판정 (제안)

- **옵션 A — 커스텀 이미지 6→1 멀티바이너리 통합(buzz 동형): 권고.** compose 서비스 토폴로지는 유지하고 `MOMO_*_IMAGE` 6개를 단일 이미지+서브커맨드(api/relay/worker/migrate/linkshort/web-assets)로. 이득: publish/digest-pin/attestation/시크릿 스캔/LICENSE 동봉 표면이 6→1(563·공개 조건 4와 직결), 서비스 간 버전 스큐 구조적 제거, 사용자 인지 부담 격감. 비용: 이미지 크기 증가(Swift 바이너리 6종 동봉), publish-images.yml 통합 재작업, 서비스별 독립 업그레이드 상실(현재도 동시 릴리스라 실손실 미미). **H3 후속 티켓 후보(MOMO-56x, ADR 경계 아님 — ADR-0002 컨텍스트 내 실행 판단으로 보이나 성재 확인 필요).**
- **옵션 B — Centrifugo 제거·앱+PG 2서비스 수렴(Mattermost 동형): 비권고(현시점).** 단일 쓰기경로·Centrifugo=전송전용 불변식 재설계 필요, Swift 네이티브 WS fan-out 자체 구현 비용 대비 이득 없음. 재검토 트리거: 셀프호스트 사용자 피드백에서 "서비스 수" 자체가 실측 이탈 요인으로 확인될 때.
- **옵션 C — 올인원 체험 이미지(mattermost-preview 동형): 공개 런칭 시 별도 검토.** "docker run 한 줄 체험"은 마케팅 자산이지만 "업그레이드 미지원·프로덕션 금지" 명시가 조건. 공개 게이트(564) 이후 안건.

## 4. 모노레포 vs 분리 — ADR-0001 유효 재확인

- **ADR-0001(Accepted)이 이미 결정**: M3/M4까지 모노레포 유지, 분리 트리거 5종(릴리스 케이던스/배포 채널/보안 경계/외부 기여 표면/안정 계약) + 미래 토폴로지 표(momo-signing, momo-plugins, momo-mcp, momo-landing 등) 존재. 현재 트리거 충족 항목 없음.
- **실측 — "무거움"의 실체는 tracked 콘텐츠가 아님**: tracked 1,070파일/소스 213K LOC/md 36K줄로 레포 자체는 작다. 디스크 15GB의 지배 요인은 gitignore된 SPM `.build/` 9곳(workers 4.2G·relay 3.8G·server 3.0G·clients 2.9G)+`.git` 114MB. tracked 최대 파일은 `STATUS.md` 378KB·`BUILD_TICKETS.md` 295KB(원장 성장).
- **판정 제안**: 분리는 해법이 아님(에이전트 파이프라인의 goal=Issue·핸드오프·단일 컨텍스트가 모노레포 전제 — cross-repo PR 안무는 worker 조율 비용 직격). 대신 **위생 3종 후보**: ① SPM `.build` 회수 자동화(momo-docker-reclaim 계보의 SPM판 — 트랙 워크트리 포함) ② STATUS.md/BUILD_TICKETS.md 로테이션·아카이브 정책(원장 무한 성장 방지, momo-main 안건) ③ 스냅샷 PNG 증식 관찰(현재 무해, 게이트 불요).

## 5. code graph — 조사 결론과 적용 계획(제안)

- 레포 내 관련 계획 전무(확인). 시장 실사: **CodeSee 사망**(GitKraken 인수 후 sunset), **Sourcegraph 엔터프라이즈 전용화**($49~59/user/mo, 코어 비공개), CodeViz/dependency-cruiser/madge는 Swift 미지원 — 인간용 대형 시각화 도구는 전멸에 가깝다.
- 생존 실용 옵션(전부 Swift 지원 확인): ① **codebase-memory-mcp**(MIT 단일 바이너리, tree-sitter Swift, 로컬 전용 — 논문 주장 토큰 10×↓) ② **CI 생성 Mermaid 의존성 다이어그램**(`swift package show-dependencies` / simonbs/dependency-graph→`docs/architecture/`) ③ **Periphery**(IndexStoreDB 기반 dead-code 검출 — 에이전트 작성 코드에 특효) ④ **GitHub dependency graph**(Package.resolved 지원, 무료 토글).
- 반대 근거 병기: "Is Grep All You Need?"(arXiv 2605.15184) — Claude Code급 하네스에서 그래프 검색 이득 ~2pp. 그래프는 능력이 아니라 **토큰/왕복 경제** 개선. momo의 CLAUDE.md+planning 층이 이미 최상급 "큐레이션된 repo map"이므로 도구는 보조.
- **WIP 가시화는 도구 불요**: goal=Issue 규율 덕에 GitHub Projects 보드+`goal_status.sh`가 이미 데이터를 가짐. 커스텀 대시보드는 병렬 worker 5 초과로 현행 표면이 못 버틸 때만.
- **적용 계획(승인 대기)**: Phase 0(무비용) — GitHub dependency graph 토글+Mermaid 다이어그램 1회 생성 커밋. Phase 1(실험) — codebase-memory-mcp를 goal 1~2건에 붙여 토큰/툴콜 실측, 이득 미달 시 폐기. Phase 2(게이트) — Periphery를 게이트 부채 배치에 티켓 후보로. 전부 트랙 파이프라인 바깥의 저위험 작업.

## 6. mesh-llm — 검증 결과와 편입 판단 (2026-07-23 추가, 성재 발제)

- **정체(검증)**: `github.com/Mesh-LLM/mesh-llm` — 오픈모델 분산 로컬 추론(exo/petals 계열, llama.cpp+iroh QUIC). Apache-2.0, Rust, 2.8K stars/릴리스 125회(5개월)/v0.73.1. 작성자 Michael Neale(Block goose 메인테이너)이지만 **독립 org — Block 공식 아님**("Block이 mesh-llm 출시" 류 보도는 과장). 핫한 이유: 2026-07-11 iroh 블로그 HN 프런트(347pt) + 7/21 buzz 런칭 결합.
- **buzz 연동(코드 레벨 검증)**: 실사용 확정 — desktop Cargo.toml이 mesh-llm crate 6종을 v0.73.1 태그 핀으로 의존, 릴리스 빌드 동봉("Buzz shared compute" provider). 핵심 차별 요소는 **relay 멤버십 로스터로 mesh 가입을 게이트**(팀 GPU 풀링, API 키 0). 단 dev 빌드에선 opt-in(+420 crates·llama.cpp 네이티브 빌드 부담), "experimental" 자기 선언, **서빙 peer가 타 멤버 프롬프트를 평문으로 봄**, WAN 레이턴시 물리 한계(HN 최다 쟁점).
- **momo 편입 판정(제안): 현시점 비편입 — 관찰 + 얇은 호환 경로만.**
  - 궁합 사실: ADR-0004와 구조적 호환(키 자체가 없음, OpenAI-호환 `localhost:9337/v1`), 핵심 불변식(PG SoT/outbox/Centrifugo)과 무충돌 — 별도 compute plane.
  - 비편입 근거: ①momo 에이전트는 하네스가 지능을 가져오는 모델(Claude/Codex) — 오픈모델 전용 mesh는 현 타깃에 무가치 ②"지루하고 검증된 스택" 포지셔닝과 v0.x 실험 의존성 동봉이 정면 충돌 ③로컬 모델 수요가 실증되면 ollama 지원이 선행 수순(mesh의 가치=팀 공유 풀은 알파 팀 규모에 과잉) ④peer 평문 가시성은 momo의 RLS/채널 격리 서사와 긴장 — buzz 커뮤니티 최대 쟁점(교차 정보 누출)과 동계열.
  - 채택할 것: (a) 어댑터의 OpenAI-호환 base URL 백엔드 지원 여부 확인 — 지원 시 사용자는 mesh-llm/ollama를 스스로 붙일 수 있음(통합 0비용, 문서 1줄) (b) buzz 재방문 관찰 항목에 mesh-llm 채택 지표 추가 (c) 미래 편입 시 진짜 신규 스코프는 "워크스페이스 멤버십 게이트 admission"(iroh P2P plane 신설) — **ADR 경계**로 예약만.

## 7. 성재 결정 대기 목록

1. 옵션 A(이미지 6→1 통합)를 H3 후속 티켓으로 발급할지 — 권고: 발급(공개 게이트 전 완료 시 공개 표면 축소 효과 최대).
2. 옵션 C(체험용 올인원)를 공개 런칭 백로그에 예약할지.
3. 레포 위생 3종(① SPM .build 회수 ② 원장 로테이션 ③ 관찰만) 중 티켓화 범위.
4. code graph Phase 0~2 착수 여부 — 권고: Phase 0 즉시, Phase 1 실험 1회.
5. 모노레포 유지 재확인(ADR-0001 무변경) — 권고: 유지.
6. mesh-llm — 권고: 비편입·관찰 유지, 어댑터 OpenAI-호환 백엔드 확인만 소형 후속(§6). 멤버십 게이트 mesh는 ADR 경계로 백로그 예약.

## 8. momo-main 판정 (성재 위임 2026-07-23 "기각/수용 판단해 계획 포함" — 확정)

1. **옵션 A(이미지 6→1) 수용** — MOMO-565 발급(562 랜딩 후 착수·**리허설 Phase 1 전 완료** 배치: 리허설이 최종 단일 이미지 형상을 한 번에 검증하고, 첫 공개 태그의 공개 표면이 1이미지가 되도록). ADR 불요 판단: 컨테이너 토폴로지·서비스 경계 무변경, 이미지 패키징만 — ADR-0002 컨텍스트 내 실행. publish-images.yml 통합 재작업 포함.
2. **옵션 C 수용(예약만)** — 공개 런칭 후 안건. 기안 금지, 백로그 1줄.
3. **위생 3종**: ① SPM `.build` 회수 자동화 **수용** — MOMO-566 소형(게이트 부채 슬롯, 크리티컬 패스 밖) ② 원장 로테이션 **수용** — 정책은 momo-main이 기안 후 MOMO-567 예약 ③ 스냅샷 증식 **관찰만**.
4. **code graph 수용(단계별)** — Phase 0(Mermaid 의존성 다이어그램+GitHub dependency graph 토글)은 momo-main 직접, 리허설 이후 슬롯. Phase 1(codebase-memory-mcp 실측 1회)은 공개 릴리스 후. Phase 2(Periphery)는 게이트 부채 배치 후보로 예약.
5. **모노레포 유지 재확인 수용** — ADR-0001 무변경, 트리거 미충족.
6. **mesh-llm 비편입 수용** — 소형 후속은 **본 판정에서 즉석 종결**: `HERMES_BASE_URL`은 OpenAI-호환 구성형이며(`workers/.../Config.swift:101`), 로컬 http는 `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` 해치로 허용(local mode 한정) — mesh-llm(`localhost:9337/v1`)/ollama는 사용자 구성만으로 접속 가능, 신규 코드 0. 공개 README(MOMO-564)에 "OpenAI-호환 로컬 백엔드" 문서 1줄 편입. 멤버십 게이트 admission은 ADR 경계 백로그 예약(기안 금지). buzz 재방문 관찰(4~6주)에 mesh-llm 채택 지표 추가.

**큐 편입 결과**: 크리티컬 패스 = 562 랜딩 → **565(이미지 통합)** → 리허설 Phase 1 → 564 → 공개. 그 외(566·567·code graph·옵션 C)는 전부 패스 밖 슬롯.
