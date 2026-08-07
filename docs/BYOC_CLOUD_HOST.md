# 내 서버를 oort 클라우드 호스트로 붙이기 (BYOC 2단 가이드)

> **목적:** 워크스페이스 운영자가 **자기 인프라의 VM 한 대**를 oort의 T3 클라우드 호스트로
> 등록하는 절차. 2단계다 — ① 서버에 `momo-workd` 설치, ② oort가 발급한 1회용 토큰으로 등록.
> **근거:** [ADR-0142](adr/0142-t3-provider-interface-byoc.md) D1(BYOC가 기본형) ·
> [ADR-0125](adr/0125-work-host-fabric.md)(work host fabric) ·
> [ADR-0004](adr/0004-codex-oauth-hermes-provider-boundary.md)(자격증명 경계).
> **T2(내 노트북)와의 차이:** 없다시피 하다. 등록 문법이 같고, 다른 것은 `--host-type cloud`
> 한 줄과 워크스페이스 공용이라는 점뿐이다.

---

## 0. BYOC가 무엇이고 oort Cloud와 어떻게 다른가

| | **BYOC (이 문서)** | **oort Cloud (관리형)** |
|---|---|---|
| 인스턴스 생성·파괴 | **소유자(당신)** | oort의 provider 어댑터 |
| 등록 | 1회용 토큰으로 workd가 자체 등록 | 같은 흐름을 어댑터가 자동 수행 |
| 세션 배정·관찰·과금 | **동일** | **동일** |
| pause/resume | 미지원(어댑터가 그렇게 선언한다) | provider가 선언한 대로 |
| 셀프호스트 의존성 | **0** — 외부 provider 계약이 필요 없다 | 인스턴스 운영자의 provider 설정 필요 |

pause 미지원이 비용 손해가 되지는 않는다. T3 과금은 **활성 시간** 기준이라 멈춰 있는 동안은
어차피 0초로 계상된다(ADR-0136).

**한 가지 남는 소유자 책임:** BYOC 호스트를 해지할 때 그 VM과 디스크·스냅샷을 지우는 것은
당신 몫이다. oort는 당신 인프라를 지울 권한을 가진 적이 없다.

---

## 사전 조건

- oort 서버가 **HTTPS**로 떠 있고 `/health`가 green (`docs/DEPLOY.md`).
- 인스턴스에 T3가 켜져 있다: `MOMO_T3_ENABLED=1`.
  BYOC만 쓸 것이라면 provider 자격증명은 **하나도 필요 없다** — `MOMO_T3_PROVIDER`를 비워두면
  기본값이 `byoc`다.
- 붙일 VM: 아웃바운드 HTTPS만 열려 있으면 된다. **인바운드 포트를 열지 않는다.**
  workd는 listener를 만들지 않고 oort REST를 폴링한다.
- 당신은 그 워크스페이스의 **owner 또는 admin**이다.

---

## 1단계 — 서버에 `momo-workd` 설치

대상 VM의 OS/아키텍처에 맞는 바이너리를 빌드한 뒤, SSH로 복사·설치한다.
설치는 사용자 서비스(systemd `--user` 또는 launchd)로 들어간다.

```sh
# 로컬(빌드 머신)에서 — 대상 플랫폼용 릴리스 빌드
swift build -c release --package-path workers/WorkHostDaemon

# 아직 등록 토큰이 없으므로, 이 단계는 복사/설치만 검증한다
infra/workd/bootstrap.sh ssh://ops@vm.example.com \
  --binary workers/WorkHostDaemon/.build/release/momo-workd \
  --server-url https://momo.example.com \
  --workspace 00000000-0000-7000-8000-000000000001 \
  --scope workspace \
  --host-type cloud \
  --display-name "seoul-vm-1" \
  --dry-run
```

`--dry-run`이 계획을 출력하면 1단계 준비는 끝났다. 실제 설치는 2단계에서 토큰과 함께 한 번에
수행한다(토큰 파일이 있어야 등록까지 이어지기 때문이다).

---

## 2단계 — 1회용 토큰 발급 → 등록

### 2-1. oort에서 등록 토큰을 받는다

워크스페이스 admin/owner의 access token으로 호출한다. `idempotencyRef`는 클라이언트가 만드는
UUID다 — 응답을 잃어버렸을 때 같은 ref로 재시도해도 호스트가 두 개 생기지 않는다.

