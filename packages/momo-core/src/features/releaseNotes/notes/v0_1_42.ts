import type { ReleaseNote } from "../model";

// =============================================================================
// 업데이트 소식 v0.1.42 (#5277, 글은 사전으로 #5054). 승격 때 통합자가 이 모양의 파일을 새 릴리스마다 하나씩 쓴다
// (순서는 `notes/README.md`, 등록은 `notes/index.ts`).
//
// 이 파일에는 글이 없다: 번호·빌드·**사전 키 목록**이다. 글(ko·en)은 `i18n/catalogs/{ko-KR,en-US}/releaseNotes.json`의
// `releaseNotes.v0142.…` 키에 있다. 키 이름 규칙은 `model.test.ts`의 등록부 시험이 잰다.
//
// 근거: 지난 승격(2026-10-31 19:33 KST) 뒤 track/engine에 착륙한 PR(2026-11-03 21시 무렵 149건)에서 sync 합침 3건을 빼고,
// 사용자에게 보이는 92건을 골랐다(서버·코어 바탕·시험·도구·문서·결정 기록 54건은 싣지 않았다). 항목마다 고른 PR 묶음:
//   1. linkPreview: #4957 #4989 #4999 #5023 #5035 #5111 (서버 몫 #5006)
//   2. threads: #5012 #5033 #5074 #5019 #5069 #4946 (서버 몫 #4948 #4958 #4991)
//   3. expressions: #4963 #4940 #4998 #5050 #5115 #4997 #5107 #5076 #5136
//   4. menuBar: #5197 #5238
//   5. connection: #5240 #4955 #5230 #5270 (바탕 #5225)
//   6. editAndView: #5203 #5213 #5212 #5205 #5202
//   7. phoneMedia: #5235 #5248 #5231
//   8. passwordReset: #5257 (서버 몫 #5252)
// 그 밖에 바뀐 점(others)은 위 항목에 못 든 변화를 주제별 한 줄로 썼다:
//   conversations(대화): #4938 #5129 #5150 #5080 #4957 #5259
//   attachments(첨부): #5202 #5231 #5274
//   notifications(알림): #5060 #5019 #4958 #4991 #4981 #5169
//   agents(에이전트): #5124 #5144 #5114 #5086 #5013 #5126 #5163 #5117 #5161 #5027 #5075 #4975 #5256 #5253 #5272 #5055 #5002 #5003 #5028 #5036 #5141
//   settings(설정): #4978 #5237 #4954 #5061 #5138 #5217 #5271
//   network(연결): #5270 #5240 #5249 #5265 (바탕 #5225)
//   phone(폰): #4959 #5044 #5052 #5103 #4955
//   desktop(데스크탑): #5186 #5234 #5153 #5213
//   teamExpressions(팀 표현): #5115 #5164 #5266
// 핵심 항목은 8개이고 앞이 더 중요하다. 문장은 해요체이고, 말하는 화면(`surfaces`)은 폰·데스크탑이다(브라우저 탭은 데스크탑과 같은 화면이다).
// 서버만 바뀐 것과 아직 보이지 않는 것은 뺐고, 관리자만 쓰는 도우미 설정과 사용 한도는 핵심이 아니라 그 밖에 · 에이전트에 두었다.
//
// 번호: 폰 빌드 3058은 main 8bec2f53f(10-31 승격)에서 만들었으므로 그 뒤 착륙한 것은 모두 새 것이다. `phoneBuild`는 이 소식을 처음 담을
// 다음 폰 빌드가 받을 번호 이하여야 한다(3058보다 크다. 빌드를 만든 뒤에 고치면 그 빌드는 옛 값을 갖는다). `desktopFrom`에는 release 채널
// `0.1.42`만 적었다: 다음 채널 빌드가 이 소식을 담게 되면 `0.1.0-next.N`을 더하는 것은 승격 때 통합자의 일이다.
// =============================================================================

