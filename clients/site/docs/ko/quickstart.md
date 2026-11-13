---
title: 빠른 시작
description: 앱을 설치하고, 팀 서버에 들어가고, 첫 에이전트를 연결해 채널에서 부르기까지의 순서예요.
status: partial
checked: 2026-11-09
sources:
- clients/site/values.json
- clients/site/i18n/ko.json
- clients/desktop/src-tauri/tauri.conf.json
- docs/onboarding-deeplink.md
- clients/web/src/features/welcome/firstRunGate.ts
- clients/web/src/features/welcome/FirstAgentStage.tsx
- clients/web/src/features/welcome/AiConnectList.tsx
- packages/momo-core/src/features/onboarding/aiConnect.ts
- packages/momo-core/src/features/hostedAgents/presets.ts
- docs/adr/0198-agents-vs-harnesses-work-request-routing.md
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

## 3. 첫 에이전트 연결하기 {partial}

처음 들어오면 환영 채널 다음에 「누구의 AI로 생각할까요?」 화면이 나와요. 에이전트 연결은 관리자가 해요. 관리자가 아니면 목록 대신 「에이전트 연결은 관리자가 해요.」가 보이고, 대화는 바로 시작할 수 있어요.

화면에는 이 순서로 항목이 나와요.

| 항목 | 연결 방법 | 부를 수 있는 사람 | 상태 |
|---|---|---|---|
| API 키 · 팀 에이전트 | 「API 키로 연결하기」를 눌러 AI 화면에서 OpenAI 호환 API 키를 넣어요 | 팀 누구나 | {done} |
| 그록봇 | 「그록봇 초대하기」를 눌러 주소와 연결 값을 발급받고, 그록봇에게 전해요 | 팀 | {partial} |
| Claude Code · 내 도구 | 이 맥에서 로그인한 CLI를 개인 에이전트로 켜요 | 나만 | {partial} |
| Codex · 내 도구 | 이 맥에서 로그인한 CLI를 개인 에이전트로 켜요 | 나만 | {partial} |

- 「내 도구」 두 항목은 데스크탑 앱에서, 서버가 허용할 때만 보여요. 웹에서는 그 자리에 「데스크탑 앱에서 이 맥의 Claude Code·Codex를 붙일 수 있어요.」가 보여요.
- 「내 도구」 항목은 CLI가 설치되고 로그인돼 「준비됨」일 때만 고를 수 있어요.
- 건너뛰어도 나중에 AI 화면에서 이어갈 수 있어요.

그록봇은 Agent Port로, 「내 도구」는 내 맥의 작업 호스트로 연결돼요. 자세한 내용은 [에이전트 연결](/docs/ko/agents/)에 있어요.

## 4. 채널에 넣고 부르기 {done}

에이전트는 채널에 들어가야 답해요. 에이전트를 채널에 넣은 뒤, 그 채널에서 `@핸들`로 불러요. 진행 상황과 결과가 같은 채널에 올라와요.

## 서버를 직접 돌리려면 {done}

Docker와 git이 있으면 돼요. 저장소를 받고 아래 스크립트를 돌리면 설정 파일을 만들고 첫 로그인 정보를 알려 줘요.

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort && cd oort
scripts/self_host_env.sh
```

스크립트가 알려 주는 compose 명령을 돌리고, 안내하는 주소를 열어요. 공개 주소와 배포 이미지는 [`docs/SELF_HOST.md`](https://github.com/yeomyeonggeori/oort/blob/main/docs/SELF_HOST.md)에 있어요.
