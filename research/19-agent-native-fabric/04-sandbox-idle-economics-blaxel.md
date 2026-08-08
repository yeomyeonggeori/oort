# 외부 리서치 ③ — 클라우드 코드 샌드박스 유휴/영속성 경제학 + Blaxel 실사 (2026-07-21, Fable · PLN-20260721-01)

> 맥락: T3(oort Cloud)=E2B 재판매 확정(ADR-0125 D3, 프로비저너 provider-불가지). Blaxel 공동창업자 Nicolas Lecomte LinkedIn 접촉. CTO 핵심 질문: **"유휴 기간엔 과금이 안 된다는데, 작업 데이터가 서버에 남은 채로 유휴 반납했다가 나중에 이어서 쓸 수 있나? 그 보관에 비용이 드나?"** 모든 출처 2026-07-21 공식 페이지 직접 확인.

## §1. Provider별 유휴/영속성 계약 비교

| Provider | 유휴 메커니즘 | 보존 범위 | 유휴 컴퓨트 | **보관 과금** | 보존 한도 | Resume 지연(공칭) | 세션 최대 수명 | 과금 단위 |
|---|---|---|---|---|---|---|---|---|
| **E2B** | `pause()`(수동/auto) | **메모리+FS** | 0 | **명시 과금 없음**(플랜 포함 10~20GiB, 초과 단가 미공개) | **무기한**(자동삭제 없음) | ~1초(pause ~4초/GiB) | Hobby 1h/Pro 24h(resume 시 리셋) | vCPU-초+GiB-초 |
| **Blaxel** | 자동 standby(15초 비활성) | **메모리+FS** 풀 스냅샷 | 0 | **있음**: 스냅샷 $0.20/GB-월, 볼륨 $0.12/GB-월 | 무기한(단 Tier0=7일·Tier1=30일 TTL 강제) | **<25ms**(공칭, 실측 미확인) | 무제한(perpetual) | **RAM GB-초** $0.0000115(active, CPU 무과금) |
| **Daytona** | stop/pause(VM)/archive | stop·archive=**FS만**, VM pause=메모리+FS | 0 | stopped 디스크 ≈$0.078/GiB-월, **archived 무과금** | stop→7일 후 auto-archive | 수초급/archive는 크기 비례 | 무제한(auto-stop 15분) | vCPU+GiB+디스크-초 |
| **Morph** | pause/snapshot(+TTL, wake-on-SSH/HTTP) | **메모리+디스크**(Infinibranch) | 0 | **≈$0.0073/GB-월**(최저) | 무기한 | <250ms | 무제한 | MCU-시간($0.05) |
| **Modal** | 없음(유휴=풀과금). 메모리 스냅샷 **alpha** | FS 스냅샷=FS만 | 유휴 실행중=**과금 지속** | 미공개(볼륨 $0.09/GiB-월) | FS 30일 TTL/메모리 스냅샷 **7일 고정** | 미공개 | **24h 상한** | 물리코어-초+GiB-초 |
| **Cloudflare** | 자동 sleep(10분) | **기본 소실**(백업 API로 디렉토리만 R2) | 0 | R2 요율 | 백업 TTL 3일(R2 자동삭제 아님) | 백업 복원 ~2초 | 무제한(keepAlive) | active vCPU+GiB+디스크-초 |
| **Vercel** | stop→자동 FS 스냅샷(persistent 기본) | **FS만**(메모리 미보존) | 0 | **$0.08/GB-월**(Hobby 15GB 무료) | 최종 사용 후 30일(0=무기한 설정) | 신규 부팅 수초급 | 24h(Hobby 45분) | active vCPU-h $0.128+GB-h $0.0212 |

### CTO 질문 직답 (provider별)

- **E2B — 가능, 가장 완전.** pause가 FS+실행 중 프로세스+메모리 변수 전부 저장, 무기한 보존, resume ~1초(러닝타임 한도 리셋). **보관비: 공식 문서 어디에도 paused 스냅샷 과금 조항 없음** — 사실상 무료이나 단가·한도 미명문화 → **대량 재판매 시 정책 변경/소급 리스크. Ultimate/Enterprise 계약에서 보관 단가·보존 보장 명문화 권장.**
- **Blaxel — 가능, 자동이며 제품 정체성.** 15초 비활성→자동 standby(메모리 포함 풀 스냅샷), 컴퓨트 0, resume <25ms 공칭. **보관비 명시적: 스냅샷 $0.20/GB-월**(예: 2GB 샌드박스 한 달 standby ≈$0.40). Tier0=7일·Tier1=30일 TTL(상위 무제한).
- **Daytona — 가능하되 기본 FS만.** stopped=디스크만 과금·메모리 소실, 7일 후 auto-archive(무과금·재기동 느림).
- **Morph — 가능, 메모리 포함, 보관 최저가**(≈$0.0073/GB-월. 공식 예시: 8vCPU/8GB VM 스냅샷 영속화 월 $0.12).
- **Modal — 사실상 부적합**(유휴 0-과금 pause 없음, 메모리 스냅샷 alpha 7일 고정 만료).
- **Cloudflare — 기본 불가**(sleep 시 전부 소실, 백업은 디렉토리만).
- **Vercel — FS만 가능**($0.08/GB-월, 30일 rolling 만료).

