# buzz급 진단 감사 — 축 A: 라이선스·공개 준비

> 워커 A. 2026-08-10. 읽기 전용 실측(코드·설정 변경 0줄).
> 기준 브랜치 **origin/track/engine**(로컬 ref `8d9bb512`, 2407 commits). main-only 사실은 명시.
> 패킷: `docs/planning/handoffs/2026-08-10-buzz-diagnosis-audit-packet.md` §A
> buzz 기준선은 `gh api repos/block/buzz` 실측(2026-08-10 시점: Apache-2.0, ★25,485, fork 2,999, open issues 2,338, pushed 2026-08-09).

---

## 0. 판정 요약

| # | 체크 항목 | 판정 | 층 |
|---|---|---|---|
| A1-a | cargo 의존 라이선스 전수 — AGPL/GPL/미상 존재 여부 | **PASS**(GPL/AGPL 0 · 미상 0) + **GAP**(감사 장치 0) | 1/2 |
| A1-b | npm(web·mobile·core) 의존 라이선스 전수 | **PASS**(AGPL/GPL-only 0) + **GAP**(선언 정책 위반 MPL 24건 방치) | 1/2 |
| A1-c | CLAUDE.md "AGPL 백본 금지" 대조 | **PASS** — 백본(server-rust 309 crate)에 copyleft 0 | 1 |
| A2-a | LICENSE 현황 | **PASS** — Apache-2.0 전문, GitHub 메타도 인식 | 1 |
| A2-b | NOTICE 현황 | **GAP** — 존재하나 손편집 정본이 아니고 `TODO(Codex)` 미완, cargo 섹션 0 | 2 |
| A2-c | 저작권/SPDX 헤더 | **GAP** — 1차 소스 ~1,512 파일 중 헤더 **0건** | 2 |
| A2-d | buzz 코드 실제 복사 여부(ADR-0145 반증 시도) | **PASS** — 복사 증거 없음. 단 자기 규율(출처 헤더 표기) 미이행 | 1 |
| A3 | git 전 히스토리 시크릿 스캔 | **PASS** — 공개 차단급 **0건**(60건 전수 트리아지 = 전부 오탐/픽스처) | 1 |
| A4-a | 공개 시 노출 목록(인프라 주소·계정 식별자) | **GAP** — 정리 대상 6종 특정(저비용) | 1 |
| A4-b | `legal/privacy-policy.md` 빈칸 | **BLOCKED** — 플레이스홀더 9곳 + 법률 검토 미필 → **성재 결정 대기** | 1 |
| A4-c | 내부 운영 문서 공개 범위 | **성재 결정 대기** — planning/research 378파일이 그대로 공개됨 | 1 |
| A5 | buzz 기준선 대비 | **GAP** — 장치 6종 부재(deny.toml·CoC·GOVERNANCE·CODEOWNERS·PR/이슈 템플릿·PR CI) | 2 |

**1층 결론**: 라이선스 위생과 히스토리 시크릿은 **공개를 막지 않는다**. 공개를 막는 건 라이선스가 아니라 **(a) 성재만 답할 수 있는 3건**(공개 범위·개인정보방침 법률검토·내부 문서 공개 여부)과 **(b) 30분이면 끝나는 정리 6건**(끊긴 신고 링크·내부 IP·개인 이메일)이다.

**2층 결론**: 선언과 실측의 간극이 축 A의 진짜 부채다. CONTRIBUTING·AGENTS.md가 기여자에게 약속한 fail-closed 게이트는 **전체 의존 1,902개 중 37개(1.9%)만** 실제로 검사한다.

---

## A1. 의존 라이선스 전수

### 방법
- cargo: `Cargo.lock` 2개(engine 기준)를 파싱해 (name, version) 유니크 집합을 만들고, 로컬 crates.io 레지스트리 캐시(`~/.cargo/registry/src/index.crates.io-*/<name>-<ver>/Cargo.toml`)의 `license` 필드를 읽음. 캐시 미스 7건은 crates.io API로 개별 확인 → **미상 0건으로 종결**.
- npm: 각 `package-lock.json`(전부 lockfileVersion 3)의 `packages[].license` 필드. 커버리지 99.7%(예: `clients/web` 478중 477).
- 산출물: `scratchpad/A/cargo_licenses.json`, `scratchpad/A/locks/`.

