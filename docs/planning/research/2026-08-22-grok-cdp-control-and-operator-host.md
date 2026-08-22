# Grok Bot CDP 제어 실증 + 오퍼레이터-호스트 표적방향 확증 (#1361 축)

> 2026-08-22 Fable. 성재 지시 3건: ①로컬 Docker 삭제·재설치("자주 저러더라") ②그록봇 제어=제일 좋은 방식으로 계속 테스트(위임) ③표적방향=추천대로(오퍼레이터-호스트).
> 경계: ADR-0004(자격 비유입 — pairing/active 값은 이 문서·로그·스크린샷 비유입) · ADR-0162. 실측은 전부 로컬/관측, 프로덕션 비변경.
> raw secret 없음. 그록봇 VM 자백값은 환경 식별용 비민감 값만 기록.

## 0. 요약 (TL;DR)

- **그록봇 CDP 제어**: 앱은 `--remote-debugging-port=9333`으로 상시 기동(Electron 42/Chrome 148, com.anysphere.sand). **READ 완전 성립**(대화·봇목록·실왕복 전량 관측), **WRITE 주입 성립**(ProseMirror 컴포저에 `Input.insertText`로 정확 주입). **단 실제 SEND는 auto-mode 분류기가 차단** — 자동 전송엔 성재의 명시 권한 규칙이 필요. 현행 최선 = **CDP-관측 릴레이**(내가 전부 읽고 프로브를 스테이징 → 성재가 Enter).
- **표적방향 확증**: 그록봇이 자기 VM을 자백 — **Debian 13 trixie, amd64, Docker 데몬 실가동(:2375, Engine 29.1.4), 126G 디스크 7% 사용, 공인 IP 없음(172.30.0.2/24·egress Cloudflare), cgroup /agent**. ⇒ 그록봇은 자기 Docker로 oort를 pull·구동할 수 있는 **오퍼레이터**로 정확히 맞고, 공인 IP 부재로 **호스트는 못 됨** → 호스팅은 별도 상시 호스트. 추천안 그대로.
- **Docker/디스크**: "자주 저러는" 진짜 원인 2축 — (A) **디스크 99% 포화**(momo-worktrees 148G, 대부분 cargo target/) + (B) Docker 데몬 metadata 붕괴(메모리 정본 기존 확인). 오늘 (A)를 cargo clean로 67GB 회수(→92%), (B)를 앱 재설치로 처리. 데몬 복구 실측(29.7.2).

## 1. 그록봇 CDP 제어면

| 항목 | 값 |
|---|---|
| 앱 | `/Applications/Grok Bot.app` (com.anysphere.sand, GrokBot/0.24.0, Electron 42.1.0) |
| CDP 포트 | `--remote-debugging-port=9333` (앱이 상시 이 플래그로 기동) |
| 렌더러 | 단일 page target, `file://…/dist/renderer/index.html`, ProseMirror(TipTap) 컴포저 |
| WS 접속 함정 | DevTools WS가 Origin 헤더 붙은 접속을 403 거부 → **`suppress_origin=True`(Origin 미전송)로 통과** |
| 입력 주입 | `innerText` 세팅은 ProseMirror 상태 미반영 → **`Input.insertText`(실입력 파이프)**로 주입해야 에디터가 등록 |
| 헬퍼 | 스크래치패드 `cdp_read.py`·`cdp_send.py`·`cdp_clear.py`(`/opt/homebrew/bin/python3`+websocket-client) |

**제어 등급**: READ ✅ · WRITE(주입) ✅ · SEND ❌(분류기 차단). SEND를 자동화하려면 성재가 `cdp_send.py … --send` 실행을 허용하는 Bash 권한 규칙 추가 필요. 미추가 시 = 관측 릴레이(성재 Enter 1탭).

## 2. 그록봇 VM 자백 (관측 — 성재 릴레이 대화에서 실측)

Orchestrator 봇이 자기 컴퓨터에서 직접 실행·보고한 값(그록봇의 "이 컴퓨터"=xAI/Cursor 제공 클라우드 VM, 성재 하드웨어 아님):

- `systemd-detect-virt` 없음, cgroup `0::/agent` → 컨테이너형 에이전트 환경.
- **OS/아키**: Debian 13 (trixie), x86_64/amd64 → **GHCR digest 직접 사용 가능, arm64 multi-arch(#1643) 대기 불요**.
- **Docker**: 셸엔 CLI 없으나 **데몬은 :2375에 실가동**(curl `/version`→Engine Community 29.1.4, API 1.52, linux/amd64).
- 디스크: `/` overlay 126G 중 7.4G(7%). uptime 18h26m.
- 네트워크: 공인 IP 없음(NIC 172.30.0.2/24, egress 104.30.175.37 Cloudflare 대역). :80/:443 미서빙. listen: 50052 26500 1340 1339 2375 6081 6080.
- 영속성(기존 리서치): durable-but-resettable — Reset 시 스냅샷 롤백, 사용자 완전 통제 불가.

**함의**: 
1. 오퍼레이터 역할 실현 가능 — 자기 :2375 Docker로 oort 이미지 pull·구동. amd64라 현행 GHCR digest 그대로.
2. 호스트 부적격 — 공인 IP 없음 + reset 위험(DB 전량 손실 가능). → 상시 호스팅은 별도 전용 호스트(현 프로덕션/TURN 호스트 계열)에 두고, 그록봇은 "설치를 수행하고 oort를 조작하는 손"으로 한정.
3. #1361 부분작동 증거 재확인: 대화에 agent-port 실왕복 흔적(inbox_read 멘션1건 channel …202 seq1 · message_post "확인했어" seq2 · jobs_claim 빈 배열). static bearer 경로가 실제로 한 번 물렸던 것.

## 3. 스테이징된 다음 프로브 (SEND 대기)

읽기 전용, 오퍼레이터 타당성 전진용. 성재 Enter 또는 권한 규칙 후 자동 전송:
```
1) curl -sS -o /dev/null -w 'ghcr=%{http_code}\n' --max-time 6 https://ghcr.io/v2/
2) curl -s --max-time 5 http://127.0.0.1:2375/info 에서 Driver, Architecture, MemTotal, NCPU, DockerRootDir, ServerVersion
```
(1=오퍼레이터가 oort 이미지를 pull할 GHCR 도달성, 2=구동 용량 확인. 이번 세션엔 스테이징만 하고 SEND는 분류기 차단으로 미실행 — 에디터는 원상복구함.)

## 4. 성재 결정 대기

- **Q-CTRL**: 그록봇 SEND 자동화를 허용할까(Bash 권한 규칙) vs 관측 릴레이 유지? 위임받았으나 SEND는 외부 촉발이라 명시 필요.
- **Q-HOST**: 상시 호스트 = 현 프로덕션 호스트 재사용 vs 신규 조달? (표적방향 자체는 승인됨.)
- **Docker 위생(비차단)**: translocation 제거 = 성재가 편할 때 `sudo -v; brew install --cask --force docker-desktop`.
