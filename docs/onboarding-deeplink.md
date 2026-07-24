# 초대 딥링크 계약 (`momo://join`) — 정본

> 온보딩 와우 배치(W-O1, `docs/planning/2026-07-24-onboarding-wow-audit.md`). 이 파일이 딥링크 형식의 **정본**이며, 서버/운영(MOMO-584)과 macOS/iOS 클라이언트(MOMO-585)가 글자 그대로 일치해야 한다.

## 형식

```
momo://join?server=<percent-encoded base URL>&code=<invite code>
```

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
# momo://join?server=https%3A%2F%2Fapi.example.com&code=<code>
```

- base URL 기본값은 운영 env의 `PUBLIC_BASE_URL`(공개 HTTPS origin). `--server-url URL`로 명시 지정 가능(내부 알파 mDNS 호스트 등).
- **코드 원문 노출 정책:** bearer 코드 원문은 여전히 mode-0600 파일로만 기록하고 컨테이너 argv/DB 경로에 값으로 흘리지 않는다. 딥링크는 운영자가 신규 멤버에게 전달하는 산출물이므로 코드를 담은 채 stdout 출력이 허용된다(코드는 링크 안에서만 등장).

## 소비 (클라이언트, MOMO-585)

- `momo://` URL 스킴을 등록(`clients/macOS/XcodeHost/Info.plist` `CFBundleURLTypes`)하고 `onOpenURL`에서 파싱한다.
- 세션 연결 전: chooser의 초대 참여 경로로 `server`·`code`를 **프리필**한다(사용자는 이름/비밀번호만 입력).
- 세션 연결 후: 무시하고 안내 배너 정도로 처리한다.
- 잘못된 링크/인코딩/부분 파라미터는 조용히 무시하거나 검증 오류로 처리한다(순수 파싱 로직 단위테스트 대상).