### cargo — 실측
| 대상 | 유니크 crate | 판정 |
|---|---|---|
| `server-rust/Cargo.lock`(**서버 백본 = 라이브 이미지**) | 309 | **copyleft 0.** 전부 permissive 또는 permissive 분기를 가진 dual |
| `clients/desktop/src-tauri/Cargo.lock`(데스크톱 클라) | 528 | MPL-2.0 6건(아래) |
| 합집합 | **663** (1st-party workspace crate 19 제외 시 **644**) | GPL/AGPL/LGPL-only **0건**, 미상 **0건** |

라이선스 분포(상위): `MIT OR Apache-2.0` 309 · `MIT` 133 · `Apache-2.0 OR MIT` 64 · `MIT/Apache-2.0` 28 · `Zlib OR Apache-2.0 OR MIT` 18 · `Unicode-3.0` 18 · `BSD-3-Clause` 6 · `MPL-2.0` 5(+1) …

**주의 대상 2종**
1. **MPL-2.0 6건 — 전부 desktop Tauri 그래프, server-rust에는 0건**
   `cssparser 0.36.0` · `cssparser-macros 0.6.1` · `dtoa-short 0.3.5` · `selectors 0.36.1` · `option-ext 0.2.0` · `webpki-root-certs 1.0.9`.
   법적 판단: MPL-2.0은 **파일 단위 copyleft**라 미개조 링크는 Apache-2.0 배포를 오염시키지 않는다 → **차단 사유 아님**. 다만 (i) NOTICE 귀속 대상이고, (ii) CONTRIBUTING이 스스로 "MPL 계열 fail-closed 거부"라고 적어 둔 항목이다(§A1 정책 충돌 참조).
2. **`r-efi` 5.3.0 / 6.0.0 → `MIT OR Apache-2.0 OR LGPL-2.1-or-later`** (server-rust 1건 + desktop 2건)
   OR 표현식이라 permissive 분기 선택 가능 → 법적 문제 없음. 단 `check_spm_licenses.sh:106`의 `copyleft_name()`은 **표현식 평가 이전에 이름 매칭으로 죽인다** — 그 로직을 cargo에 그대로 확장하면 이 crate에서 오탐 fail이 난다(설계 결함 예고).

### npm — 실측
| lockfile | packages | license 필드 보유 |
|---|---|---|
| `clients/web`(ADR-0133 정본) | 478 | 477 |
| `clients/mobile` | 1077 | 1075 |
| `clients/web-legacy`(폐기 트리) | 273 | 272 |
| 루트 `package-lock.json`(momo-core 워크스페이스) | 199 | 196 |
| `clients/mobile-spike` | 885 | 883 |
| `examples/eve-momo-channel` | 151 | 150 |
| `examples/cloudflare-agent-momo` | 152 | 151 |
| **유니크 합계(전 트리)** | **1,536** | |
| **유니크 합계(라이브 3트리: web+mobile+root)** | **1,258** | |

라이브 3트리 분포: MIT 1070 · ISC 50 · Apache-2.0 40 · BSD-3-Clause 38 · **MPL-2.0 24** · BSD-2-Clause 14 · BlueOak-1.0.0 7 · `(BSD-3-Clause OR GPL-2.0)` 1 · MISSING 2 …

- **AGPL/GPL-only: 0건** → CLAUDE.md "AGPL 백본 금지" 위반 **없음**.
- **MPL-2.0 24건 = `lightningcss` + 플랫폼별 네이티브 바이너리 12종 × 2트리.**
  `clients/web`에서는 `dev=true`(빌드 도구), **`clients/mobile`에서는 `dev` 플래그 없음 = 프로덕션 그래프**(경로: `expo → @expo/metro-config → lightningcss@1.33.0`).
- `node-forge@1.4.0` = `(BSD-3-Clause OR GPL-2.0)` — dual이라 BSD 분기 선택 가능. 경로: `@expo/code-signing-certificates`, `expo/@expo/cli`. **법적 문제 없음, 그러나 이름 매칭형 fail-closed 게이트가 죽일 정확한 형상.**
- license 필드 부재 2건: `node_modules/exit`(dev), `packages/momo-core`(1st-party 워크스페이스 링크 — 자기 패키지).
  → `packages/momo-core/package.json`에 `license` 필드가 없다. 공개 시 npm/SBOM 도구가 "UNLICENSED"로 읽는다.

