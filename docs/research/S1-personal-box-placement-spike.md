# S1 — 박스 배치 실측: 런너 호스트 vs Railway 별도 프로젝트 (#3408)

- 근거: ADR-0197 배치 비교·D2·D9·T4·T8·T10·구현 계획 S1, 성재 승인 2026-10-04 「프로젝트 승인」(별도 Railway 프로젝트 생성·과금)
- 코드·시험: `infra/personal-box/s1/` (`runner-egress.nft`, `box-probe.sh`, `run-runner-suite.sh`, `Dockerfile.probe`, `rw.sh`, `rw-gql.sh`, `railway-box-probe.sh`, `cross-project-probe.sh`)
- 표기: [V] 이 스파이크에서 실행해 확인 · [S: url] 공식 문서 · [추정] 계산·가정 · [?] 못 쟀음. 모든 Railway 시험은 스파이크 전용 프로젝트 `oort-personal-box-spike-s1`(+교차 시험용 `-b`)에서만 했고 팀 인스턴스 프로젝트는 건드리지 않았다.

## 한 줄 판정

**Railway 어댑터(B)는 MVP 런너 인터페이스 뒤의 대안으로는 닫는다.** 같은 프로젝트의 박스끼리는 서로 닿고(서비스별 격리 수단 없음), 프로젝트 토큰은 범위를 좁힐 수 없으며(root exec·변수 읽기/쓰기·시작 명령·백업 변경이 모두 된다), 서비스 egress 제어가 없고(SMTP 25/465/587 열림), 볼륨 크기를 10GB로 못 정한다. ADR-0197 판단의 「토큰 권한을 좁히지 못하면 B는 닫는다」 조건을 그대로 충족한다. 박스당 별도 프로젝트로는 박스 간 격리가 실증됐으나(아래) 토큰 문제와 egress 문제는 그대로다. **A(런너 호스트)가 MVP다.** 열려 있는 후속 가능성은 Railway **Sandboxes** 제품(`networkIsolation: ISOLATED` = 「peer-isolated, public NAT egress only」)이며 이번에 실행하지 않았다([?], 아래 「남은 일」).

## ① 런너 호스트: 하드닝 컨테이너 + 선언 nftables [V]

환경: Colima 리눅스 VM(Ubuntu 24.04, kernel 6.8, nftables 1.0.9, Docker 29.5). 전용 브리지 `momos1br`(박스, 10.231.0.0/24 + fd00:5a1::/64)와 대상 브리지 `momos1tg`. 스탠드인 대상(사설·CGNAT·메타데이터·「공용」 주소와 IPv6 ULA)은 한 컨테이너의 `lo`에 달고 호스트 라우트로 보내 **실제 forward 경로**를 지나게 했다. 모든 프로브는 **규칙 적용 전(baseline)과 후**에 같은 박스에서 돌렸다. baseline에서 전부 OPEN이어야 프로브가 유효하고(시간 초과가 「원래 안 닿음」이 아님을 증명), 대조군 2개(`control_*`)는 후에도 OPEN이어야 한다. `nft flush ruleset`은 쓰지 않았고 테이블 `inet momo_s1`·`bridge momo_s1_l2`만 추가·삭제했다(같은 VM의 다른 프로젝트 컨테이너 무영향).

박스(하드닝): uid 10001, `--read-only`, `--cap-drop ALL`(CapEff=0), `no-new-privileges`(NoNewPrivs=1), 기본 seccomp(Seccomp=2), pids 256·512MB·1 CPU, `ulimit -c 0`, noexec tmpfs, 루트 쓰기 거부("Read-only file system") 확인.

