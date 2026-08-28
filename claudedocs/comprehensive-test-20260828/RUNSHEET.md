# 종합 실테스트 실행 시트 (2026-08-28)

> 정본 패킷: `docs/planning/handoffs/2026-08-28-comprehensive-test-packet.md`
> 준비 체인 상태(오케스트레이터 스탬프, 2026-08-28 오후):
> ① v0.1.3 발행 ✅ (main=4d3085ad · 앱 `e0faed22…4868` · pg `49a589bd…d071` · attestation verify 2본 PASS)
> ② #1837 문면 현행화 ✅ (PR #1841 머지·정본화 완료)
> ③ VM 갱신 ✅ (그록봇 릴레이 6항 전부 성공 — pin 교체·데이터 볼륨 유지·허들 배선 5종 보존, CSP 파일=`infra/rust/Caddyfile.local` 호스트 파일이라 재적용 불요)
>    외부 검증(오케스트레이터 실측): /healthz 200 · CSP에 `wss://<host>:10000` 잔존 · 시그널 :10000 → 200 · TURN 8443 TLS verify 0 (LE) · **새 번들 서빙 실증**(`assets/index-BNjBOJpU.js`에 8443 리라이트 상수+roleLabel 마커)
> ④ 검수 앱 ✅ (`~/Desktop/oort-uxui-review.app`, 빌드 원본 main=4d3085ad, 13:31 교체)
>
> 남은 준비 = ⑤ 자격 발급(아래 시트, owner 로그인 1회) — 이후 S1~S5 실행 가능.

호스트(전 시나리오 공통): `https://cursor.tailb1aad3.ts.net`

## ⑤ 자격 발급 시트 (성재, ~2분)

브라우저로 위 호스트 접속 → owner 로그인 → 설정>계정에서 워크스페이스 UUID,
명부에서 에이전트(그록봇) 멤버 UUID, 테스트 채널 UUID 확보 후 로컬 터미널에서:

```sh
OORT=https://cursor.tailb1aad3.ts.net
WS='<워크스페이스 UUID>'
AGENT='<에이전트 멤버 UUID>'

HUMAN=$(curl -sS -X POST "$OORT/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"<owner 이메일>\",\"password\":\"<owner 비번>\",\"workspace\":\"$WS\"}" \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

curl -sS -X POST "$OORT/v1/workspaces/$WS/agents/$AGENT/credentials" \
  -H "Authorization: Bearer $HUMAN" -H 'Content-Type: application/json' \
  -d '{"label":"comp-test","scopes":["messages:write","messages:read"]}'
```

응답의 `token` 한 줄만 Fable에게 전달(채팅 — 레포 비유입). 에이전트가 테스트
채널에 초대돼 있는지도 이때 확인.

## S1 허들 (성재 폰 + Fable 맥, SPIKE-HD 4·5·6 승계)

1. **S1-a (Fable 선행)**: 외부 망 브라우저로 허들 참여 → `chrome://webrtc-internals`에서
   ICE 서버에 `turns:cursor.tailb1aad3.ts.net:8443?transport=tcp` (리라이트 발동) +
   candidate pair=`relay/tls` 확인. → 통과 시 성재 호출.
2. **S1-b (성재, ~3분)**: 폰 Wi-Fi 끄고 LTE → 호스트 접속·로그인 → Fable이 지정한
   채널의 허들 참여 → 상호 음성 확인.
3. **S1-c (Fable)**: 60분 soak 관측 루프(1001 드롭 재현 여부, #18827 대조).
4. PASS: relay/tls 성립 + 양방향 오디오 + soak 결과 기록.

## S2 터미널 관전 (성재 데스크탑 검수 앱)

1. 그록봇(에이전트) 작업 콘솔 세션 개시(Fable이 릴레이로 유도 가능).
2. 검수 앱에서 관전 도크 attach → 라이브 출력 확인 (#1777 remote_attach 수리 검증).
3. 소유자 관전차단 토글 on(관전 불가)→off(복귀) — 400 재현 없음 (#1778 검증).
4. PASS: attach 성립 + 토글 왕복 + 도크 UI 정상.

## S3 그록봇 연동 (+#1785 ACP)

1. 테스트 채널에서 그록봇 멘션 → 응답 왕복(실시간 레일).
2. Fable이 ACP 이벤트 기록 실존 확인(멱등·outbox 경유).
3. PASS: 왕복 + 이벤트 기록.

## S4 외부 도구 이중 (Fable 대행 가능 — ⑤ 토큰 필요)

| 호출 | 기대 |
|---|---|
| POST 채널 메시지 | 201 (에이전트 이름 게시) |
| GET 채널 히스토리 | **200** (#1820) |
| GET 스레드 replies | **200** |
| GET 단일 메시지 | 403 |
| POST replies | 403 |

## S5 UXUI 스팟 (성재 자유 검수 — 검수 앱)

- role_labels 편집(설정>워크스페이스): operator만·한글 16자·빈값=기본 복원·비운영자 대비 뷰.
- 허들 UI·컴포저·스레드·사이드바 buzz 파도 스팟.
- 피드백은 전량 티켓화(즉흥 수리 금지).

## 기록
- 증거는 이 디렉토리(`claudedocs/comprehensive-test-20260828/`)에 적재. 시크릿 비유입.
- 종료 시: #1825 실검증 이월분 종결 코멘트 + SPIKE-HD REPORT 4·5·6 갱신 + 발견 결함 티켓화.