### 정책 대 실측 — 세 곳의 불일치 (핵심 발견)
| 선언 | 위치 | 실측 |
|---|---|---|
| "`--check`는 9개 SwiftPM 그래프의 checkout LICENSE 원문과 고지 드리프트를 검사하며, **GPL/AGPL/LGPL/MPL/SSPL/BUSL 계열은 fail-closed로 거부**" | `CONTRIBUTING.md:24` | 검사 대상은 SwiftPM **37 패키지뿐**. cargo 644 · npm 1,258은 **어떤 게이트도 통과하지 않는다.** 선언대로면 MPL 30건(cargo 6 + npm 24)이 거부돼야 하나 그대로 트리에 있다 |
| "새 의존 추가 시 라이선스 확인 + `legal/THIRD_PARTY_NOTICES.md`/`NOTICE` 귀속 반영" | `AGENTS.md:167` | cargo 644 crate 중 NOTICE/THIRD_PARTY 언급 **0건** |
| "9개 SwiftPM 그래프" | `CONTRIBUTING.md:24` | 스크립트 기대값은 **10**(`scripts/check_spm_licenses.sh:38`), 생성 헤더도 "from 10 Package.resolved"(`legal/THIRD_PARTY_NOTICES.md:6`) — 문서 드리프트 |

### 게이트 실행 위치 (공개 준비 관점)
`check_spm_licenses.sh`를 호출하는 곳은 `scripts/local_gate.sh` **하나뿐**. `.github/workflows/*` 5개 전부에 license/deny/audit 스텝이 **0건**.
→ 외부 기여자의 PR은 라이선스 검사를 **한 번도 받지 않는다**. buzz는 `cargo-deny check`를 PR CI 잡으로 강제한다(`.github/workflows/ci.yml:899-900`).

---

## A2. LICENSE·NOTICE·저작권 헤더 + buzz 코드 복사 반증

### LICENSE — PASS
`LICENSE` 202줄 = Apache-2.0 전문(부록 boilerplate 포함, 미치환 상태는 정상). GitHub API가 `spdx_id: Apache-2.0`으로 인식. `server-rust/Cargo.toml`의 `[workspace.package] license = "Apache-2.0"`도 일치.
이미지 배포도 지킨다: `infra/prod/docker/momo.Dockerfile:84,91-92`와 `server-rust/Dockerfile:143,152-153`이 `LICENSE`·`NOTICE`를 `/usr/share/licenses/`에 복사하고 **빌드 시 존재를 test로 강제**한다. Apache §4(d) 준수 설계로는 오히려 buzz보다 낫다.
- 예외: `infra/prod/Dockerfile.web`(웹 정적 이미지)은 LICENSE/NOTICE를 **동봉하지 않는다**(`grep -ci 'LICENSE|NOTICE'` = 0). 그 이미지는 web-legacy 번들(react/xterm/livekit 등 MIT·Apache-2.0)을 재배포한다 → **§4(d)·MIT 고지 의무 미이행 표면 1개**.

### NOTICE — GAP
- 존재(2,057 bytes)하고 Apache §4(d)를 명시적으로 인용한다.
- 그러나 파일 자체가 미완을 자백한다: `NOTICE:32-34` `TODO(Codex): regenerate from Package.resolved via scripts/gen-notices.sh; verify each SPDX identifier against the upstream LICENSE file.` — **`scripts/gen-notices.sh`는 레포에 존재하지 않는다.**
- `NOTICE:1`이 아직 `momo` (리브랜딩 잔여 — E축 소관이나 법적 고지 문서라 여기서도 유효).
- **cargo 섹션 전무.** `legal/THIRD_PARTY_NOTICES.md`(108줄) 전체에 Rust/cargo 항목 0. 라이브 서버가 Rust인데 서버 의존 309 crate가 고지에 없다.
- npm 커버리지 자백: `legal/THIRD_PARTY_NOTICES.md:58-59` — *"새 `clients/web`(ADR-0133) 의존성은 배포물에 아직 포함되지 않아 미표기"*. 실제로는 `clients/web`이 정본이고 라이브 배포 대상이다(B축 소관). 명시 npm 패키지는 12행뿐.

**커버리지 산술**: 고지·게이트가 실제로 커버하는 의존 = SwiftPM 37개. 전체 서드파티 의존 모집단 = 37(SwiftPM) + 644(cargo) + 1,258(npm 라이브) ≈ **1,939** → **커버율 1.9%**.

### 저작권/SPDX 헤더 — GAP (0건)
1차 소스 파일 수(engine, vendored 제외): `.swift` 455 · `.ts` 347 · `.rs` 215 · `.tsx` 210 · `.sh` 177 · `.py` 59 · `.mjs` 49 = **1,512**.
- `SPDX-License-Identifier` 포함 파일 = **2**, 둘 다 `clients/mobile-spike/android/gradlew`·`gradlew.bat`(Gradle 래퍼 = vendored).
- `Copyright` 포함 파일 = 9, 그중 1차 소스는 **0**(LICENSE·NOTICE·vendored xml/gradlew·기획 문서뿐).
→ Apache-2.0 부록이 권장하는 파일 헤더가 전무. 차단은 아니나, 코드 조각이 레포 밖으로 나갔을 때 출처를 주장할 근거가 파일 안에 없다. buzz도 헤더는 없으므로 **기준선 대비 동등** — 우선순위는 낮다.