| 프로브 | 대상 | baseline | 규칙 후 | 막은 규칙·카운터 |
|---|---|---|---|---|
| 이웃 박스 L2 | 같은 브리지 박스 10.231.0.2:18080 | OPEN | **BLOCKED** | `bridge momo_s1_l2` forward, l2_drop 12패킷 |
| RFC1918 10/8 | 10.99.99.1 | OPEN | **BLOCKED** | private_drop |
| RFC1918 172.16/12 | 172.30.99.1 | OPEN | **BLOCKED** | private_drop |
| RFC1918 192.168/16 | 192.168.99.1 | OPEN | **BLOCKED** | private_drop (private_drop 합계 15패킷) |
| CGNAT 100.64/10 | 100.64.99.1 | OPEN | **BLOCKED** | private_drop |
| 메타데이터 | 169.254.169.254 | OPEN | **BLOCKED** | private_drop |
| 런너 호스트 자신(게이트웨이) | 10.231.0.1 | OPEN | **BLOCKED** | box_to_host_drop 15패킷 |
| IPv6 | fd00:dead::1 | OPEN | **BLOCKED** | v6_drop 3패킷 |
| SMTP 25/465/587 | 198.51.100.7 | OPEN×3 | **BLOCKED×3** | smtp_drop 9패킷 |
| 대조군: 「공용」 18080 | 198.51.100.7:18080 | OPEN | OPEN | (규칙 없음) |
| 대조군: 인터넷 | 1.1.1.1:443 | OPEN | OPEN | (규칙 없음) |

- 차단 근거는 시간 초과가 아니라 **드롭 규칙의 이름 있는 카운터가 올랐다**는 사실이다(L2 포함). baseline이 전부 OPEN이므로 시간 초과 오판이 아니다.
- IPv6는 박스 네트워크에 `--ipv6`를 켜고 ULA 대상을 forward 경로에 세워 시험했다. 정책은 「박스 발 IPv6 전부 거부」다. 실제 공용 IPv6 라우트는 VM에 없어 공용 v6 egress 허용 여부는 시험하지 못했다([?]; 현 규칙은 v6를 전부 막는다).
- 이웃 박스는 `iifname == oifname`이 아니라 `meta ibrname`으로 포트 간 프레임을 버린다. br_netfilter가 꺼진 VM이라 inet forward 훅이 L2를 못 본다는 점이 이 방식의 이유다. 브리지 자신으로 가는 프레임은 forward 훅이 아니라 input 경로라 영향이 없다.
- 규칙은 `iifname momos1br`로 범위를 좁혔다. 박스 브리지 밖(다른 프로젝트)의 규칙은 평가되지 않는다.
- **못 잰 것 [?]:** 연결률·PPS·대역폭 상한(T8), 채굴 풀 차단 목록, 사용자 네임스페이스 재매핑, gVisor. 이 스파이크의 nft 규칙에는 넣지 않았다. 호스트 `br_netfilter`를 켜는 배포에서는 같은 규칙이 forward 훅에서도 이웃을 막는지 다시 재야 한다.
- 이 시험은 Docker 브리지 사이의 baseline 도달을 위해 `DOCKER-USER`에 한시 ACCEPT를 넣었다가 종료 시 제거한다(주석 `momo-s1`로 식별). 배포 규칙이 아니라 시험 장치다.
- 재현: `infra/personal-box/s1/run-runner-suite.sh <결과_디렉터리>` (Colima에서 약 1분, 종료 시 자원 전부 정리).

## ② Railway 별도 프로젝트 실측

방법: `railway` CLI 4.27.4(소유자 로그인)와 GraphQL(`backboard.railway.com/graphql/v2`). 모든 호출은 `rw.sh`(연결 프로젝트 이름이 스파이크가 아니면 중단)를 거쳤다. 계정 플랜: **Pro**.

