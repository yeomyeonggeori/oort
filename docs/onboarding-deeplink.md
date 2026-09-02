# 온보딩 딥링크 계약 (`oort://join` · `oort://link`) — 정본

> 온보딩 와우 배치(W-O1, `docs/planning/2026-07-24-onboarding-wow-audit.md`). 이 파일이 딥링크 형식의 **정본**이며, 서버/운영(MOMO-584)과 macOS/iOS 클라이언트(MOMO-585)가 글자 그대로 일치해야 한다.

## 형식

```
oort://join?server=<percent-encoded base URL>&code=<invite code>
```

### 스킴 (goal B13 — momo → oort 리브랜딩)

- **발급은 `oort://`만.** `momo-ops.sh`·웹 초대 카드·mac 초대 카드가 모두 이 스킴으로 만든다.
- **소비는 `oort://`와 `momo://` 둘 다.** 초대는 메일·메신저로 건네지고 며칠씩 살아 있다. 보낼 때 올바르던 링크가 제품 이름이 바뀌었다는 이유로 안 열리는 것은 아무에게도 이득이 없으므로, 구 스킴은 **무시가 아니라 흡수**한다. OS 등록도 두 스킴을 함께 유지한다(`tauri.conf.json`, macOS/iOS `Info.plist`).
- 레포·크레이트·바이너리 이름은 계속 `momo`다. 바뀐 것은 **사람이 보는 표면뿐**이다.
- 이와 별개인 것: `momo://workspaces/…` 형태의 **내부 리소스 URI**(에이전트 컨텍스트 패킷의 `source_attribution.uri`, MCP `uriTemplate`). 딥링크가 아니라 내부 식별자이고 Swift↔Rust 픽스처가 글자 단위로 고정하고 있어 이 배치에서 건드리지 않는다.

- 쿼리 파라미터는 **`server`와 `code` 둘뿐**이다.
- **순서 무관.** `code`가 먼저 와도 동일하게 해석한다.
- **알 수 없는 파라미터는 무시**한다(하위 호환 여지).

### `server`
- 값은 API base URL을 **percent-encoding**한 것이다(RFC 3986). 예: `https://api.example.com` → `https%3A%2F%2Fapi.example.com`.
- 인코딩은 unreserved 집합(`A-Z a-z 0-9 - . _ ~`)만 그대로 두고 나머지(`:`, `/`, `:` 포트 구분자 등)를 `%XX`로 바꾼다.
- 클라이언트는 percent-decoding 후 기존 `validatedBaseURL()` 규칙(scheme + host 존재)으로 **재검증**한다. 이 base URL은 mDNS TXT 레코드 키 `base`(W-O2, `_momo._tcp`)와 동일한 의미의 값이다.

### `code`
- 워크스페이스 초대 bearer 코드(운영 발급 시 base64url, `[A-Za-z0-9-_]`)이다. base64url 문자는 전부 unreserved라 percent-encoding 후에도 값이 그대로다.

## 발급 (서버/운영, MOMO-584)

`infra/prod/momo-ops.sh invite-create`가 초대를 만들고 완성된 딥링크를 stdout에 출력한다.

```bash
sops exec-env /secure/momo/prod.sops.env \
  'infra/prod/momo-ops.sh invite-create --from-env \
   --workspace-id <WORKSPACE_UUID> \
   --role member --max-uses 1 --expires-days 7 \
   --output /run/momo/invite-code'
# stdout 마지막 줄:
# oort://join?server=https%3A%2F%2Fapi.example.com&code=<code>
```

- base URL 기본값은 운영 env의 `PUBLIC_BASE_URL`(공개 HTTPS origin). `--server-url URL`로 명시 지정 가능(내부 알파 mDNS 호스트 등).
- **코드 원문 노출 정책:** bearer 코드 원문은 여전히 mode-0600 파일로만 기록하고 컨테이너 argv/DB 경로에 값으로 흘리지 않는다. 딥링크는 운영자가 신규 멤버에게 전달하는 산출물이므로 코드를 담은 채 stdout 출력이 허용된다(코드는 링크 안에서만 등장).

## 소비 (클라이언트, MOMO-585)

- `oort://`와 `momo://` URL 스킴을 **둘 다** 등록(`clients/macOS/XcodeHost/Info.plist` `CFBundleURLTypes`)하고 `onOpenURL`에서 파싱한다.
- 세션 연결 전: chooser의 초대 참여 경로로 `server`·`code`를 **프리필**한다(사용자는 이름/비밀번호만 입력).
- 세션 연결 후: 무시하고 안내 배너 정도로 처리한다.
- 잘못된 링크/인코딩/부분 파라미터는 조용히 무시하거나 검증 오류로 처리한다(순수 파싱 로직 단위테스트 대상).

## `oort://link` — 기기 연결 (ADR-0180)

이미 로그인한 사람의 **두 번째 기기**를 붙인다. `join` 이 새 계정을 만드는 것과 달리, 링크 토큰은 자격이 아니라 **교환권**이다 — 그 자체로는 어떤 API 도 호출할 수 없고, `POST /v1/auth/device-link/redeem` 한 번만 소비된다.

### 형식

```
oort://link?server=<percent-encoded base URL>&token=<base64url>
```

- 쿼리 파라미터는 **`server`와 `token` 둘뿐**이다.
- **순서 무관.** `token` 이 먼저 와도 동일하게 해석한다.
- **알 수 없는 파라미터는 무시**한다(하위 호환 여지).
- 스킴 소비는 `join` 과 같다: **발급은 `oort://`만**, 소비는 `oort://`와 `momo://` 둘 다 흡수.

### `server`

`join` 의 `server` 와 같다. API base URL 을 RFC 3986 percent-encoding 한 값. 클라가 percent-decoding 후 `validatedBaseURL()` 로 재검증한다.

### `token`

32바이트 CSPRNG 의 base64url(패딩 없음, 43자, `[A-Za-z0-9-_]`). unreserved 집합이라 percent-encoding 후에도 값이 그대로다. **원문은 발급 응답에만** 실리고 서버는 sha256 만 저장한다(ADR-0180 D1/D6).

### 발급 / 소비

- 발급: 인증된 사람 멤버가 `POST /v1/auth/device-link` (TTL 120s, 1회).
- 소비: 폰이 `POST /v1/auth/device-link/redeem` (공개, per-IP 레이트리밋). 공개 오리진 모드에서는 4자리 SAS 를 발급자 확인 후에야 세션이 활성화된다(D4).