### buzz 코드 복사 반증 시도 — 반증 실패(= ADR-0145 주장 유지)
반증을 위해 시도한 것과 결과:
| 시도 | 결과 |
|---|---|
| `server-rust/**`에서 `buzz` 문자열 검색 | **2건뿐**, 둘 다 패턴 출처 주석: `server-rust/bins/momo-server/src/lib.rs:5`("buzz's rule, D1 §2"), `server-rust/crates/momo-wire/src/provenance.rs:3`("momo takes exactly one thing from buzz(Nostr)") |
| `nostr` / `schnorr` / `secp256k1` 검색 | **1건**(위 주석). 실제 crate 의존 0 |
| `server-rust/Cargo.toml` 의존 대조 | axum·sqlx·tokio·uuid·serde 등 범용. buzz 고유 crate(nostr, mesh-llm, iroh, rust-s3) **0건** |
| buzz 트리 vendoring 이력 | `git log --all --diff-filter=A`에 `buzz/`·`scratchpad/` 경로 **0건**. `.gitignore`에도 언급 없음 |

**단, 자기 규율은 미이행이다.** `docs/planning/2026-07-30-buzz-reference-catalog.md`(D4) 서두가 스스로 *"인용한 패턴은 파일 헤더에 출처(buzz 경로) 주석 표기(Apache 2.0 attribution)"* 라고 약속하고 인용 패턴 6종(Axum 핸들러 파이프라인 · sqlx 스타일 · connection semaphore 백프레셔 · 서브시스템 격리 · 검색 인덱싱 · 워크스페이스 crate 다분할)을 열거한다. 실제 파일 헤더 출처 표기는 **0건**이고 buzz 언급은 위 2건의 산문 주석뿐이다.
→ **판정: 라이선스 위반 아님**(패턴·아이디어는 저작권 대상이 아니고 Apache-2.0도 요구하지 않는다). **자기 선언 대비 이행 격차**이며, 공개 시 "buzz 참조"를 어떻게 서술할지는 문서 문제로 남는다.

---

## A3. git 전 히스토리 시크릿 스캔

### 방법과 커버리지
```
gitleaks detect --source . --log-opts "--all" --report-format json --redact=90
→ 2029 commits scanned, ~42.81 MB, leaks found: 60
```
- 커버리지: `git rev-list --all --no-merges --count` = **2,063** vs gitleaks 스캔 2,029 → **98.3%**. 차이 34는 텍스트 diff가 없는 커밋(바이너리·모드 변경)으로 보이나 미검증 — 잔여 리스크로 기록.
- 도달 불가 객체 148개(`git count-objects -v`: loose 148)는 reachability 기반 스캔이 보지 않는다. 공개는 push된 것만 나가므로 실무상 무해.
- 보완 스캔 2종을 별도 수행: (1) 자격증명형 파일명 전 히스토리 `--diff-filter=AM` 전수, (2) 공인 IPv4 전 히스토리 `git log --all -p` 전수.