| 질문 | 결과 | 태그 |
|---|---|---|
| 팀 인스턴스의 `postgres.railway.internal`에 닿는가 | **NXDOMAIN**(`api`·`redis`도 동일). 별도 프로젝트의 사설망은 팀 프로젝트와 분리 | [V] |
| 같은 프로젝트의 박스끼리 닿는가 | **닿는다.** `boxa.railway.internal:18080` ↔ `boxb`가 서로 OPEN(IPv6 사설 주소로 DNS 해석). 서비스별 사설망 격리 옵션이 없다 | [V] |
| 서로 다른 프로젝트의 박스끼리 | **안 닿는다.** `-b` 프로젝트 서비스에서 `boxa/boxb.railway.internal`은 NXDOMAIN이고 boxb의 사설 IPv6(fd12:…)로 직접 접속도 BLOCKED. 같은 시점 공용 443은 OPEN(대조군) | [V] |
| 서비스당 볼륨 | **1개.** 2번째 볼륨 추가는 「A volume is already mounted on service」로 거부 | [V] |
| 프로젝트당 볼륨·서비스 | Pro: 볼륨 **20**, 서비스 **100**, 워크스페이스당 프로젝트 **100** | [V] `subscriptionPlanLimit` · [S: docs.railway.com/reference/volumes] |
| 볼륨 크기 | 기본 **50GB**로 생성되고 `VolumeInstanceUpdateInput`에 크기 필드가 없다(`mountPath`·`serviceId`·`state`뿐). **박스당 10GB 한도를 Railway가 강제하지 못한다.** 상한 1TB | [V] |
| 생성 속도 한도 | 프로젝트·환경·볼륨 생성 각 **30초에 1개** | [V] |
| 컨테이너 자원 상한 | Pro 32 vCPU·32GB 서비스당(`containers`), pidLimit 1000 | [V] |
| 서비스 egress 제어 | **없다.** 스키마에 egress 방화벽·허용목록이 없고(`egressGateway*`는 고정 출구 IP), `ipv6EgressEnabled` 스위치뿐. 실측: `smtp.gmail.com`의 **25/465/587이 모두 OPEN**, 공용 443 OPEN. 메타데이터·CGNAT 프로브는 BLOCKED였으나 대상이 없어 원인 구분 불가 | [V] 열림 · [?] 사설 차단 |
| 볼륨 백업 기본값 | **자동 일정이 없다**(새 볼륨의 `volumeInstanceBackupScheduleList`가 빈 배열). ADR 가정(「Railway 볼륨은 백업이 붙는다」)과 다르다 | [V] |
| 볼륨별 백업을 끌 수 있는가 | **끌 수 있다.** `volumeInstanceBackupScheduleUpdate(kinds:[DAILY])`로 일정이 생기고(cron `1 22 * * *`, 보존 6일) `kinds:[]`로 다시 빈 배열이 된다. 단 **수동 백업도 API로 만들어진다**(`volumeInstanceBackupCreate`) | [V] · [S: docs.railway.com/reference/backups] |

### 프로젝트 토큰 권한 범위 [V]
`projectTokenCreate`의 입력은 `projectId`·`environmentId`·`name`뿐이다. **권한 범위를 고르는 필드가 없다** — 만들어진 토큰은 그 환경에 대한 전권이다. 토큰(`Project-Access-Token` 헤더)으로 실제 호출한 결과:

| 동작 | 결과 |
|---|---|
| `railway ssh`로 서비스 안 명령 실행(exec) | **된다. uid=0(root)**, 볼륨 `/data` 내용 읽기 포함 |
| 변수 읽기 | **된다**(서비스 변수 이름 11개 반환. 박스에 자격 변수가 있다면 그대로 노출) |
| 변수 쓰기(`variableUpsert`) | 된다(자동 재배포를 유발) |
| 시작 명령 변경(`serviceInstanceUpdate.startCommand`) | **된다** — 「시작 명령 고정」은 코드 관례일 뿐 강제가 아니라는 ADR의 우려가 그대로다 |
| 볼륨 백업 일정 변경·목록 | 된다 |
| 서비스 생성 | 된다 |
| 계정(`me`)·프로젝트 목록 | 거부(Not Authorized) |
| 새 프로젝트 토큰 발급(권한 상승) | 거부 |
| 백업 복원 호출(존재하지 않는 id) | 거부 — id 오류와 권한 거부를 구분하지 못했다 [?] |

