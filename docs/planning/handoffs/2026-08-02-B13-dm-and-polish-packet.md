# goal B13 — DM 무멘션 응답(QA H7) + 잔여 M/L 다듬기

너는 momo 레포의 구현 worker다(Claude Opus 5). 이 문서가 유일한 지시서.
**base = `track/engine`**(`47094c60`). 워크트리 `~/projects/momo-tracks/momo-worktrees/B13-dm-and-polish`(브랜치 `feat/B13-dm-and-polish`, 생성됨).

발단: 실사용 QA. **H7** — 에이전트와의 1:1 DM에서도 `@이름`을 붙여야만 답한다(1:1인데 누구한테 말하는지 물을 이유가 없다). 그리고 M/L 잔여 다듬기.

## 0. 규율
`.env` 금지 · **PR 후 STOP**(amend/force-push 금지) · **docker 검증 금지**(실DB 테스트는 `#[ignore]`) · route에 raw SQL 0 · **새 마이그레이션 금지** · Swift 실측=서버 계약 정답 · taste 스킬 준수(UI).

## 1. H7 — DM에서 멘션 없이 응답 (서버)

### 사실관계 (오케스트레이터 실측)
- 멘션→run 라우팅 = `server-rust/crates/momo-agent/src/mention.rs`(후보 적재 `load_mention_candidates_in_tx`, 라우팅 `resolve_mention_routing`, 잡 페이로드 등).
- `profile.triggers`는 **`{"mention": true}` 고정 + 선택적 `schedule`만 허용**하고 그 외 키를 거부한다(`provisioning.rs`의 `triggers_must_keep_mention_on_and_invent_nothing`). → **트리거 스키마를 늘리지 마라.** DM 자동응답은 새 트리거가 아니라 **라우팅 규칙**으로 구현한다("1:1 DM에서 상대에게 한 말은 그 상대를 부른 것과 같다").

### 규칙 (fail-closed로 좁게)
자동 트리거는 **다음이 전부 참일 때만**:
1. 채널이 **DM**이고(`channel.kind` 실측 확인), 대화 상대가 **정확히 1명의 에이전트**다.
2. 발화자가 **사람 member**다. → **에이전트↔에이전트 DM은 자동응답 금지**(양쪽이 서로를 영원히 부르는 루프가 된다). 이건 타협하지 말고 테스트로 못 박아라.
3. 시스템 메시지·에이전트 자신의 발화·삭제/수정 이벤트는 트리거가 아니다.

### 보존해야 하는 것 (하나라도 깨지면 실패)
- **pause** 상태 에이전트는 여전히 침묵(기존 paused 경로 그대로).
- **A2A 안전장치 전부 유효** — G1(동시 run)·G2(연속 자동발화)·G3(step 소비)·`a2a_depth` 캡·체인 과금 상한. DM 경로가 이 게이트를 우회하면 안 된다.
- **멱등** — 같은 메시지가 run/job을 두 번 만들지 않는다(기존 `client_msg_id`=run_id 규약과 정합).
- 단일 쓰기경로·RLS FORCE·에이전트=member 무분기.
- 명시 `@멘션`이 DM 안에 있어도 **중복 run이 생기면 안 된다**(멘션 경로와 DM 경로가 겹칠 때의 합성 규칙을 정하고 테스트로 고정).

### 사용자에게 보이는 것
DM을 열었을 때 "멘션 없이 바로 대화할 수 있다"가 자연스럽게 드러나야 한다(컴포저 힌트 한 줄 정도면 충분 — 과설명 금지).

## 2. 잔여 M/L 다듬기
아래는 QA 관찰이다. **각각 현재 상태를 먼저 재실측**하고(이미 고쳐졌으면 "해당 없음"으로 기록), 남아 있는 것만 고쳐라.
1. **로그인 폼 내부 ID 노출** — 입력 라벨/자동완성 힌트 등에 내부 식별자·개발용 문구가 노출된다. 사용자 언어로.
2. **`momo://` → `oort://`** — 딥링크/커스텀 스킴이 옛 브랜드다. 리브랜딩(momo→oort, 도메인 `oor7.com`)에 맞춘다. **주의**: 데스크탑(Tauri) 셸·서버가 발급하는 링크 양쪽에 걸쳐 있으면 **함께** 바꿔야 반쪽이 안 된다. 옛 스킴 유입 처리(무시할지 흡수할지)를 판단하고 PR에 적어라. 레포 코드명은 momo 유지 — **제품 표면만** oort다.
3. **"managed by" 미번역** — UI에 영문 잔류. 한국어로(용어는 기존 번역 관례를 따라라).
4. **프로필 편집** — 사용자가 자기 표시 이름 등을 못 고친다. 서버에 경로가 이미 있는지 **먼저 확인**하고(에이전트 프로필 PUT은 B5.3a에 있다 — 사람 member용이 있는지 확인), 없으면 **클라만 손대지 말고** 이 항목은 "서버 미제공"으로 보고만 하고 넘겨라(가짜 편집 UI 금지).

## 3. 하지 말 것
메시지 액션(→B11) · 표면 정직화·검색(→B12) · 트리거 스키마 확장 · 새 마이그레이션 · `schema_v0.sql` 수정/이동.

## 4. 검증·PR
- 서버: `cargo check` / `cargo test` / `cargo fmt --check` / `cargo clippy -- -D warnings`. **DM 자동응답 테스트 필수**: (a) 사람→에이전트 DM 무멘션 = run 1건 (b) **에이전트→에이전트 DM = run 0건** (c) pause = run 0건 (d) 멘션+DM 중복 = run 1건 (e) 그룹 채널 무멘션 = run 0건(회귀 방지).
- 클라: `npm run build` + `tsc` + `test` + `lint` + preflight + 캡처(변경 표면).
- PR `feat/B13-dm-and-polish` → `track/engine`. 본문에 DM 트리거 조건표·안전장치 보존 근거·M/L 항목별 재실측 결과(고침/해당없음/서버 미제공)·이탈. **PR 후 STOP.**