### 60건 전수 트리아지 → **진짜 시크릿 0건**
| 분류 | 건수 | 판정 근거 |
|---|---|---|
| `http://api:8080/...` URL을 API 키로 오인 | 13 | `docs/DEPLOY.md`·`docs/RUN.md`·`infra/centrifugo.json`·`infra/prod/centrifugo.prod.json`·`docs/adr/0002`·`research/07-deepdive/04` — compose 내부 서비스 주소 |
| Swift 타입명 `privateKey: Curve25519...` / `P256...` | 8 | `workers/WorkHostDaemon/.../Signing.swift:11`, `workers/NotifierWorker/.../PushRelaySigning.swift:7`, `relay/PushRelay/.../APNSSender.swift:23`, `clients/macOS/.../MomoWorkHostIdentityStore.swift:7` — 식별자, 값 아님 |
| PEM **파서 코드 + 합성 테스트 키** | 2 (`private-key` 룰) | `server-rust/bins/momo-notifier/src/push_relay.rs:77`(`text.find("-----BEGIN PRIVATE KEY-----")`), `:289`(테스트가 `[9u8; 32]` 시드로 PEM을 **생성**) |
| 테스트 픽스처 상수 | 9 | `whsec_...`(webhook 테스트), `sk-...`(hermes mock), `config.centProxySecret`, `hermesAPIKey`, `app_secret`, `Sec-WebSocket-Key: dG...`(RFC 6455 예제 상수) |
| 검증 스크립트의 합성 env(RFC 2606 `.example.net` 도메인) | 13 | `scripts/verify_prod_install_upgrade.sh:90-112` — `POSTGRES_PASSWORD`·`CENT_TOKEN_HMAC`·`OUTBOUND_WEBHOOK_MASTER_KEY` 등이 하드코딩 16진 리터럴이나, 같은 파일이 `DIGEST_A="$(printf 'a%.0s' {1..64})"` 계열 더미와 `api.momo-install.example.net`을 쓴다 = 일회용 fixture |
| 명백한 플레이스홀더 | 4 | `CENT_API_KEY="momo-538-cent-api"`(`scripts/verify_eve_profile.sh:109`), `MOMO_INITIAL_OWNER_PASSWORD=`(빈값, `clients/mobile/scripts/lane-phone.sh:324`), staging smoke의 `cent_*`/`hermes_*` 접두 더미 |
| JWT 룰 4건 | 4 | `adapters/hermes/tests/test_provider_chain_contract.py:453,454,469` + `server-rust/.../agent_gateway.rs:1058` — 테스트가 만든 서명 토큰 |
| npm/CocoaPods 체크섬 오인 | 1 | `clients/mobile/ios/Podfile.lock:2346`(RNKeychain 해시) |

### 자격증명형 파일명 — 전 히스토리 전수 (PASS)
`.pem` · `.p12` · `.pfx` · `.key` · `.jks` · `.mobileprovision` · `id_rsa` · `id_ed25519` · 실제 `.env` · `*secret*` · `*credential*` · `*service-account*` · `.age` 패턴으로 `--diff-filter=AM` 전수:
- **커밋된 적 있는 것은 전부 `*.example` 템플릿**(`.sops.yaml.example`, `infra/.env.example`, `infra/prod/.env.example`, `infra/prod/secrets.env.example`, `clients/web/.env.local.example`) 또는 소스/스냅샷 PNG.
- 유일한 실제 키 자료: `clients/mobile-spike/android/app/debug.keystore` — Android **디버그** 키스토어(암호가 `android`로 표준 공개, 배포 서명 불가). **심각도 낮음**, 다만 폐기 트리(mobile-spike)에 남은 바이너리 키 파일이므로 공개 전 제거 권고.
- 실 `.env`는 작업트리에 존재하나(`-rw-------`) `.gitignore:6`이 막고 있고 **한 번도 트래킹된 적 없다**.

`.gitignore`(engine)의 시크릿 방어는 실질적이다: `.env` · `.env.local` · `local-hermes-provider.env` · `*.secret.env` · `infra/prod/.env.*`(+`!.env.example` 예외) · `infra/prod/secrets.env` · `infra/prod/age.key` · `infra/prod/keys.txt`.
게다가 `scripts/verify_staging_smoke.sh:148-158`이 **그 .gitignore 규칙 자체와 템플릿의 플레이스홀더 여부를 게이트로 검사**한다(고엔트로피 값이 example 파일에 들어오면 fail). 축 A에서 발견한 가장 성숙한 통제다.

### **A3 판정: PASS — 히스토리 시크릿은 공개 차단 사유가 아니다.**
히스토리 재작성(BFG/filter-repo)·키 로테이션 필요 없음. 60건은 전부 노이즈이며, 오히려 "공개 전 스캔 돌려서 뭐가 나오는지 이미 안다"는 상태를 만들 수 있다. **권고**: 공개 전 `.gitleaksignore`에 이 60건을 근거 주석과 함께 고정해 두면, 이후 진짜 유출이 신호로 튀어오른다(지금은 60건 노이즈에 묻힌다).

---

## A4. 공개 시 노출되는 것

### 정리 대상 (1층 — 저비용, 공개 전 처리 권고)
> 시크릿이 아니라 **식별자·주소**다. 값은 옮기지 않고 위치와 종류만 기록한다.

