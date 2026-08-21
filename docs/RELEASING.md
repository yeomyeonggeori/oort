# 서버/이미지 릴리스 (RELEASING.md)

> **이 문서 하나로 서버 이미지 릴리스를 완주한다.** 범위는 `v0.x` 태그 +
> GitHub Release + GHCR 불변 digest 표 + `docs/SELF_HOST.md` 문면이다.
> 데스크탑 Tauri next 채널은 **다른 절차**다 — [§데스크탑 next 채널과의 경계](#데스크탑-next-채널과의-경계).
>
> 태그 push와 GitHub Release 생성은 오케스트레이터가 집행한다. 이 문서는 그
> 절차의 정본이지, 워커에게 원격 쓰기를 허가하지 않는다.

근거 원장: 핸드오프 패킷
[`docs/planning/handoffs/2026-08-21-launch-hygiene-wave-packet.md`](planning/handoffs/2026-08-21-launch-hygiene-wave-packet.md)
§G1 · GitHub 이슈 #1628. 발행 digest 실값·빌드 커밋·실측은 그 패킷만 인용한다.

---

## 한 줄 순서

**승격 → 발행(dispatch · owner 승인) → digest 수거 → 태그(빌드 커밋에) →
Release(digest 표) → SELF_HOST 문면 갱신.**

릴리스는 **main 기준**이다. 태그는 승격 커밋에 앉힌다 — track 브랜치 HEAD가
아니다.

---

## 1. 승격

발행 workflow는 `refs/heads/main` 만 받는다
(`.github/workflows/publish-images.yml`). 이미지가 가리킬 커밋이 아직
`track/engine` 에만 있으면, 성재의 명시 승인 뒤에 `track/engine` → `main`
승격부터 한다([`docs/TRACKS.md`](TRACKS.md) §3). 워커가 main에 직접 push하지
않는다.

첫 공개 발행의 빌드 커밋은 `main=45a154d2` 다 (패킷 §G1).

---

## 2. 발행 (dispatch · owner 승인)

수동 `publish-images.yml` 만 쓴다. 자동 `push`/`pull_request`/tag 트리거는
없다.

1. Actions에서 workflow `publish-images` 를 **main** ref로 dispatch 한다.
   또는:

   ```sh
   gh workflow run publish-images.yml --ref main
   ```

2. GitHub `release` Environment 의 owner 승인을 기다린다. 2026-08-12
   attended 설정/readback: required reviewer `kwakseongjae`(user id
   `87296259`), `prevent_self_review=false`, deployment branch policy 는
   custom `main` 하나.

3. 워크플로가 `linux/amd64` 로 앱(`ghcr.io/yeomyeonggeori/oort`)과
   PostgreSQL 18+pgBackRest(`ghcr.io/yeomyeonggeori/oort-postgres`) 두
   이미지를 push 하고, 각 returned digest 에 SLSA v1 provenance 를 OCI
   referrer 로 붙인 뒤에만 summary 표를 낸다. `sha-<commit>` 태그는 커밋
   locator 이지 불변 신원이 아니다.

`arm64` 재발행은 이 문서 밖이다(이슈 #1628 Out of scope). QEMU 로 arm64 를
만들지 않는다.

---

## 3. digest 수거

run summary 의 「Published release manifest」 표에서 **두 exact digest 를
함께** 가져온다. `sha-*` 태그나 로컬 retag 는 배포 권위가 아니다.

첫 공개 발행 실값 (원장 #1332 코멘트 2026-08-21, 빌드 커밋
`main=45a154d2`):

| 대상 | 불변 이미지 |
|---|---|
| 앱 | `ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb` |
| PostgreSQL 18 + pgBackRest | `ghcr.io/yeomyeonggeori/oort-postgres@sha256:c68063695bde97bb2911d5eca4ebce6a94858dc9af9f60ad294657ef7cea0757` |

attestation 검증 PASS (같은 원장). 이후 릴리스는 **그 발행의** summary 표로
이 표를 갈아끼운다. 이 문서의 표는 첫 발행 예시이지 영원히 최신이 아니다.
최신 값은 GitHub Releases 가 정본이다.

검증 (`gh` 가 있는 운영자):

```sh
APP_REF='ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb'
POSTGRES_REF='ghcr.io/yeomyeonggeori/oort-postgres@sha256:c68063695bde97bb2911d5eca4ebce6a94858dc9af9f60ad294657ef7cea0757'
gh attestation verify "oci://$APP_REF" \
  --repo yeomyeonggeori/oort \
  --predicate-type https://slsa.dev/provenance/v1
gh attestation verify "oci://$POSTGRES_REF" \
  --repo yeomyeonggeori/oort \
  --predicate-type https://slsa.dev/provenance/v1
```

플랫폼: **`linux/amd64` 단일**. Apple Silicon native pull 은 불가했다(실측
2026-08-21). 에뮬레이션 성공을 가정하지 않는다.

---

## 4. 태그 (빌드 커밋에)

태그는 **이미지가 구워진 main 커밋**에 앉힌다. 첫 릴리스:

```sh
git tag v0.1.0 45a154d2
git push origin v0.1.0
```

버전 `v0.1.0` 은 데스크탑 `0.1.0-next.N` 과 같은 0.1.0 계열이다
([§경계](#데스크탑-next-채널과의-경계)). 태그 이름에 `next-` 접두를 붙이지
않는다.

[`SECURITY.md`](../SECURITY.md) 의 「최신 발행 `v0.x` 태그 지원」 약속은 이
태그가 원격에 있는 뒤에야 실물을 얻는다.

---

## 5. GitHub Release (digest 표)

```sh
gh release create v0.1.0 \
  --notes-file docs/planning/research/2026-08-21-v0-1-0-release-notes.md
```

Release 본문에는 반드시 **digest 표**(§3과 동형)가 들어간다. 초안이 그 표와
검증 커맨드·amd64 고지를 이미 싣는다. 이후 릴리스는 같은 칸을 새 digest 로
채운 뒤 SELF_HOST 예시만 따라 고친다. 사람용 변경 이력은
[`CHANGELOG.md`](../CHANGELOG.md) — 다음 태그를 자를 때 `[Unreleased]` 를
새 버전 칸으로 옮긴다.

---

## 6. SELF_HOST 문면 갱신

[`docs/SELF_HOST.md`](SELF_HOST.md) §2-B 의 digest 예시를 이번 Release 표의
**앱** 행으로 맞춘다. 문면은 「예시 + 최신 값은 GitHub Releases」를 유지한다.
`latest` / `sha-<commit>` 를 넣지 않는다. `--published-image` 는 앱 이미지만
받는다 — postgres digest 는 Release 표와 운영/PITR 경로용이다.

셀프호스트 생성 명령은 바뀌지 않는다:

```sh
scripts/self_host_env.sh --published-image "$IMAGE_REF"
```

---

## 데스크탑 next 채널과의 경계

이 문서는 **서버/이미지** 릴리스다. 산출물은 GHCR digest 2본과 `v0.x` 태그,
GitHub Release 다.

데스크탑 Tauri 자동 업데이트는 **다른 채널**이다. 정본
[`docs/NEXT_CHANNEL.md`](NEXT_CHANNEL.md) §8:

| | 이 문서 (서버/이미지) | next 채널 (데스크탑) |
|---|---|---|
| 버전 | `v0.1.0` (`v0.x`) | `0.1.0-next.N` |
| 태그 | `v0.1.0` — **main 의 빌드 커밋** | `next-v0.1.0-next.N` |
| 저장소 | `yeomyeonggeori/oort` | `yeomyeonggeori/momo-alpha` (이 레포가 아님) |
| 발행 | `publish-images.yml` (dispatch · `release` Environment) | `scripts/publish_next_build.sh` |
| 불변 신원 | 이미지 `@sha256:` digest | minisign 서명 매니페스트 + 공증된 `.app.tar.gz` |

`0.1.0-next.N < 0.1.0` 이 semver 로 항상 성립한다. next 채널에 `0.1.0` 을
밀면 오픈 베타 번호를 태워 되돌릴 수 없다(`NEXT_CHANNEL.md` §1). 이 문서의
`v0.1.0` 은 next 매니페스트를 올리지 않고, next 발행은 GHCR digest 를
올리지 않는다. 한 커밋·한 릴리스에 두 절차를 섞지 마라.

---

## 이 문서가 하지 않는 것

- 태그/Release 의 원격 쓰기 — 오케스트레이터. 워커는 초안과 문면만.
- `linux/arm64` 재발행.
- 장기 버전 정책(semver 이후 자리).
- 운영 호스트 배포 — [`docs/runbooks/ncp-rust-deploy.md`](runbooks/ncp-rust-deploy.md).
- 셀프호스트 첫 로그인 — [`docs/SELF_HOST.md`](SELF_HOST.md).
