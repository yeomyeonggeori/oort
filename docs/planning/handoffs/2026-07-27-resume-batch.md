# 재개 세팅 — 2026-07-27 (Fable, 성재 "작업 잠시 중지" 지점)

> 이 문서 하나만 읽으면 재개할 수 있게 쓴다. 상위 계획 정본은
> `docs/planning/2026-07-27-general-user-readiness-plan.md`, 직전 배치는
> `2026-07-26-next-batch-handoff.md`.

> **워커 모델(2026-07-27 성재 지시)**: 다음 라운드부터 **`--model gpt-5.6-sol --effort medium`**.
> 그 이전 배치(#840·#841·#842·#839 1R~3R)는 `gpt-5.6-terra --effort xhigh`였다.

## 0. 성재에게 이렇게 시키시면 됩니다

| 하고 싶은 것 | 지시 문장 |
|---|---|
| 멈춘 지점 그대로 재개 | **"재개 문서 읽고 이어서 해줘"** |
| #839만 마저 | **"839 수정 라운드 진행해줘"** |
| #842만 검증 | **"847 검증해줘"** |
| track→main 반영 | **"track/engine, track/uxui main에 반영해줘"** (승인 필요분) |

---

## 1. 지금 상태 한 줄

배치 5장 중 **#840·#838·#841 랜딩 완료**, **#839는 design-review FAIL로 수정 라운드 대기**,
**#842는 PR #847까지 왔고 오케스트레이터 검증만 남았다.** main 반영은 전부 성재 승인 대기.

## 2. 재개 시 바로 할 일 (순서대로)

### (1) #839 — 수정 라운드 워커 spawn ⟵ **여기서 멈췄다**

패킷이 이미 쓰여 있다: **`docs/planning/handoffs/2026-07-27-839-2r-fix-packet.md`**.
워크트리 `~/projects/momo-tracks/momo-worktrees/839-momo-637-scope`(브랜치
`feat/839-momo-637-scope`, HEAD `5a717e0f`, base `track/uxui`), PR **#846**(드래프트).

```
cd ~/projects/momo-tracks/momo-worktrees/839-momo-637-scope && \
~/.claude/skills/codex-fleet/scripts/codex_spawn.sh --workdir "$PWD" \
  --prompt-file ~/projects/momo/docs/planning/handoffs/2026-07-27-839-2r-fix-packet.md \
  --name goal-839-fix1 --model gpt-5.6-terra --effort xhigh \
  --add-dir ~/projects/momo/.git
```

**기존 브랜치에 커밋·푸시만**(PR 새로 만들지 않는다). 끝나면 오케스트레이터가
`gate:wire`·`gate:shell`·**신규 게이트 레드 증명**을 돌리고, **design-review를 fresh context로 재실행**한다.

### (2) #842 — PR #847 검증 (워커 완료, 검증 미착수)

워크트리 `~/projects/momo-tracks/momo-worktrees/842-momo-640-csp`, 커밋 `1968b55c`,
5파일(+296): `tauri.conf.json` CSP · `gates/gate-csp.mjs`(신규 281줄) · `vite.config.ts` · `package.json` · `STATUS.md`.

워커가 못 돌린 것 = **내가 돌려야 하는 것**:
```
cd ~/projects/momo-tracks/momo-worktrees/842-momo-640-csp/clients/web
npm ci && npm run build && npm run gate:csp && npm run gate:wire && npm run gate:shell
# 실빌드(웹뷰·Tauri IPC는 Chromium 게이트가 못 잡는 부분):
cd ../desktop/src-tauri && cargo tauri build --bundles app --ci
```
**레드 증명**: PR #847 본문에 워커가 적어둔 절차대로 CSP를 좁혀(예: `style-src 'self'`)
`gate:csp`가 빨개지는지 확인. 게이트가 CSP 문자열을 **`tauri.conf.json`에서 읽는지**도 확인
(복사해 넣었으면 설정과 게이트가 따로 표류한다).

**내가 리뷰에서 직접 볼 것** — 채택된 CSP는:
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
font-src 'self'; connect-src 'self' http: https: ws: wss:; object-src 'none'; base-uri 'self';
form-action 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'
```
- `style-src 'unsafe-inline'`은 **정당하다** — xterm.js가 truecolor 셀마다 style 속성을 쓴다
  (`terminalRuntime.ts:19-25` 실측 주석).
- `connect-src`가 넓은 것도 **불가피하다** — 서버 주소가 런타임 입력이고(`serverBase.ts`),
  관전 터미널이 제3의 호스트를 문다(`observerStream.ts:170-193`, 프로덕션 CSP가 이걸 막아
  무한 대기시킨 실측 기록이 있다).
- **미확인 2건**: ① `frame-ancestors`가 없다(프로덕션 Caddyfile에는 있다) — 웹뷰에서 필요한지 판단할 것
  ② Tauri 2가 IPC를 위해 CSP를 어떻게 손대는지 워커 조사 결과를 **실빌드로 확인**할 것.
- **A(브라우저 localStorage)는 구현이 아니라 권고**다. PR 본문의 세 후보 비교를 읽고,
  결론이 `session.ts` 주석·`docs/security/README.ko.md`와 **어긋나지 않는지** 대조할 것.
  서버 변경이 필요한 결론이면 **별도 ADR 사안**이지 이 PR에서 착수하지 않는다.

### (3) 그다음

배치 5장이 끝나면 **성재 승인을 받아 track→main 동기화** → 라이브 통합 → next 발행.
그 뒤 남는 것은 §5의 성재 몫과 미티켓 후속.

---

## 3. 이번 배치 랜딩 완료분 (재검증 불필요)

| 이슈 | 내용 | 랜딩 |
|---|---|---|
| #840 MOMO-638 | 첨부 unique 인덱스 테넌트 분리(마이그레이션 044) | track/engine |
| #838 MOMO-636 | 웹 플러그인 마켓플레이스 복원(구 SwiftUI 734줄 미포팅분) | track/uxui, design-review 4R PASS |
| #841 MOMO-639 | 한국어 보안 판단 자료 + 신뢰 경계 다이어그램 | track/engine (`01026aa1`, PR #845) |

**세 트랙 브랜치 모두 main보다 앞서 있고 성재 승인 대기다.**

## 4. #839 design-review 판정 요지 (2026-07-27, 실렌더)

`Verdict: FAIL (blockers: 1, high: 4)`. **오케스트레이터가 5건 전부 코드에서 재확인했다.**

- **[Blocker] 다이얼로그 본문에 스크롤 상자가 없다** — `dialog.tsx` 주석이 "caller가 넣어라"라고
  계약을 적어뒀고 다른 두 다이얼로그는 넣었는데 이 caller만 빠졌다. **출하 시드 GitHub 1-scope가
  900x600에서 승인 버튼이 화면 밖**이고, 키보드 Tab이 **보이지 않는 승인 버튼에 도달해 Enter가 먹는다.**
  뷰포트 밖 컨트롤은 #838에서도 나온 **두 번째**라 게이트로 잠근다.
- **[High] 서로 다른 scope가 같은 라벨** — `scopeSentence`가 `:read`/`:write` 외 전부
  `${name} 사용 권한`이라 `notion:comment`와 `notion:admin`이 동일 문장. 실패 영수증도 구분 불가.
- **[High] 실패 원인 소실** — `outcome.error` 참조처 0건, `pluginActionErrorMessage`가 죽은 코드가 됐다.
  게다가 전량 실패에도 다이얼로그가 닫혀 선택이 날아간다.
- **[High] 전량 성공 후 포커스가 body로** — opener로 되돌렸는데 재조회가 그 버튼을 언마운트한다.
- **[High] 위험도가 앱 단위 한 줄뿐** — 어느 체크박스가 "위험도 관리자"인지 화면에 없다.
  **다이얼로그 뒤 상세 패널이 오히려 scope별로 더 자세하다.**

**통과분(회귀시키지 말 것)**: 동의 없는 grant 경로 없음(타입+grep 이중 확인) · 선택 필드 빈 렌더 없음 ·
#838 교훈 4건(조건부 마운트·opener·Escape·aria-busy) 실렌더 확인 · pending 상태 전반.

**성재 판단이 필요한 제품 결정 1건**: grant 다이얼로그가 **전체 선택 상태로 열린다.** 주 버튼 한 번이면
관리자 권한 포함 전량 승인이라 "동의 화면 이전과 결과가 같다"는 지적이 있다. 반대로 사람이 누른 건
"권한 추가"라 전체 선택이 자연스럽다는 반론도 성립한다. **이번 라운드에서는 기본값을 바꾸지 않고**
선택 개수 표시 + scope별 위험도 노출로 "무엇이 미리 체크됐는지" 읽히게만 한다.

## 5. 성재 몫 (에이전트가 대신할 수 없음)

- **`legal/privacy-policy.md`가 빈칸 템플릿이다** — 제3자 제공·보유기간·책임자 미기재.
  **공개 런치를 막는 항목**이고 법률 검토가 필요하다. #841 보안 문서는 의도적으로 이걸 링크하지 않았다.
- **#837 MOMO-635 RN 스파이크** — 실기기 5~7일. 1건이라도 FAIL이면 구현 착수 금지.
- **ADR 결정 2건**: ADR-0138 신규(일반 유저 온보딩 / momo Cloud — ADR-0121 D6-A·D5-A가 막고 있다) ·
  ADR-0113 증보(3자 OAuth 커넥터).
- **track→main 머지 승인 3건**(§3).

## 6. 미티켓 후속 (잊지 않기 위한 목록)

- `verify_openapi_contract.sh`의 `work-session-remote-create` 409 — **PR 무관 선존재**(base에서 재현 확인).
- openapi allowlist 41건 축소.
- #838 후속: 파괴 버튼 톤 · 다중 scope 안내 위치 · 상세 패널 설명 부재.
- #838 H-2 `opener` 수정의 **WebKit 실측 미완**(단위 테스트 3건으로만 잠금).
- 매니페스트 `tools[].description`이 영문이라 동의 화면에 영어가 그대로 뜬다(시드 4종).

## 7. 파이프라인 교훈 (이번 배치에서 새로 확인)

- **게이트가 지름길로 픽스처를 심으면 그 지름길이 우회한 경계는 영원히 검증되지 않는다** — 5회째.
- **워커는 docker·Playwright·Swift 빌드·`cargo tauri`를 못 돌린다.** 검증 불가 지점에 결함이 몰린다.
  → 패킷에 "심볼은 쓰기 전에 grep으로 실재 확인" 규칙을 넣었고 효과가 있었다.
- **레포가 주석으로 적어둔 실패를 새 표면이 다시 밟는다** — #839 Blocker가 정확히 그 형태다
  (`dialog.tsx`가 계약을 적어뒀는데 caller가 안 지켰다). 패킷에 기존 사용처를 먼저 읽으라고
  넣어도 **계약 주석이 호출부가 아니라 컴포넌트 쪽에 있으면 놓친다.**
- **게이트 결과를 자를 수 있는 형태(`| tail`)로 보지 말 것.**