| # | 종류 | 위치 | 심각도 | 메모 |
|---|---|---|---|---|
| 1 | **끊긴 보안 신고 링크** | `SECURITY.md`의 advisories URL이 `github.com/Dawn-kim-official/momo` | **높음(운영)** | 실제 레포는 `yeomyeonggeori/momo`(gh api 실측). 공개 즉시 취약점 신고 경로가 404. 같은 구 org명이 `publish-images.yml`의 `ghcr.io/dawn-kim-official/momo`, `docs/cicd/02-secrets-inventory.md`에도 박혀 있다 |
| 2 | **NCP 운영 서버 IP 2개** | ①: `infra/rust/Caddyfile`(주석), `docs/runbooks/ncp-rust-deploy.md`, `docs/planning/CURRENT_STATE.md`·`JOURNAL.md`·`NEXT_SESSION_BRIEF.md`·핸드오프 2건·research 1건 (engine+main 양쪽) / ②: `docs/planning/JOURNAL.md`, `docs/planning/research/2026-08-09-cubesandbox-d42-spike.md` | ①낮음 ②중간 | ①은 `app.oor7.com`의 A 레코드 = DNS로 이미 공개(신규 노출 아님). **②는 DNS에 없는 두 번째 호스트** — 공개 시 신규 노출 |
| 3 | **SSH 허용 출발지 /32 + NCP 계정 리소스 ID** | `docs/planning/handoffs/2026-07-29-resume-batch3.md:57` (VPC/Subnet/ACG 번호 + 허용 IP + `~/Downloads/*.pem` 경로) | **중간** | 방화벽 허용 출발지가 어디인지를 알려준다. 개인 회선 IP로 보임 |
| 4 | **개인 Gmail 주소** | `scripts/internal_alpha_stack.sh:168`(플랫폼 관리자 기본값), `scripts/publish_alpha_build.sh:132`, `scripts/publish_next_build.sh:214`, `scripts/switch_default_download.sh:73`(git author) | 중간(프라이버시) | 커밋 author로도 2,158회 등장 — **히스토리는 되돌릴 수 없다**. 스크립트 기본값만 env로 빼는 것이 현실적 조치 |
| 5 | **Apple Team ID + GCP/SA 식별자 + 서명 레포명** | `DEVELOPMENT_TEAM`이 pbxproj 4개 + 테스트 단정 2곳(`clients/mobile/__tests__/projectShape.test.ts:192,196`); `docs/GWS_INTERNAL_CONSENT_RUNBOOK.md:68`(GCP 프로젝트·SA 이메일); `docs/cicd/02-secrets-inventory.md`(비공개 서명 레포 이름) | 낮음 | Team ID는 앱 메타데이터로 어차피 공개. SA는 **이메일만**이고 키는 레포 밖이라 명시됨 |
| 6 | **Android 디버그 키스토어 바이너리** | `clients/mobile-spike/android/app/debug.keystore` | 낮음 | 표준 공개 암호. 폐기 트리 정리와 함께 |

**노출 아님으로 확인된 것**: 공인 IPv4는 engine 트리 **0건**(위 2·3은 문서 텍스트). 진짜 시크릿 값 0건. 시크릿 인벤토리(`docs/cicd/02-secrets-inventory.md`)는 **이름·형식·발급처만** 담고 값이 없다 — 설계가 옳다.

### `legal/privacy-policy.md` — BLOCKED / 성재 결정 대기
- 파일 49줄, 머리말이 스스로 *"초안 템플릿이며 법률 자문이 아니다. 게시 전 변호사 검토 필수"*.
- 미확정 플레이스홀더 **9곳**: LLM 제공자 식별(§3 제공받는 자)·보유이용기간 ×2·파기 정책(§4)·동의철회 방법(§5)·14세 미만 절차(§6)·보호책임자 및 연락처(§7)·시행일·최종개정일.
- 게시 URL도 미정(`https://<momo-domain>/privacy`).
- 자매 문서 `legal/agent-disclosure.md`(27줄)도 동일하게 초안이며 `TODO(Codex)`로 UI 연결 미완.
→ **오픈소스 레포 공개는 막지 않으나**, 앱스토어 제출·실사용자 온보딩·PIPA 준수는 막는다. "런칭"의 정의에 따라 1층 차단이 되는지가 갈린다 → **성재 결정 대기(런칭 정의)**.

### 내부 운영 문서 공개 범위 — 성재 결정 대기
공개 시 그대로 나가는 문서량: `docs/planning/` **266파일** + `research/` **112파일** = **378파일**(+ `docs/adr/` 57 + `STATUS.md` 539KB + `BUILD_TICKETS.md` 295KB).
여기에는 세션 저널·핸드오프 패킷·경쟁사 분석(`2026-07-22-buzz-competitive-analysis.md`)·에이전트 오케스트레이션 규율·인프라 자원 ID가 섞여 있다. 라이선스상 문제는 없다. **무엇을 공개 레포에 남길지는 판단 사항 → 성재 결정 대기.**

---

