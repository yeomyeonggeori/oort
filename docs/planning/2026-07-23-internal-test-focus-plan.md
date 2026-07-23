# 내부 테스트 집중 전환 계획 (2026-07-23, 성재 지시 — momo-main 기안)

> 지시: "공개에 집중하지 말고 내부 테스트에 집중. 안정성/목표치 통과 시 자연스럽게 배포. 잔버그·연동 이슈·UXUI 개선점이 많다. github.io 정적 페이지로 빌드 다운로드+사용, 받은 상태에서의 연동 계획 구체화."
> 공개 릴리스는 **게이트 충족 상태로 동결**(2026-07-23-rehearsal-phase1-report.md — 언제든 실행 가능). 이 문서가 내부 테스트 트랙의 정본이다.

## §1. 배포 채널 — github.io 내부 빌드 유통

**설계**: 별도 공개 저장소 1개(`momo-alpha` 제안)에 ①정적 다운로드 페이지(GitHub Pages) ②`update-manifest-alpha.json` ③빌드 zip(Releases 자산)을 올린다. **본 레포는 비공개 유지** — 소스가 아니라 바이너리만 유통.

- **기존 자산 재사용**: 앱에 이미 Updates 채널 v0(MOMO-244)이 있다 — `MOMO_UPDATE_MANIFEST_URL`이 Pages의 manifest를 가리키도록 배포 빌드에 기본값을 굽는다 → 테스터는 인앱 `Updates`에서 새 버전 알림+다운로드 링크를 받는다(수동 재설치, v0 의미론 유지).
- **빌드 파이프라인**(오케스트레이터 스크립트 `scripts/publish_alpha_build.sh` 신설): 버전 스탬프 → macOS 앱 빌드(현행 unsigned Xcode 경로) → zip+SHA-256 → `gh release create`(momo-alpha) → manifest 갱신 → Pages 자동 반영. 페이지에는 버전·체크섬·설치 안내(**Gatekeeper: 우클릭>열기 또는 `xattr -d com.apple.quarantine`**)·피드백 경로를 담는다.
- **서명/공증 후속**: Developer ID 서명+공증이 되면 Gatekeeper 안내가 사라진다 — Apple Developer 계정 보유 여부 성재 확인 후 후속 티켓.
- ⚠️ **캐비앗(성재 go 1건)**: GitHub Pages URL은 레포가 비공개여도 **항상 공개 URL**이다. 즉 바이너리는 사실상 공개 유통이 된다(소스는 여전히 비공개). 수용 시 이미지와 동일 규율로 zip에 LICENSE/NOTICE 동봉. 대안: 테스터에게 `gh release download`(비공개 레포 자산, gh 인증 필요) — 페이지 UX는 포기.

## §2. 연동 온보딩 — "받은 다음 무엇을 하는가"

테스터 여정: **다운로드 → 서버 연결 → 가입 → 에이전트 연동 → Work 연동**.

1. **서버 접근** (내부 테스트 스택 = momowebqa, 성재 맥):
   - **A(권고) Tailscale**: 성재 맥과 테스터 기기를 테일넷으로 묶고 `tailscale serve`로 api(28000)/centrifugo(28001)를 테일넷 HTTPS로 노출. 도메인/VPS/공인 포트 불요, 팀 외 접근 불가. 앱의 서버 URL에 `https://<mac>.tailnet.ts.net` 입력.
   - B 각자 셀프호스트: 리허설 검증된 install.sh 경로(단일 이미지). Apple Silicon+Docker 요구 — 엔지니어 테스터용.
   - C 같은 LAN 직결: 임시·데모용.
2. **가입**: `momo-ops.sh invite-create`(560)로 초대 코드 발급 → 테스터 가입. 초대→가입→첫 대화 여정 자체가 ADR-0112 D4 실측 항목.
3. **에이전트 연동 3경로**(README와 동일 계약): ①native 생성(ADR-0131 폼 — 537/553 UI 랜딩됨) ②hermes/Codex BYOA(실키는 provider 런타임에만 — ADR-0004) ③OpenAI-호환 로컬 백엔드(ollama 등, HERMES_BASE_URL).
4. **Work(Codex) 연동**: work host 등록(ADR-0114/0125 경로) — 내부 테스트의 핵심 검증 대상.
5. **푸시**: 내부 단계는 relay 미등록=무푸시로 운영(1급 지원 경로). 푸시 검증은 배포 단계로 이월.

## §3. 내부 테스트 목표치 (통과 = 자연스러운 배포 게이트) — 성재 합의 후 확정

| 축 | 목표치(제안) |
|---|---|
| 안정성 | 연속 7일 도그푸드에서 크래시 0·데이터 손상 0·재연결 복원 100%(앱 재시작/네트워크 단절 시나리오 포함) |
| 잔버그 | P0/P1 open 0, 피드백 이슈 주간 유입보다 소진이 빠른 상태 2주 유지 |
| 연동 | 실 hermes/Codex 왕복·초대→가입→첫 대화·에이전트 생성 3경로 각각 신규 테스터 1인이 문서만으로 완주 |
| UXUI | 성재 조목조목 피드백 라운드에서 Blocker/High 소진(라운드당 기록: INTERNAL_ALPHA_FEEDBACK 루프) |

## §4. 큐 재정렬 (내부 테스트 전면)

1. **배포 채널 구축**(§1 — 캐비앗 go 후 momo-main 직접): 페이지+스크립트+첫 빌드 업로드.
2. **UXUI 잔여 착수**: U″ 3종(A-21 작업신호·A-22 managed-by·A-23 Create agent 동급) + diff 카드 1급(#602 기존 이슈) — **fleet 대행 착수 승인 필요**(원 스코프는 "UXUI 세션 제안"이었음).
3. **활동 피드 분류학 ADR 기안**(buzz Top5-②, momo-main) — 잔버그 티켓들이 잘게 쪼개지는 골격.
4. **잔버그·연동 이슈 수집**: INTERNAL_ALPHA_FEEDBACK 루프 가동 — 성재/동생 피드백 → 인테이크 이슈 → goal화.
5. 공개 후 슬롯(동결 유지): 567 원장 로테이션·code graph·옵션 C·ADR-0117·페르소나 카탈로그.

## §5. buzz 레인 이행 원장 (성재 질문 답변 기록)

**완주**: 제안 액션 7건 중 ①RLS 공리(→554 실집행) ②라이선스 게이트(→556) ③branch-skew(→555) ④상호작용 안전 계약(→ADR-0132=557·558·559 서버+클라) ⑦재방문 예약(4~6주, mesh-llm 지표 포함). H3 제품화(560·561·562·563)+564·565·566까지.
**부분**: ⑥포지셔닝(→564 README 신뢰 경계 절 — 공개 서사 전면 배치는 공개 시점 항목).
**미착수(=본 계획 §4로 수렴)**: ⑤UXUI Top5 — ①③④는 A-21/22/23 등재만, ②활동 피드 분류학 미기안, ⑤diff 카드 #602 미랜딩. 페르소나 카탈로그(상위 추상)·오너 위임 캐스케이드·페이지 계약 등 로직 계층 후보 미티켓. buzz 계획 §2 결정대기(③drive_file_uniq 스코프 ④slug 정책 ⑤join policy 약관 ⑥admin 콘솔 ⑦Cloud 서사)는 결정 대기 유지.
