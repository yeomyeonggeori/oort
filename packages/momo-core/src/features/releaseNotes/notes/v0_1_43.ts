import type { ReleaseNote } from "../model";

// =============================================================================
// 업데이트 소식 v0.1.43 (#5415, 글은 사전으로 #5054). 승격 때 통합자가 이 모양의 파일을 새 릴리스마다 하나씩 쓴다
// (순서는 `notes/README.md`, 등록은 `notes/index.ts`).
//
// 이 파일에는 글이 없다: 번호·빌드·**사전 키 목록**이다. 글(ko·en)은 `i18n/catalogs/{ko-KR,en-US}/releaseNotes.json`의
// `releaseNotes.v0143.…` 키에 있다. 키 이름 규칙은 `model.test.ts`의 등록부 시험이 잰다.
//
// 근거: 지난 승격(2026-11-04, sync 01f930277) 뒤 track/engine에 착륙한 PR(2026-11-06 02시 무렵 43건)에서 sync·발행 기록 3건을 빼고
// 40건을 읽어, 사용자에게 보이는 28건을 골랐다(서버 몫 #5363 #5399 포함). 싣지 않은 12건: 설계·결정 문서 #5387 #5388 #5398 #5404
// (그룹 DM과 도우미의 Hermes 호출은 설계만 들어갔고 아직 보이지 않는다), 서버·보안·운영 #5335 #5336 #5351 #5355 #5361 #5366 #5368,
// 빌드 도구 #5379. 소식 창 자신의 「더 보기」 낱말·크기 수리(#5402 #5378의 일부)도 싣지 않았다. 항목마다 고른 PR 묶음:
//   1. phoneSearch: #5385 #5397 #5410 #5414
//   2. agentThreads: #5406 #5405 (채널의 답과 승인 카드·작업 줄은 서버 몫 #5406이 트리거 아래 스레드로 보낸다)
//   3. phoneDelay: #5411 (서버 몫 #5363 #5399, 기본 1분은 서버가 저장된 값이 없을 때 읽는 값 `DEFAULT_PHONE_DELAY_SECS`)
//   4. quoteCard: #5409 #5380
//   5. quietConnection: #5408 #5413
//   6. editMessage: #5337
//   7. composerPicker: #5343 #5350
//   8. menuBarPlanet: #5386
// 그 밖에 바뀐 점(others)은 위 항목에 못 든 변화를 주제별 한 줄로 썼다:
//   search(폰 검색): #5385 #5410 #5414
//   conversations(대화): #5341 #5354 #5409
//   attachments(첨부): #5349
//   expressions(표현): #5350
//   notifications(알림): #5346 #5356 #5347
//   agents(에이전트): #5402
//   network(연결): #5352 #5378
//   phone(폰): #5344 #5412
//   desktop(데스크탑): #5349 #5378 #5341
// 핵심 항목은 8개이고 앞이 더 중요하다(바뀐 기본값이 모두에게 닿는 폰 알림 늦추기를 셋째로 올렸다). 문장은 해요체이고, 말하는 화면
// (`surfaces`)은 폰·데스크탑이다(브라우저 탭은 데스크탑과 같은 화면이다). 설정 칸이 데스크탑에만 있는 폰 알림 늦추기와, 맥에만 있는
// 메뉴 막대 아이콘은 데스크탑으로, 검색 화면은 폰으로 나눴다. 이전 소식이 알린 것을 이번에 거둔 세 가지는 글에 말했다:
// 「대화에도 보내기」(v0.1.42 대화 줄)와 「답함 ✓」 칩은 없어졌고, 표현 고르개의 이름은 「이모티콘」 하나로 모였다.
//
// 번호: 지금 빌드 기록은 증거 빌드 11-04의 iOS 3059(#2568 코멘트: 업로드·`momo-internal-test` 배정 2026-11-05 11:59 KST,
// `ios-latest.json` latest_build 3058 → 3059)다. 그 빌드는 v0.1.42 소식을 담았으므로 이 소식을 처음 담을 다음 폰 빌드의 번호는 3060
// 이상이다. `phoneBuild`는 3059보다 크고 그 빌드가 받을 번호 이하여야 한다(빌드를 만든 뒤에 고치면 그 빌드는 옛 값을 갖는다).
// `desktopFrom`에는 release 채널 `0.1.43`만 적었다: 다음 채널 빌드가 이 소식을 담게 되면 `0.1.0-next.N`을 더하는 것은 승격 때
// 통합자의 일이다.
// =============================================================================