## A5. buzz 기준선 (block/buzz 실측, 추측 없음)

### 공개 준비 장치 대조
| 장치 | block/buzz | oort | 판정 |
|---|---|---|---|
| LICENSE | Apache-2.0 전문 | Apache-2.0 전문 | **동등** |
| **NOTICE** | **없음**(API 404, 코드검색 0건) | 있음(§4(d) 인용, 단 TODO 미완) | **oort 우위** |
| 이미지에 LICENSE 동봉 | (미확인) | `momo.Dockerfile`·`server-rust/Dockerfile`이 복사 + `test -s`로 강제 | **oort 우위** |
| **의존 감사 장치** | **`deny.toml`**(cargo-deny): `[licenses] allow` 19종 화이트리스트 + `[advisories] ignore` 4건에 **RUSTSEC ID·전이 경로·왜 안전한지·언제 제거할지**를 주석으로 기재 + `[[licenses.clarify]]`로 필드 누락 crate 6개 보정 | cargo 감사 **0**. SwiftPM 전용 `check_spm_licenses.sh` 1개 | **buzz 압도** |
| 감사 게이트 CI 강제 | `ci.yml:899-900` `cargo-deny check`가 PR CI 잡 (트리거 = `push` + `pull_request`) | 워크플로 5개 전부 license 스텝 0, 전부 `workflow_dispatch` | **buzz 압도** |
| CONTRIBUTING | 529줄, 12절 TOC(환경설정·테스트·코드스타일·아키텍처·"새 event kind 추가법"·"새 MCP 툴 추가법"·"새 API 엔드포인트 추가법"·License and CLA), DCO 미서명 시 **DCO Check가 PR 차단** | 24줄, 5절 | **buzz 압도(22배)** |
| SECURITY.md | 있음(신고 이메일, ack 48h / 응답 7d, 공개 규범, 크레딧) | 있음(**private advisory 폼**, ack 3영업일 / 심각도 7영업일 / 14일 상태보고, "이런 값은 보내지 마라" 목록) | **oort가 더 구체적** — 단 링크가 죽은 org를 가리킴(A4-1) |
| CODE_OF_CONDUCT | Contributor Covenant v2.1 + 신고 이메일 | **없음** | GAP |
| GOVERNANCE | `GOVERNANCE.md` | **없음** | GAP |
| CODEOWNERS · PR 템플릿 · 이슈 템플릿 | `.github/` 3종 모두 | **없음** | GAP |
| ARCHITECTURE.md 루트 노출 | 있음 | `docs/architecture/overview.md`(루트 진입점 아님) | 경미 |
| CHANGELOG · RELEASING | 둘 다 | 없음(`docs/RELEASE_PLAYBOOK.md`는 내부용) | GAP |
| 의존 자동 갱신 | `renovate.json` | dependabot 커밋 13건 흔적(설정 파일은 미확인) | 경미 |
| 규모 | ★25,485 · fork 2,999 · open issues 2,338 · 워크플로 17 | private · ★0 · fork 0 · open issues 138 · 워크플로 5 | 참고 |

### 여기서 읽어야 할 것 (해석)
1. **buzz도 NOTICE가 없다.** 즉 "완벽한 고지"가 buzz급의 조건이 아니다. buzz가 실제로 갖춘 건 **자동화된 정책 강제**(deny.toml + PR CI)다. oort는 정반대로 **문서는 앞서고 강제는 없다** — 25줄짜리 CONTRIBUTING이 fail-closed를 약속하지만 CI에는 그 게이트가 없다.
2. **buzz의 `deny.toml`은 `MPL-2.0`을 allow에 넣었다.** oort의 CONTRIBUTING은 MPL을 fail-closed 거부 대상으로 적어 놓고 트리에 MPL 30건을 갖고 있다. buzz는 정책을 현실에 맞췄고 oort는 현실을 정책에 안 맞췄다 — 이건 정책 문구 조정(1줄)으로 닫히는 격차다.
3. **CONTRIBUTING 529줄 대 24줄이 진짜 격차다.** buzz의 CONTRIBUTING은 "어떻게 기여하나"가 아니라 **"이 코드베이스에서 X를 추가하는 정확한 절차"**(event kind / MCP tool / API endpoint)를 담는다. oort의 등가물은 `AGENTS.md`(20KB)·`CODEX.md`(20KB)인데 **에이전트 워커용이지 사람 외부 기여자용이 아니다.**
4. **DCO 실태**: oort CONTRIBUTING이 "모든 커밋은 DCO 서명 필수"라 선언하나, 전 히스토리 2,738 커밋 중 `Signed-off-by` **15건(0.5%)**, main 2,375 중 **1건**. 강제 워크플로 없음. buzz는 DCO Check가 PR을 막는다.
   → 저작권 리스크는 아니다(사실상 단독 저자: `kwakseongjae` 2,158 + `곽성재` 561 + dependabot 13 + `seeun@dawn.kim` 6). **선언이 허구인 것이 문제**이고, 외부 기여를 받기 시작하는 순간 실제 문제가 된다.