### 단가표 상세
- E2B: vCPU $0.000014/s, RAM $0.0000045/GiB-s. Hobby 무료($100 크레딧·1h·동시 20)/Pro $150/월(24h·동시 100)/Ultimate 커스텀.
- Daytona: vCPU $0.0504/h, RAM $0.0162/GiB-h, 디스크 $0.000108/GiB-h. $200 크레딧, 스타트업 최대 $50k.
- Morph: $0.05/MCU(=1vCPU-h+4GB-h+16GB디스크-h 또는 5TB스냅샷-h). Free 300/Developer $40/Team $250.
- Modal: 샌드박스 요율 CPU $0.00003942/물리코어-초, RAM $0.00000667/GiB-초(일반 대비 ~3배).
- Cloudflare: Workers Paid $5/월 필수 + active CPU $0.000020/vCPU-초 등.
- Vercel: Active CPU $0.128/vCPU-h(I/O 대기 미과금)+메모리 $0.0212/GB-h+스냅샷 $0.08/GB-월.

## §2. Blaxel 심층

**회사**: YC X25(Spring 2025), SF, **8명·공동창업자 6명**(Paul Sinaï CEO — ForePaaS 창업·OVHcloud 매각, **Nicolas Lecomte(접촉 인물 — 공동창업자 확인)**, Christophe Ploujoux, Thomas Crochet, Charles Drappier, Mathis Joffre — 전원 OVH/ForePaaS 출신). **시드 $7.3M(2025-12-03, First Round 리드)**. 트랙션 주장(자사): 16 리전·일 수백만 요청·"10억 초+ 런타임 50% 절감" 고객.

**제품**: Sandboxes(microVM Mark 3, perpetual)·Batch Jobs·MCP 호스팅·Agent Runtime(coming soon)·LLM 게이트웨이·Volumes·Agent Drive(베타)·egress 프록시(베타)·헤드리스 브라우저(예정).

**"0-compute standby·25ms resume" 검증**: 메커니즘·과금 공식 문서로 **확인**(15초 비활성→풀 스냅샷 standby, 컴퓨트 0, 스토리지만 과금). 제한: WebSocket idle 15분, 외부 DB 커넥션 미보존, **25ms는 자사 공칭(독립 실측 미확인)**, 공식 권장도 "TTL 7~60일 설정"(롱테일 비용 방지).

**가격표(2026-07-21)**: active $0.0000115/RAM GB-초 · **스냅샷 $0.20/GB-월** · 이미지 $0.045/GB-월 · 볼륨 $0.12/GB-월 · 커스텀 도메인 $20/월 · 이메일 서포트 $800/월+3% · Slack 서포트 $1,600/월+10% · HIPAA $250/월 · 무료 크레딧 $200. 티어=크레딧 충전액 기반 자동 승급(Tier0 샌드박스 10개→Tier9 100k+).

**E2B 대비 차별점**: ①유휴 경제학이 제품 코어(자동 standby+단가 명문화 — oort T3 "세션을 무기한 쥐는" 모델과 계약 구조 정합) ②RAM 단일 과금(CPU burst 유리) ③EU 리전+SOC2/HIPAA/ISO27001 ④고정 월정액 없는 순수 PAYG(E2B는 24h 세션에 Pro $150 필요).
**약점**: ①성숙도(시드·8명·beta 다수 vs E2B는 Manus·Perplexity·Groq 레퍼런스) ②**아시아 리전 부재**(셀프서비스 Oregon/N.Virginia/London/Frankfurt — 한국 사용자 레이턴시 핸디캡, **미팅 1순위 질문=서울/도쿄 로드맵**) ③공개 SLA 문서 미확인 ④스냅샷 보관 $0.20/GB-월은 비싼 편(Vercel $0.08·Daytona $0.078·Morph $0.0073 대비 2.5~27배; 루트FS가 메모리라 스냅샷 크기가 RAM 비례) ⑤**파트너/리셀러 프로그램 공개 페이지 없음** — 역으로 백지 협상 여지.

## §3. 재판매/크레딧 BM 선례