export const RELEASE_NOTE_0_1_42: ReleaseNote = {
  version: "0.1.42",
  releasedOn: "2026-11-04",
  phoneBuild: 3059,
  desktopFrom: ["0.1.42"], // 다음 채널 번호(`0.1.0-next.N`)는 승격 때 통합자가 더한다
  summary: "releaseNotes.v0142.summary",
  items: [
    {
      id: "linkPreview",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0142.linkPreviewTitle",
      changed: "releaseNotes.v0142.linkPreviewChanged",
      tryIt: "releaseNotes.v0142.linkPreviewTryIt",
    },
    {
      id: "threads",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0142.threadsTitle",
      changed: "releaseNotes.v0142.threadsChanged",
      tryIt: "releaseNotes.v0142.threadsTryIt",
    },
    {
      id: "expressions",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0142.expressionsTitle",
      changed: "releaseNotes.v0142.expressionsChanged",
      tryIt: "releaseNotes.v0142.expressionsTryIt",
    },
    {
      id: "menuBar",
      surfaces: ["desktop"],
      title: "releaseNotes.v0142.menuBarTitle",
      changed: "releaseNotes.v0142.menuBarChanged",
      tryIt: "releaseNotes.v0142.menuBarTryIt",
    },
    {
      id: "connection",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0142.connectionTitle",
      changed: "releaseNotes.v0142.connectionChanged",
      tryIt: "releaseNotes.v0142.connectionTryIt",
    },
    {
      id: "editAndView",
      surfaces: ["desktop"],
      title: "releaseNotes.v0142.editAndViewTitle",
      changed: "releaseNotes.v0142.editAndViewChanged",
      tryIt: "releaseNotes.v0142.editAndViewTryIt",
    },
    {
      id: "phoneMedia",
      surfaces: ["phone"],
      title: "releaseNotes.v0142.phoneMediaTitle",
      changed: "releaseNotes.v0142.phoneMediaChanged",
      tryIt: "releaseNotes.v0142.phoneMediaTryIt",
    },
    {
      id: "passwordReset",
      surfaces: ["desktop"],
      title: "releaseNotes.v0142.passwordResetTitle",
      changed: "releaseNotes.v0142.passwordResetChanged",
      tryIt: "releaseNotes.v0142.passwordResetTryIt",
    },
  ],
  others: [
    {
      id: "conversations",
      title: "releaseNotes.topic.conversations",
      lines: [
        "releaseNotes.v0142.conversationsLine1",
        "releaseNotes.v0142.conversationsLine2",
        "releaseNotes.v0142.conversationsLine3",
        "releaseNotes.v0142.conversationsLine4",
      ],
    },
    {
      id: "attachments",
      title: "releaseNotes.topic.attachments",
      lines: [
        "releaseNotes.v0142.attachmentsLine1",
        "releaseNotes.v0142.attachmentsLine2",
        "releaseNotes.v0142.attachmentsLine3",
      ],
    },
    {
      id: "notifications",
      title: "releaseNotes.topic.notifications",
      lines: [
        "releaseNotes.v0142.notificationsLine1",
        "releaseNotes.v0142.notificationsLine2",
        "releaseNotes.v0142.notificationsLine3",
        "releaseNotes.v0142.notificationsLine4",
      ],
    },
    {
      id: "agents",
      title: "releaseNotes.topic.agents",
      lines: [
        "releaseNotes.v0142.agentsLine1",
        "releaseNotes.v0142.agentsLine2",
        "releaseNotes.v0142.agentsLine3",
        "releaseNotes.v0142.agentsLine4",
        "releaseNotes.v0142.agentsLine5",
        "releaseNotes.v0142.agentsLine6",
        "releaseNotes.v0142.agentsLine7",
        "releaseNotes.v0142.agentsLine8",
        "releaseNotes.v0142.agentsLine9",
        "releaseNotes.v0142.agentsLine10",
        "releaseNotes.v0142.agentsLine11",
        "releaseNotes.v0142.agentsLine12",
        "releaseNotes.v0142.agentsLine13",
      ],
    },
    {
      id: "settings",
      title: "releaseNotes.topic.settings",
      lines: [
        "releaseNotes.v0142.settingsLine1",
        "releaseNotes.v0142.settingsLine2",
        "releaseNotes.v0142.settingsLine3",
        "releaseNotes.v0142.settingsLine4",
        "releaseNotes.v0142.settingsLine5",
      ],
    },
    {
      id: "network",
      title: "releaseNotes.v0142.networkTopic",
      lines: [
        "releaseNotes.v0142.networkLine1",
        "releaseNotes.v0142.networkLine2",
        "releaseNotes.v0142.networkLine3",
        "releaseNotes.v0142.networkLine4",
        "releaseNotes.v0142.networkLine5",
        "releaseNotes.v0142.networkLine6",
      ],
    },
    {
      id: "phone",
      title: "releaseNotes.v0142.phoneTopic",
      lines: [
        "releaseNotes.v0142.phoneLine1",
        "releaseNotes.v0142.phoneLine2",
        "releaseNotes.v0142.phoneLine3",
        "releaseNotes.v0142.phoneLine4",
      ],
    },
    {
      id: "desktop",
      title: "releaseNotes.v0142.desktopTopic",
      lines: [
        "releaseNotes.v0142.desktopLine1",
        "releaseNotes.v0142.desktopLine2",
        "releaseNotes.v0142.desktopLine3",
      ],
    },
    {
      id: "teamExpressions",
      title: "releaseNotes.v0142.teamExpressionsTopic",
      lines: [
        "releaseNotes.v0142.teamExpressionsLine1",
        "releaseNotes.v0142.teamExpressionsLine2",
        "releaseNotes.v0142.teamExpressionsLine3",
      ],
    },
  ],
};