토큰이 막지 못하는 것이 곧 D2가 금지한 「exec·cp·변수 읽기·명령 변경」이다. A의 런너 API에는 이 동사들이 없고 Docker 소켓은 런너 uid만 접근한다. B의 프로비저너는 같은 일을 **구조적으로** 못 막는다.

### ③ 비용 실측 (Pro, 스파이크 프로젝트, 측정 창 약 15분) [V]
단가 [S: docs.railway.com/pricing/plans]: RAM $10/GB·월, CPU $20/vCPU·월, 볼륨 $0.15/GB·월(**사용량만 과금**), egress $0.05/GB, Pro 구독 $20/월에 사용량 $20 포함.

| 박스 형태 | 측정(평균) | 월 환산 [추정] |
|---|---|---|
| 유휴 박스(리스너만, 서비스 1개 + 빈 볼륨) | CPU 0.0003 vCPU · 메모리 0.0007GB · 볼륨 사용 약 0.26–0.79GB | RAM+CPU ≈ $0.01 + 볼륨 ≈ $0.04–0.12 → **월 약 $0.05–0.15** |
| 상시 가동 프로브 박스(60초 주기 nc 루프) | CPU 0.0004 vCPU · 메모리 0.0009GB · 볼륨 0.79GB | **월 약 $0.13** |
| 부하 박스(CPU 바쁜 루프 + 메모리 최대 0.60GB, 10분) | CPU 평균 **0.97 vCPU**(최대 1.29) · 메모리 평균 0.33GB(최대 0.60) | CPU $19 + RAM $3.3–6 → **월 약 $23–25** (+볼륨) |
| ADR 가정: 1 vCPU/2GB 상시 | (실측 아님) 사용량 과금이라 점유량이 아니라 실제 사용량을 낸다 | 최대 $20+$20=**$40/월**(ADR 값과 일치) |

- 핵심: Railway는 **점유가 아니라 사용량**에 과금하므로 유휴 박스는 거의 0원이다. ADR 표의 「멤버당 월 약 $7」은 10GB 볼륨을 **다 쓴다고** 가정한 값이다(10GB×$0.15=$1.5, RAM 0.5GB 상시 $5). 다만 볼륨은 50GB로 만들어져 크기를 줄일 수 없으므로 상한은 사용자가 쓰는 만큼이다(제한 수단 없음).
- 백업을 켜면 증분 용량만 과금된다 [S: reference/backups]. 이번엔 수동 백업 1개(빈 볼륨, `usedMB` 0)를 만들었다 지웠다.
- **앱 슬리핑(유휴 비용 0):** 문서상 5–10분 outbound 패킷이 없으면 잠든다 [S: docs.railway.com/reference/app-sleeping]. 볼륨 있는 서비스에서 잠드는지는 아래에 기록한다.

- **앱 슬리핑 결과 [V]:** 볼륨이 붙은 서비스(`boxc`, 리스너만 있고 outbound 없음)가 배포 후 약 10분 만에 `SLEEPING`이 됐고, 같은 프로젝트 다른 박스에서 사설망으로 접속하자 첫 시도에 깨어났다(`SUCCESS`, 접속 OK). outbound를 계속 내는 서비스(60초 프로브 루프 박스)는 잠들지 않는다. 즉 Railway에서 「유휴 정지」는 플랫폼이 해 주지만, **같은 프로젝트의 다른 박스나 스캔이 사설망으로 두드리면 깨어난다**(박스 간 도달 가능성과 같은 뿌리의 문제).
- **누적 사용량(프로젝트 전체, 약 25분, 서비스 4개·볼륨 3개·부하 박스 10분 포함):** CPU 9.73 vCPU·분, 메모리 2.74 GB·분, 디스크 71 GB·분, egress 0.00004GB, 백업 0.006GB. 단가를 곱하면 합계는 1센트 미만이며 Pro 구독의 포함 크레딧($20) 안이다. 청구서 금액 자체는 확인하지 못했다([?], 사용량 단위를 분 단위로 가정한 환산).

