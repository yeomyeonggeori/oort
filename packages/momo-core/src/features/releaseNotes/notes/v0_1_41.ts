import type { ReleaseNote } from "../model";

// =============================================================================
// 업데이트 소식 v0.1.41 (#4937, 글을 사전으로 옮김 #5054). 승격 때 통합자가 이 모양의 파일을 새 릴리스마다 하나씩 쓴다
// (순서는 `notes/README.md`, 등록은 `notes/index.ts`).
//
// 이 파일에는 글이 없다: 번호·빌드·**사전 키 목록**이다. 글(ko·en)은 `i18n/catalogs/{ko-KR,en-US}/releaseNotes.json`의
// `releaseNotes.v0141.…` 키에 있다. 키 이름은 `releaseNotes.v<버전 숫자>.<항목 이름><Title|Changed|TryIt>`이고
// (사전 키는 점·밑줄·하이픈을 못 쓴다), 이 규칙은 `model.test.ts`의 등록부 시험이 잰다.
//
// 근거: 증거 빌드 10-31의 5분 스모크 목록(#2568 쪽 코멘트)과 `CHANGELOG.md` `[Unreleased]`(v0.1.41의 바뀐 점).
// 사용자에게 보이는 것만 쉬운 말로 적었다. 서버만 바뀐 것, 아직 보이지 않는 것(결정 무대·묶음 카드, 사진으로 이모티콘
// 만들기)은 뺐다. 이 소식을 처음 보는 빌드에서 이미 없어진 화면(폰의 햅틱 고르기 줄 등)도 쓰지 않았다.
//
// 항목은 8개 이하이고 앞이 더 중요하다. 문장은 해요체이고, 말하는 화면(`surfaces`)은 폰·데스크탑이다
// (브라우저 탭은 데스크탑과 같은 화면이다). 「그 밖에 바뀐 점」(`others`)은 이 소식에 아직 없다(비어 있다).
// =============================================================================

export const RELEASE_NOTE_0_1_41: ReleaseNote = {
  version: "0.1.41",
  releasedOn: "2026-10-31",
  // 증거 빌드 10-31: 폰 빌드 3058, 데스크탑 0.1.41. 다음 채널 빌드는 아직 이 소식을 담지 않았다.
  phoneBuild: 3058,
  desktopFrom: ["0.1.41"],
  summary: "releaseNotes.v0141.summary",
  items: [
    {
      id: "typing",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0141.typingTitle",
      changed: "releaseNotes.v0141.typingChanged",
      tryIt: "releaseNotes.v0141.typingTryIt",
    },
    {
      id: "channelNotifications",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0141.channelNotificationsTitle",
      changed: "releaseNotes.v0141.channelNotificationsChanged",
      tryIt: "releaseNotes.v0141.channelNotificationsTryIt",
    },
    {
      id: "photoViewer",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0141.photoViewerTitle",
      changed: "releaseNotes.v0141.photoViewerChanged",
      tryIt: "releaseNotes.v0141.photoViewerTryIt",
    },
    {
      id: "composerHeight",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0141.composerHeightTitle",
      changed: "releaseNotes.v0141.composerHeightChanged",
      tryIt: "releaseNotes.v0141.composerHeightTryIt",
    },
    {
      id: "phoneConversation",
      surfaces: ["phone"],
      title: "releaseNotes.v0141.phoneConversationTitle",
      changed: "releaseNotes.v0141.phoneConversationChanged",
      tryIt: "releaseNotes.v0141.phoneConversationTryIt",
    },
    {
      id: "settings",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0141.settingsTitle",
      changed: "releaseNotes.v0141.settingsChanged",
      tryIt: "releaseNotes.v0141.settingsTryIt",
    },
    {
      id: "emoji",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0141.emojiTitle",
      changed: "releaseNotes.v0141.emojiChanged",
      tryIt: "releaseNotes.v0141.emojiTryIt",
    },
    {
      id: "agents",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0141.agentsTitle",
      changed: "releaseNotes.v0141.agentsChanged",
      tryIt: "releaseNotes.v0141.agentsTryIt",
    },
  ],
  others: [],
};