```sh
curl -fsS -X POST \
  "https://momo.example.com/v1/workspaces/$WORKSPACE_ID/work-hosts/byoc/enrollments" \
  -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg ref "$(uuidgen)" \
    '{displayName:"seoul-vm-1",scope:"workspace",idempotencyRef:$ref}')" \
  | jq -r '.enrollment.bootstrapToken' > registration.token
chmod 600 registration.token
```

> **토큰은 한 번만 보인다.** oort는 SHA-256 다이제스트만 저장하므로 다시 보여줄 수 없다.
> 같은 `idempotencyRef`로 재요청하면 409로 거절된다 — 새 ref로 다시 발급받아라.
> 유효기간은 응답의 `bootstrapExpiresAtMs`에 있다.

### 2-2. 토큰과 함께 설치·등록한다

```sh
infra/workd/bootstrap.sh ssh://ops@vm.example.com \
  --binary workers/WorkHostDaemon/.build/release/momo-workd \
  --server-url https://momo.example.com \
  --workspace "$WORKSPACE_ID" \
  --scope workspace \
  --host-type cloud \
  --display-name "seoul-vm-1" \
  --token-file registration.token
```

workd는 부팅하면서 자기 **Ed25519 키쌍을 스스로 만들고**, 공개키만 oort에 올린 뒤 토큰 파일을
지운다. 이후 모든 요청은 그 개인키로 서명된다. 개인키는 그 VM을 떠나지 않는다.

```sh
# 발급에 쓴 로컬 사본도 지운다
rm -f registration.token
```

### 2-3. 붙었는지 확인

```sh
curl -fsS "https://momo.example.com/v1/workspaces/$WORKSPACE_ID/work-hosts" \
  -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  | jq '.workHosts[] | select(.type=="cloud") | {id, displayName, lastSeenAtMs}'
```

`lastSeenAtMs`가 갱신되고 있으면 등록 완료다. 이후는 T2 호스트와 완전히 같다 — 채널에서 작업
세션을 만들 때 이 호스트를 고르면 된다.

---

## 3. 잘 안 될 때

| 증상 | 원인과 조치 |
|---|---|
| enrollment 요청이 **503** | 인스턴스에 T3가 꺼져 있다. `MOMO_T3_ENABLED=1`로 켜고 서버를 재기동한다. |
| enrollment 요청이 **400** | `scope`에 `workspace` 외의 값을 넣었다. 개인 BYOC는 아직 열려 있지 않다(ADR-0142 D1). |
| enrollment 요청이 **409** | 그 `idempotencyRef`는 이미 토큰을 한 번 내줬다. 새 UUID로 다시 요청한다. |
| bootstrap이 `host type must be workd or cloud` | `--host-type` 오타. |
| bootstrap이 `use --scope workspace` | BYOC는 워크스페이스 공용만 지원한다. |
| register가 **401** | 토큰이 만료됐거나 이미 소비됐다. 새 ref로 재발급한다. |
| 호스트가 곧 offline으로 뒤집힌다 | VM의 아웃바운드 HTTPS가 막혔거나 서비스가 죽었다. `systemctl --user status momo-workd`(또는 `launchctl print`)를 본다. |

---

## 4. 신뢰 경계 (읽고 넘어가라)

BYOC 호스트의 `momo-workd`는 **당신의 인프라에서 돕니다.** oort는 그 머신의 무결성을 보증할 수
없다 — T2(개인 노트북 호스트)와 정확히 같은 신뢰 수준이다. 새로 생긴 위험이 아니라, 원래
있던 위험을 명문화한 것이다(ADR-0142 Consequences).

- 그 VM에서 실행되는 도구는 그 VM의 자격증명을 본다. oort는 provider 자격증명을 호스트로
  내려보내지 않는다(ADR-0004).
- 도구의 stdout/stderr는 호스트 로컬(`~/.local/share/momo/workd-output/`, mode 0600)에 남고
  oort 서버로 전송되지 않는다.
- 호스트를 해지하면 oort는 자기 쪽 바인딩(work_host 행)만 회수한다. **VM·디스크·스냅샷 삭제는
  당신이 해야 한다.**