---

## 상위 발견 3

1. **공개를 막는 건 라이선스도 시크릿도 아니다.**
   전 히스토리 2,029 커밋 스캔 60건을 전수 트리아지한 결과 **진짜 시크릿 0건**, 자격증명형 파일 커밋 이력 0건, 의존 1,902개 중 GPL/AGPL 0건·미상 0건. 히스토리 재작성도 키 로테이션도 필요 없다. 남은 1층 항목은 **성재만 답할 수 있는 3건**(공개 범위·개인정보방침 법률검토·내부 문서 378파일 공개 여부)과 **30분짜리 정리 6건**뿐이다.

2. **선언과 강제의 간극 — 커버율 1.9%.**
   `CONTRIBUTING.md:24`가 기여자에게 "GPL/AGPL/LGPL/MPL/SSPL/BUSL fail-closed"를 약속하지만 실제 게이트는 SwiftPM **37개**만 본다. cargo **644** + npm **1,258** = **1,902개가 무검사**이고, 그 안에 정책상 거부됐어야 할 **MPL-2.0 30건**(cargo 6 · npm 24, 그중 `clients/mobile`의 lightningcss는 프로덕션 그래프)이 그대로 있다. 게다가 그 하나뿐인 게이트도 `scripts/local_gate.sh`에서만 돌고 **CI 워크플로 5개 어디에도 없다** — 외부 PR은 라이선스 검사를 한 번도 받지 않는다. buzz는 `cargo-deny check`를 PR CI로 강제한다. **법적 위반은 아니지만 "약속한 통제가 존재하지 않는" 상태이며, 이게 축 A의 유일한 실질 부채다.**

3. **buzz 기준선의 정답은 "문서를 더 쓰는 것"이 아니라 "정책을 자동화하는 것"이다.**
   buzz는 NOTICE조차 없다 — 대신 `deny.toml` 한 파일이 라이선스 화이트리스트 19종과 RUSTSEC 예외 4건을 근거·해제조건과 함께 코드로 고정하고 PR마다 강제한다. oort는 정반대 형상이다(고지 문서는 buzz보다 낫고, 강제는 0). 따라서 격차 해소의 최단 경로는 NOTICE 보강이 아니라 **① `deny.toml` 신설(cargo 644 즉시 커버) ② npm 라이선스 체크를 폐기 트리 `web-legacy`에서 정본 `clients/web`·`clients/mobile`로 이설 ③ 두 개를 PR CI 잡으로 승격**이다. 부수적으로 CONTRIBUTING의 MPL 문구를 현실(buzz처럼 MPL allow)에 맞추면 정책-실측 불일치가 함께 닫힌다.

---

## 성재 결정 대기 (판정하지 않음)
| # | 항목 | 왜 성재만 답하나 |
|---|---|---|
| S-A1 | 공개 시점·공개 범위(전체 레포 vs 코드만) | 전략 |
| S-A2 | `docs/planning` 266 + `research/` 112 = 378파일을 공개 레포에 남길지 | 내부 맥락 노출 판단 |
| S-A3 | `legal/privacy-policy.md` 변호사 검토 발주 여부·시점 | 비용·법률 |
| S-A4 | 개인 Gmail을 스크립트 기본값에서 뺄지(히스토리는 불가역) | 프라이버시 선택 |
| S-A5 | 레포명·org명 확정(`yeomyeonggeori/momo` ↔ `Dawn-kim-official` ↔ oort 리브랜딩) — SECURITY.md 신고 링크·GHCR 경로가 여기에 매달림 | 정체성 |
| S-A6 | "런칭"에 앱스토어 제출이 포함되는지 (포함이면 privacy-policy가 1층 차단) | 런칭 정의 |

## 근거 아티팩트
- `scratchpad/A/gitleaks-history.json` (60건 원본, 90% redact) · `scratchpad/A/gitleaks-history.log`
- `scratchpad/A/cargo_licenses.json` (663 crate × license × 출처) · `scratchpad/A/cargo_lic.py`
- `scratchpad/A/locks/` (engine 기준 Cargo.lock 2 + package-lock.json 7)
