# D8 그록봇 에이전트 합류 — 릴레이 킷 (성재 실행분 2-paste만 남김)

> 준비: Fable 2026-08-23. 근거: SELF_HOST_AGENT.md §3.3(합류는 pairing→handshake→승인→active 2라운드).
> Fable이 토큰 붙여넣기를 대행하지 않는 이유: 1회용 자격증명 취급 경계(계정 크레덴셜 정책).

## 성재 절차 (총 ~3분, TTL 15분 안에 1→3)

1. **연결 만들기**: 데스크탑 앱(oort-uxui-review.app, 서버 https://cursor.tailb1aad3.ts.net, owner 로그인)
   → **에이전트 → 호스티드 에이전트 연결** → 표시 이름 `Grok Bot` / 핸들 `grok` 으로 생성
   → 화면에 한 번 나오는 **「연결 값」 복사**.
2. **grok.com D8 대화에 아래 릴레이 1을 붙여넣기** (연결 값 포함).
3. 그록봇이 handshake 성공을 보고하면 위저드가 감지 상태로 바뀜 → **채널·권한 확인 후 승인**
   → 한 번 나오는 **active credential** 복사 → **릴레이 2** 붙여넣기.
4. 멘션에 에이전트 뱃지가 보이면 합류 완료. (실패 401이면 위저드 「연결 값 다시 발급」 후 릴레이 1 재전송)

## 릴레이 1 (그대로 붙여넣기, <값>만 교체)

```
팀 합류를 진행하자. 방금 데스크탑 위저드에서 연결을 만들었어.
연결 값: <여기에 연결 값>
SELF_HOST_AGENT.md §3.3대로 VM 안 루프백(터널 아님)으로 server/discover handshake를 해줘.
값은 환경 변수로만 쓰고 echo/로그/회신에 재인쇄하지 마. 성공/실패(상태코드)만 보고해줘.
```

## 릴레이 2 (승인 후)

```
승인했어. active credential: <여기에 값>
같은 엔드포인트로 active handshake를 한 번 더 해줘(첫 유효 호출이 active 증명·unpause).
값 저장·재인쇄 금지. 성공하면 general 채널에 합류 인사 한 줄 남기고,
/workspace/oort-onboarding-captures/ 에 합류 화면 캡처를 추가해줘(INDEX.md 갱신).
```

## 회수(릴레이 3 — 합류 확인 후 아무 때나)

```
/workspace/oort-onboarding-captures/ 전체(01~18 + 합류 캡처)를 이 대화에 첨부하거나
워크스페이스 파일로 노출해줘. 캡처에 비밀값이 없는지 먼저 확인하고.
```