export const RELEASE_NOTE_0_1_43: ReleaseNote = {
  version: "0.1.43",
  releasedOn: "2026-11-07",
  phoneBuild: 3060,
  // release 채널은 0.1.43. 다음 채널 번호는 승격 커밋에서 만드는 팀 설치 빌드가 정해지면 통합자가 더한다.
  desktopFrom: ["0.1.43"],
  summary: "releaseNotes.v0143.summary",
  items: [
    {
      id: "phoneSearch",
      surfaces: ["phone"],
      title: "releaseNotes.v0143.phoneSearchTitle",
      changed: "releaseNotes.v0143.phoneSearchChanged",
      tryIt: "releaseNotes.v0143.phoneSearchTryIt",
    },
    {
      id: "agentThreads",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0143.agentThreadsTitle",
      changed: "releaseNotes.v0143.agentThreadsChanged",
      tryIt: "releaseNotes.v0143.agentThreadsTryIt",
    },
    {
      id: "phoneDelay",
      surfaces: ["desktop"],
      title: "releaseNotes.v0143.phoneDelayTitle",
      changed: "releaseNotes.v0143.phoneDelayChanged",
      tryIt: "releaseNotes.v0143.phoneDelayTryIt",
    },
    {
      id: "quoteCard",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0143.quoteCardTitle",
      changed: "releaseNotes.v0143.quoteCardChanged",
      tryIt: "releaseNotes.v0143.quoteCardTryIt",
    },
    {
      id: "quietConnection",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0143.quietConnectionTitle",
      changed: "releaseNotes.v0143.quietConnectionChanged",
      tryIt: "releaseNotes.v0143.quietConnectionTryIt",
    },
    {
      id: "editMessage",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0143.editMessageTitle",
      changed: "releaseNotes.v0143.editMessageChanged",
      tryIt: "releaseNotes.v0143.editMessageTryIt",
    },
    {
      id: "composerPicker",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0143.composerPickerTitle",
      changed: "releaseNotes.v0143.composerPickerChanged",
      tryIt: "releaseNotes.v0143.composerPickerTryIt",
    },
    {
      id: "menuBarPlanet",
      surfaces: ["desktop"],
      title: "releaseNotes.v0143.menuBarPlanetTitle",
      changed: "releaseNotes.v0143.menuBarPlanetChanged",
      tryIt: "releaseNotes.v0143.menuBarPlanetTryIt",
    },
  ],
  others: [
    {
      id: "search",
      title: "releaseNotes.v0143.searchTopic",
      lines: [
        "releaseNotes.v0143.searchLine1",
        "releaseNotes.v0143.searchLine2",
        "releaseNotes.v0143.searchLine3",
      ],
    },
    {
      id: "conversations",
      title: "releaseNotes.topic.conversations",
      lines: [
        "releaseNotes.v0143.conversationsLine1",
        "releaseNotes.v0143.conversationsLine2",
        "releaseNotes.v0143.conversationsLine3",
      ],
    },
    {
      id: "attachments",
      title: "releaseNotes.topic.attachments",
      lines: ["releaseNotes.v0143.attachmentsLine1", "releaseNotes.v0143.attachmentsLine2"],
    },
    {
      id: "expressions",
      title: "releaseNotes.v0143.expressionsTopic",
      lines: ["releaseNotes.v0143.expressionsLine1"],
    },
    {
      id: "notifications",
      title: "releaseNotes.topic.notifications",
      lines: ["releaseNotes.v0143.notificationsLine1", "releaseNotes.v0143.notificationsLine2"],
    },
    {
      id: "agents",
      title: "releaseNotes.topic.agents",
      lines: ["releaseNotes.v0143.agentsLine1", "releaseNotes.v0143.agentsLine2"],
    },
    {
      id: "network",
      title: "releaseNotes.v0143.networkTopic",
      lines: [
        "releaseNotes.v0143.networkLine1",
        "releaseNotes.v0143.networkLine2",
        "releaseNotes.v0143.networkLine3",
        "releaseNotes.v0143.networkLine4",
      ],
    },
    {
      id: "phone",
      title: "releaseNotes.v0143.phoneTopic",
      lines: ["releaseNotes.v0143.phoneLine1", "releaseNotes.v0143.phoneLine2"],
    },
    {
      id: "desktop",
      title: "releaseNotes.v0143.desktopTopic",
      lines: [
        "releaseNotes.v0143.desktopLine1",
        "releaseNotes.v0143.desktopLine2",
        "releaseNotes.v0143.desktopLine3",
      ],
    },
  ],
};