## B(Railway 어댑터) 판정과 근거

| ADR이 요구한 조건 | 실측 | 충족 |
|---|---|---|
| (a) 팀 인스턴스와 다른 프로젝트 | NXDOMAIN | O |
| (b) 박스 간 미도달 | 같은 프로젝트는 **닿음**, 박스당 별도 프로젝트면 안 닿음 | 조건부(프로젝트 100개 상한·생성 30초 1개·프로젝트마다 토큰) |
| (c) 볼륨 백업 끄기 | 기본 없음, 일정 비우기로 끔. 단 토큰 보유자가 켜거나 수동 생성 가능 | O(운영 규칙 필요) |
| (d) 토큰 범위 축소 | **불가**(스코프 필드 없음). root exec·변수 읽기·시작 명령 변경 전부 가능 | **X** |
| (e) 볼륨·프로젝트 한도 | 볼륨 20/프로젝트, 박스당 볼륨 1 고정, 크기 10GB 지정 불가 | 부분 |
| T8 egress(SMTP 등) | 제어 수단 없음, 25/465/587 열림 | **X** |

(d)와 T8이 닫는다. 프로비저너를 api와 분리해도 토큰이 root exec을 가지므로 프로비저너 침해 = 전 박스의 호스트 침해다(A에서는 런너 침해도 같은 위험이지만 런너 API에 exec·cp 동사가 없고 선언 규칙으로 egress를 쥔다). 박스당 프로젝트 방식은 토큰을 박스 수만큼 보관해야 하고 워크스페이스당 프로젝트 100개로 박스 수가 제한된다. 따라서 **B는 닫고 A를 MVP로 유지**한다. 결재 기록의 「통과하지 못하면 런너 호스트로 내려간다」가 발동한다.

## ADR-0197 증보 초안 (제안 — 채택은 소유자 결재)

ADR 본문에는 아래 텍스트를 「증보 초안 (제안)」 절로만 붙였다. 본문 결정·결재 기록은 바꾸지 않았다.

