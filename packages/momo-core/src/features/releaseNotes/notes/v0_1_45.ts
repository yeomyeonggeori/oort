import type { ReleaseNote } from "../model";

// =============================================================================
// 업데이트 소식 v0.1.45 (#5550, 글은 사전으로 #5054). v0.1.44(#5479)와 같은 절차의 파일이다(순서는 `notes/README.md`, 등록은
// `notes/index.ts`).
//
// 이 파일에는 글이 없다: 번호·빌드·**사전 키 목록**이다. 글(ko·en)은 `i18n/catalogs/{ko-KR,en-US}/releaseNotes.json`의
// `releaseNotes.v0145.…` 키에 있다. 키 이름 규칙은 `model.test.ts`의 등록부 시험이 잰다.
//
// 근거: v0.1.44 승격(main 7fb34e996, #5505) 뒤 track/engine에 착륙한 PR 가운데 CHANGELOG `[Unreleased]`에 사용자에게 보이는 줄로
// 남은 것을 골랐다. 항목마다 고른 PR 묶음:
//   1. keptEmoticons: #5532(웹·데스크탑, #5455 B-1) #5545(폰, #5455 B-2). 이미 본 그림이 다시 켜도 기기에 남는다.
//   2. frequentRecent: #5517(#5503). 이모티콘 탭 맨 위 「자주·최근」(사전 `expressions.picker.sectionFrecent`).
//   3. reactionGifs: #5518(#5504). 폰 반응 고르개 세 탭과 반응 칩 GIF의 계속 움직임. 웹·데스크탑 반응 고르개는 v0.1.44에 이미 세 탭이라
//      제목은 두 화면에 다 새로운 것(반응 GIF가 계속 움직임)으로 쓰고, 폰의 세 탭은 본문과 요약에 썼다.
//   4. replyPreview(폰 전용): #5516(#5490, #5487의 폰 짝). v0.1.44 `expressionsLine3`의 「아직 :이름: 글로 들어가요」를 닫는다.
//   5. steadyPhotos: #5528(#5469, 서버·코어·웹·폰, migration 178). v0.1.44 `steadyEntryChanged`의 「다음 판에서 고칠 예정」을 닫는다.
//   6. noBlink: #5524(#5491).
//   7. suggestionSwitch: #5521(#5493). 자리는 코드로 맞대었다: 웹 `settingsNav.ts` 「모양」 › `DisplayPrefs.tsx` 「대화 표시」의 마지막
//      보이는 줄(뒤의 `ThreadLayoutRow`는 null), 폰 `SettingsPage.tsx` 「보기」 카드의 마지막 줄. 영어 경로 이름은 v0.1.42 소식을 따랐다.
// 그 밖에 바뀐 점(others):
//   expressions(이모티콘): #5519(#5492, 폰 추천 줄 폭) #5529(#5527, 데스크탑 최소 창의 이모티콘 창)
//   phone(폰): #5547(#5544, 스레드 뒤 채널) + #5546(대화 뒤 홈 목록, 이 글을 쓸 때 이슈만 열려 있고 착륙 전이다: 아래 남은 확인)
// 싣지 않은 것: 운영 기본이 닫혀 있어 보이지 않는 것(Hermes 그림 위임 #5342 줄 #5509 #5511 #5525 #5534, 세트 제안·서버 길 #5442 줄
// #5514 #5515 #5523 #5526 #5536, Hermes ADR #5537, 상한 표지 #5549), 내부 규칙(#5532의 웹 등록 응답 델타 규칙), 시험·CI만 바꾼 것
// (#5508 #5513 #5522 #5535), 발행 기록 #5510, 합치기 기록 #5507.
//
// 핵심 항목은 7개이고 앞이 더 중요하다. 문장은 해요체이고, 말하는 화면(`surfaces`)은 폰·데스크탑이다(브라우저 탭은 데스크탑과 같은
// 화면이다). 밀어서 답장·스레드 미리 보기는 폰에만 있다. 폰 이름은 착륙한 코드로 맞대었다: 메시지를 길게 눌러 뜨는 시트의 「빠른 반응」 줄
// 끝 +(낭독 이름 「전체 이모지 고르기」), 탭 「이모티콘·이모지·GIF」(`expressions.sheet.tab*`), 설정 스위치 「이모티콘 추천」
// (`expressions.suggest.settingLabel`).
//
// 남은 확인: #5546이 착륙하지 않으면 phoneLine1(ko·en)에서 홈 목록 반쪽을 뺀다. 그때의 글은 「VoiceOver가 스레드를 연 동안에는 뒤의
// 채널로 넘어가지 않아요.」 / 「VoiceOver no longer reaches the channel behind an open thread.」이고, 사전을 고친 뒤 `i18n:generate`를 다시
// 돌린다.
//
// 번호 (승격 때 통합자가 확정한다):
//   · `phoneBuild`: 3062. 앞 소식 v0.1.44의 3061보다 커야 등록부 시험이 통과하고, 이 소식을 처음 담는 폰 빌드가 받을 번호 **이하**여야
//     한다. 빌드 번호 규칙(`docs/runbooks/ios-testflight.md` §2)으로는 2026-11-08 KST 빌드가 3068이라, 3062는 그 이하의 임시 최솟값이다.
//   · `releasedOn`: 승격 예정일 2026-11-08. 승격 당일로 맞춘다.
//   · `desktopFrom`: release 채널 `0.1.45`만 적었다. 다음 채널 빌드가 이 소식을 담게 되면 `0.1.0-next.N`을 더하는 것은 승격 때
//     통합자의 일이다.
// =============================================================================

