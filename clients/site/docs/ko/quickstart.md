---
title: 빠른 시작
description: 앱을 설치하고, 팀 서버에 들어가고, 첫 에이전트를 붙여 채널에서 부르기까지의 순서예요.
status: partial
checked: 2026-11-09
sources:
- clients/site/values.json
- clients/site/i18n/ko.json
- docs/onboarding-deeplink.md
- clients/web/src/features/welcome/firstRunGate.ts
- clients/web/src/features/welcome/firstAgent.ts
- packages/momo-core/src/features/hostedAgents/presets.ts
- packages/momo-core/src/features/agents/channelPlacement.ts
- docs/adr/0162-external-agent-reception-agent-port.md
- README.md
- docs/SELF_HOST.md
---

## 1. 앱 받기 {done}

| 기기 | 받는 곳 |
|---|---|
| Mac | [내려받기 페이지](/ko/)에서 받아요. Apple Silicon용과 Intel용이 있고, macOS 14 이상에서 돌아요. |
| iPhone | 팀에서 보낸 TestFlight 초대로 설치해요. |
| 웹 | 설치 없이 브라우저에서 열어요. |

Mac에서는 내려받은 `.dmg` 파일을 열고, oort 아이콘을 Applications 폴더에 끌어다 놓아요.

## 2. 팀 서버에 들어가기 {done}

팀에서 받은 서버 주소나 초대 링크로 들어가요. 초대 링크는 `oort://join?server=…&code=…` 모양이고, Mac 앱이 깔려 있으면 누르는 대로 앱에서 열려요.

## 3. 첫 에이전트 붙이기 {partial}

워크스페이스를 처음 만든 사람은 처음 들어와 환영 채널을 지나면 「첫 에이전트 연결」 화면을 만나요. 붙일 에이전트를 하나 골라요.

| 고르는 것 | 붙는 방식 | 상태 |
|---|---|---|
| Claude Code | 원격 MCP 서버 주소를 등록해요(Agent Port) | {partial} |
| Codex | MCP 커넥터에 원격 서버를 추가해요(Agent Port) | {partial} |
| 그록봇 | 연결 값을 발급받아 그록봇에 넣어요(Agent Port) | {partial} |
| OpenAI 호환 | AI 화면에서 이 서버의 AI 키를 붙여요 | {done} |

Agent Port는 서버 쪽은 만들어져 있지만, 실제 클라이언트와 끝까지 이어 본 확인이 아직 없어서 「부분」이에요. 이 화면을 건너뛰었다면 나중에 AI › 외부 연결에서 다시 할 수 있어요. 방식마다 자세한 내용은 [에이전트 연결](/docs/ko/agents/)에 있어요.

## 4. 채널에 넣고 부르기 {done}

에이전트는 채널에 들어가야 답해요. 에이전트를 채널에 넣은 뒤, 그 채널에서 `@핸들`로 불러요. 하는 일과 결과가 같은 채널에 올라와요.

## 서버를 직접 돌리려면 {done}

Docker와 git이 있으면 돼요. 저장소를 받고 아래 스크립트를 돌리면 설정 파일을 만들고 첫 로그인 정보를 알려 줘요.

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort && cd oort
scripts/self_host_env.sh
```

스크립트가 알려 주는 compose 명령을 돌리고, 안내하는 주소를 열어요. 공개 주소와 배포 이미지는 [`docs/SELF_HOST.md`](https://github.com/yeomyeonggeori/oort/blob/main/docs/SELF_HOST.md)에 있어요.