| 제품 | 과금 단위 | 패턴 | 시사점 |
|---|---|---|---|
| **Devin** | **ACU**(VM+추론+네트워크 합성, 1 ACU≈활성 15분). Core $20+$2.25/ACU, Team $500/월(250 ACU) | 이종 원가를 단일 추상 단위로 합성, 선불 커밋+PAYG 이중 | oort 크레딧도 "원가 비노출 합성 단위"+직관 앵커("활성 15분") |
| **Replit Agent 3** | effort-based(체크포인트당) | 성과 단위 과금 — 실패 시도 과금 논란 | 성과 과금은 CS 리스크 — **시간/세션 upper bound 명시가 안전** |
| **Cursor Cloud** | 별도 VM 과금 없음 — 토큰 마진에 흡수 | 교차보조 | 원가가 월 $1~3이면 크레딧에서 분리 청구 안 하는 게 UX 우위 |
| **Manus** | 크레딧(Free 300/일, $20=4,000). 복잡 태스크 500~900, 월말 소멸 | **E2B 재판매 선례 그 자체**(E2B 공식 고객) + 소멸제 브레이키지 | E2B 위 크레딧 BM 스케일 검증 선례. 소진 불투명성이 최대 불만 |

공개 마진 구조: 전무. 공통 패턴 — (a) 이종 원가의 단일 크레딧 합성 (b) 월 소멸/선불 브레이키지 (c) **upper bound는 "동시 세션 수+세션 최대 시간", 크레딧은 활성 사용량에만 연동**.

## §4. 시나리오 시산 — 세션 1개 월 원가 (활성 30분/일×22일, 2vCPU+4GB, 스냅샷 5GB 상시 보관, CPU 100% 보수 가정)

| Provider | 활성 | 보관 | **월 원가/세션** | 비고 |
|---|---|---|---|---|
| E2B(Pro) | $1.82 | $0 | **≈$1.82** (+Pro $150 상각: 동시 100 기준 +$1.50) | 보관 단가 미명문화 리스크 |
| Blaxel | $1.82 | $1.00 | **≈$2.82** | 고정비 0. RAM 기준 스냅샷 4GB면 ≈$2.62 |
| Morph | $1.10 | $0.037 | **≈$1.14** | 최저(할인 전) |
| Daytona | $1.83 | $0.78 | **≈$2.61** | archive 시 보관 $0·재기동 느림 |
| Vercel | $2.82+메모리 $0.93 | $0.40 | $2.0~4.2 | 메모리 미보존. I/O 미과금이라 실측 하회 |
| Modal | — | — | 부적합 | 유휴 0-과금 없음(대기 시간당 $0.24 누수) |
| Cloudflare | — | — | 요건 미충족 | 메모리 미보존 |

**결론**: 세션당 월 원가 **$1~3** — 크레딧 판가 대비 무시 가능(Devin 1 ACU $2.25와 동일 자릿수). **실질 변수는 활성 컴퓨트가 아니라 (a) 스냅샷 보관 단가×휴면 롱테일 (b) 고정비 상각(E2B Pro $150) (c) 보존 기한 정책.** oort가 "휴면 30일 후 아카이브/정리" 정책을 넣으면 어느 provider든 보관 원가는 세션당 월 $1 이하로 캡핑.

## §출처 (2026-07-21 확인)

- E2B: e2b.dev/docs/sandbox/persistence · /pricing · /docs/billing
- Blaxel: blaxel.ai/pricing · /sandbox · docs.blaxel.ai(Sandboxes/Overview·Expiration·Infrastructure/Regions·Gens·Security/Quotas) · ycombinator.com/companies/blaxel · blaxel.ai/blog($7.3M 시드 2025-12-03)
- Daytona: daytona.io/pricing · /docs/billing · /limits · /sandboxes
- Morph: cloud.morph.so/web/subscribe · /docs(ttl·basic-lifecycle)
- Modal: modal.com/pricing · /docs/guide/sandboxes · /sandbox-snapshots
- Cloudflare: developers.cloudflare.com/containers/pricing · /sandbox(concepts·backups)
- Vercel: vercel.com/docs/sandbox(pricing·persistent-sandboxes·snapshots)
- BM: docs.devin.ai/admin/billing · blog.replit.com/effort-based-pricing · forum.cursor.com(#156843, 2026-04-30 스태프) · Manus 크레딧 기사+E2B 고객 사례

**미확인 명시**: E2B paused 스냅샷 초과 단가 / Blaxel 25ms 독립 실측·공식 SLA·파트너 프로그램 / Modal FS 스냅샷 보관비 / Daytona archived 상한·재기동 공칭치 / Cloudflare 백업 과금 조항 / 재판매 마진 공개 사례(전무).