### 증보 1 (제안) — S1 실측 반영: B 닫기, 비용·백업 가정 수정
상태: **제안(Proposed)**. 채택은 소유자 결재이며 본 절은 위 결정·결재 기록을 바꾸지 않는다. 근거: `docs/research/S1-personal-box-placement-spike.md`(#3408).

1. **배치 B(Railway 어댑터)를 닫는다.** 이유: ① 프로젝트 토큰은 범위를 좁힐 수 없고(`projectTokenCreate` 입력에 스코프 없음) 토큰 하나로 root exec·변수 읽기/쓰기·시작 명령 변경·백업 변경이 된다 [V]. ② 서비스 egress 제어가 없고 SMTP 25/465/587이 열려 있다 [V]. ③ 같은 프로젝트의 박스끼리 닿는다 [V]; 박스당 별도 프로젝트는 격리되지만 프로젝트 100개 상한·생성 30초당 1개·박스 수만큼의 root급 토큰 보관이 따른다. ④ 볼륨 크기를 10GB로 정할 수 없다(기본 50GB) [V]. 결재 기록의 「통과하지 못하면 런너 호스트로 내려간다」를 발동해 **MVP는 A(런너 호스트)** 로 확정한다. D2의 마지막 문단(Railway 어댑터 도입 조건)과 T10은 「B는 닫힘, 재개하려면 새 ADR」로 읽는다.
2. **비용 가정 수정.** Railway는 사용량 과금이므로 유휴 박스는 월 $0.1 안팎이다 [V]. 배치 비교표의 「멤버당 월 약 $7」은 10GB를 모두 쓰는 상한에 가깝고, 상시 1 vCPU/2GB 상한은 월 약 $40 [추정]이다. 런너 호스트(A)의 VM 비용과의 비교는 M2 전에 다시 계산한다.
3. **백업 전제 수정.** Railway 볼륨에는 기본 백업 일정이 없다 [V]. 다만 토큰 보유자가 일정이나 수동 백업을 만들 수 있다 [V]. 따라서 결재 기록의 「Railway 볼륨은 백업이 붙으므로 자격을 tmpfs에만」은 B를 닫았으므로 유효하지 않다. A에서 영속 게이트(D8)는 런너 증명(S4)을 따른다.
4. **런너 호스트 egress 선언을 D9의 기준 규칙으로 삼는다.** `infra/personal-box/s1/runner-egress.nft`가 사설 대역·CGNAT·메타데이터·IPv6·이웃 박스(L2)·SMTP·호스트 자신을 차단함을 전후 비교와 카운터로 확인했다 [V]. 연결률·PPS·대역폭 상한과 br_netfilter 호스트는 M2 배포 게이트에서 다시 잰다 [?].
5. **후속:** Railway Sandboxes(`networkIsolation: ISOLATED`)는 별도 평가 대상이다 [?]. exec·체크포인트 API가 D2·D7과 충돌하므로 런너 인터페이스 뒤 후보로는 올리지 않는다.

## 남은 일 / 후속

1. **Railway Sandboxes 평가(별도 이슈 제안):** `sandboxCreate`에 `networkIsolation: ISOLATED`(기본, 「peer-isolated, public NAT egress only」)와 `sandboxExec`·체크포인트가 있다(스키마 확인 [V], 실행 [?]). 가격은 VM 단가 RAM $50/GB·CPU $50/vCPU [S]로 컨테이너의 5배다. 박스 간 격리가 서비스형보다 낫지만 exec·체크포인트 API가 D2 「exec 동사 없음」·D7 「체크포인트 공유 금지」와 충돌하므로 런너 인터페이스 뒤에 두기 어렵다. 판정은 이 스파이크 범위 밖.
2. 런너 호스트 규칙의 연결률·PPS·채굴 풀 차단과 `br_netfilter` 켠 호스트 재측정(T8 마무리, M2 배포 게이트).
3. 공용 IPv6 egress 정책 결정(현 규칙: 박스 발 v6 전부 거부).

## 정리 상태
- Railway: 스파이크 프로젝트 `oort-personal-box-spike-s1`과 교차 시험용 `oort-personal-box-spike-s1-b`를 시험 직후 **삭제**했다. `railway list`에는 기존 3개(팀 인스턴스 포함)만 남아 있다. 프로젝트 토큰은 프로젝트와 함께 사라졌고 로컬 임시 파일도 지웠다. 남은 Railway 자원·과금: 없음(삭제 후 사용량 조회는 하지 않음).
- 프로젝트 토큰으로 `projectDelete`는 거부됐다(Not Authorized) [V]: 토큰은 프로젝트 안에서는 전권이지만 프로젝트 삭제는 못 한다.
- 로컬: `momo-s1-` 접두 컨테이너·네트워크·이미지와 nft 테이블 `momo_s1`·`momo_s1_l2`, `DOCKER-USER`의 시험용 ACCEPT, 호스트 라우트를 전부 제거했다(스크립트 trap, 재확인). 같은 Colima VM의 다른 프로젝트 자원은 건드리지 않았다. 참고: Docker가 IPv6 네트워크를 만들면서 `ip6 raw` 테이블이 새로 생겼고 남아 있다(Docker 자체 테이블).

## 계획과 다르게 한 일
- 승인은 별도 프로젝트 1개였으나, 프로젝트 간 격리의 유일한 실측 수단이라 교차 시험용 `oort-personal-box-spike-s1-b`를 하나 더 만들었다가 바로 삭제했다.
- `rw.sh`에 `RW_WANT` 환경변수 예외를 넣었다(-b 프로젝트 허용용). 안전 래퍼의 우회구이므로 이 스크립트는 시험 도구일 뿐 배포 코드가 아니다.
- 프로젝트 토큰 시험은 스파이크 프로젝트 안에서 변수 1개(`S1_TOKEN_TEST`)와 서비스 1개를 만들었다 지웠다(프로젝트와 함께 삭제됨).
