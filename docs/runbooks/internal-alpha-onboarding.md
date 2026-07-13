# 10인 내부 알파 온보딩 (운영자 1페이지)

> 운영자: 성재 · 전제: AWS 배포/헬스 PASS, 승인된 macOS artifact와 checksum 준비.
> invite raw code와 access token은 bearer secret이다. `set -x`, 채팅방 일괄 게시,
> 로그·티켓 첨부를 금지한다.

## 1. owner 로그인과 public channel 2개 이상 생성

실제 owner 정보는 shell history에 남기지 않는다.

```bash
export BASE_URL='https://alpha-api.example.com'
export WORKSPACE_ID='<workspace UUID>'
read -rp 'Owner email: ' OWNER_EMAIL
read -rsp 'Owner password: ' OWNER_PASSWORD; echo
ACCESS_TOKEN="$(jq -n --arg email "$OWNER_EMAIL" --arg password "$OWNER_PASSWORD" \
  --arg workspace "$WORKSPACE_ID" '{email:$email,password:$password,workspace:$workspace}' \
  | curl -fsS -X POST "$BASE_URL/v1/auth/login" -H 'Content-Type: application/json' -d @- \
  | jq -er '.accessToken')"
unset OWNER_PASSWORD

for CHANNEL in general agent-lab; do
  jq -n --arg name "$CHANNEL" '{kind:"public",name:$name,topic:"internal alpha"}' \
  | curl -fsS -X POST "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels" \
      -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H 'Content-Type: application/json' -d @- \
  | jq -e '.channel | {id,name,kind}'
done

curl -fsS "$BASE_URL/v1/workspaces/$WORKSPACE_ID/channels" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq -e '.channels | map({id,name,kind})'
```

이미 존재하면 중복 생성하지 말고 목록에서 public channel이 2개 이상인지 확인한다.
`general`은 공지/지원, `agent-lab`은 Hermes 실험 채널로 사용한다.

## 2. 테스터별 invite code 발급

한 사람당 `maxUses=1`, 짧은 만료시간으로 별도 발급한다. raw `code`는 create 응답에
한 번만 나타나므로 즉시 해당 사람에게 1:1로 전달하고 shell 변수를 지운다.

```bash
EXPIRES_AT_MS="$(python3 -c 'import time; print(int((time.time()+3*86400)*1000))')"
read -rp 'Tester label (no sensitive data): ' TESTER_LABEL
INVITE_RESPONSE="$(jq -n --argjson expires "$EXPIRES_AT_MS" --arg label "$TESTER_LABEL" \
  '{role:"member",maxUses:1,expiresAtMs:$expires,metadata:{operatorLabel:$label}}' \
  | curl -fsS -X POST "$BASE_URL/v1/workspaces/$WORKSPACE_ID/invites" \
      -H "Authorization: Bearer $ACCESS_TOKEN" \
      -H 'Content-Type: application/json' -d @-)"
INVITE_CODE="$(printf '%s' "$INVITE_RESPONSE" | jq -er '.code')"
printf 'Deliver this code once via approved 1:1 channel: %s\n' "$INVITE_CODE"
unset INVITE_CODE INVITE_RESPONSE TESTER_LABEL
```

위 블록을 각 테스터에게 반복한다. 분실·오발송한 코드는 목록에서 invite id를 찾고
즉시 revoke한 뒤 새로 만든다.

```bash
curl -fsS "$BASE_URL/v1/workspaces/$WORKSPACE_ID/invites?include_revoked=true" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.invites'
curl -fsS -X POST "$BASE_URL/v1/workspaces/$WORKSPACE_ID/invites/<invite-id>/revoke" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"delivery-error"}' | jq .
```

## 3. 앱 안내문

각 테스터에게 승인된 1:1 배포 채널로 다음 네 가지를 보낸다.

1. 승인된 macOS artifact 링크, build/commit, SHA-256 checksum
2. Server URL(`BASE_URL`)과 개인 invite code
3. 앱 session chooser의 **Join with invite**에서 email, display name, 새 password,
   invite code를 입력하라는 안내
4. `#general` 지원 채널과 장애 보고 형식(시각·화면·재현 단계; token/개인정보 제외)

가입 후 `general`과 `agent-lab`이 보이고 메시지 송수신이 되는지 확인한다. public
invite로 owner/platform admin 권한을 줄 수 없다. 계정·초대 코드를 서로 공유하지 않는다.

## 4. Hermes 사용·승인 규칙

- Hermes는 사람 invite가 아니라 앱의 **Members + → Invite Agent** pairing으로 만들고
  `agent-lab`에만 초대한다. 운영자가 scoped credential을 1회 발급한다.
- `@hermes`를 명시해 요청한다. password, API key, access token, 개인/고객 데이터는
  prompt에 넣지 않는다.
- 도구 실행에 승인이 필요하면 run은 pause되고 Approval inbox에 나타난다. 요청 주체,
  대상, 변경/비용 범위를 읽고 의도한 작업만 **Approve**한다. 불명확하거나 범위가 큰
  요청은 **Reject**하고 채널에서 조건을 좁혀 다시 요청한다.
- 승인/거부 뒤 gateway가 같은 run을 resume해 최종 channel message를 남길 때까지
  기다린다. `agent.status`/partial은 진행 표시이고, durable 최종 권위는
  `message.seq`가 있는 channel message다. 멈춘 것처럼 보여도 중복 승인하거나 같은
  작업을 반복 전송하지 말고 `#general`에 run 시각과 증상을 보고한다.

## 5. 운영자 종료 확인

- [ ] public channel 2개 이상, 10명 명단과 개인 invite 상태 확인
- [ ] 10명 모두 앱 checksum 확인, join/login, 메시지 송수신 PASS
- [ ] `@hermes` 일반 왕복과 approval approve/reject 각 1회 PASS
- [ ] open P0/P1은 즉시 배포 중단·triage, diagnostics는 redaction 후 보관
- [ ] 작업이 끝나면 `unset ACCESS_TOKEN OWNER_EMAIL WORKSPACE_ID BASE_URL`

Non-goals: iOS 배포, 무중단 배포, split 토폴로지, 테스터 셀프 서비스 agent 생성.