export const RELEASE_NOTE_0_1_45: ReleaseNote = {
  version: "0.1.45",
  releasedOn: "2026-11-08",
  phoneBuild: 3062,
  desktopFrom: ["0.1.45"],
  summary: "releaseNotes.v0145.summary",
  items: [
    {
      id: "keptEmoticons",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0145.keptEmoticonsTitle",
      changed: "releaseNotes.v0145.keptEmoticonsChanged",
      tryIt: "releaseNotes.v0145.keptEmoticonsTryIt",
    },
    {
      id: "frequentRecent",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0145.frequentRecentTitle",
      changed: "releaseNotes.v0145.frequentRecentChanged",
      tryIt: "releaseNotes.v0145.frequentRecentTryIt",
    },
    {
      id: "reactionGifs",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0145.reactionGifsTitle",
      changed: "releaseNotes.v0145.reactionGifsChanged",
      tryIt: "releaseNotes.v0145.reactionGifsTryIt",
    },
    {
      id: "replyPreview",
      surfaces: ["phone"],
      title: "releaseNotes.v0145.replyPreviewTitle",
      changed: "releaseNotes.v0145.replyPreviewChanged",
      tryIt: "releaseNotes.v0145.replyPreviewTryIt",
    },
    {
      id: "steadyPhotos",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0145.steadyPhotosTitle",
      changed: "releaseNotes.v0145.steadyPhotosChanged",
      tryIt: "releaseNotes.v0145.steadyPhotosTryIt",
    },
    {
      id: "noBlink",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0145.noBlinkTitle",
      changed: "releaseNotes.v0145.noBlinkChanged",
      tryIt: "releaseNotes.v0145.noBlinkTryIt",
    },
    {
      id: "suggestionSwitch",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0145.suggestionSwitchTitle",
      changed: "releaseNotes.v0145.suggestionSwitchChanged",
      tryIt: "releaseNotes.v0145.suggestionSwitchTryIt",
    },
  ],
  others: [
    {
      id: "expressions",
      title: "releaseNotes.v0145.expressionsTopic",
      lines: ["releaseNotes.v0145.expressionsLine1", "releaseNotes.v0145.expressionsLine2"],
    },
    {
      id: "phone",
      title: "releaseNotes.v0145.phoneTopic",
      lines: ["releaseNotes.v0145.phoneLine1"],
    },
  ],
};
