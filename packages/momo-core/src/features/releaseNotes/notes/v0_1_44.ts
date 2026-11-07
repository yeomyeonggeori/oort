import type { ReleaseNote } from "../model";

// =============================================================================
// 업데이트 소식 v0.1.44 (#5479, 글은 사전으로 #5054). v0.1.43(#5415)과 같은 절차의 파일이다(순서는 `notes/README.md`, 등록은
// `notes/index.ts`).
//
// 이 파일에는 글이 없다: 번호·빌드·**사전 키 목록**이다. 글(ko·en)은 `i18n/catalogs/{ko-KR,en-US}/releaseNotes.json`의
// `releaseNotes.v0144.…` 키에 있다. 키 이름 규칙은 `model.test.ts`의 등록부 시험이 잰다.
//
// 근거: v0.1.43 태그(main a28331ea4) 뒤 track/engine에 착륙한 PR에서 사용자에게 보이는 것을 골랐다. 항목마다 고른 PR 묶음:
//   1. steadyEntry: #5472(폰, #5451) #5466(웹·데스크탑, #5456). 숨김 알림 때 그림을 바로 내리는 #5477은 폰 줄(phone)에 있다.
//   2. emoticonWindow: #5471(웹·데스크탑·코어, #5453) #5481(폰, #5452). 「처음 열면 이모티콘 탭, 반응 고르기만 이모지 탭」 한 문장은
//      #5484(#5482)다: 이 글을 쓸 때 PR이 아직 열려 있었다(착륙 확인 필요, 아래 되돌림).
//   3. keyboardPanel(폰 전용): #5481(#5452).
//   4. sendTogether: #5471(웹·데스크탑·코어 보내기 묶음) #5481(폰).
//   5. suggestions: 코어 맞추기 함수 #5474(#5454 1단계), 웹·데스크탑 추천 줄 #5476(PR #5480), 폰 추천 줄 #5478(PR #5483).
//   6. lighterEmoticons: #5467(서버 재인코딩, #5455) #5475(웹 그림 기억, #5468). 폰의 다시 들어가기는 #5472의 기억(항목 1)이 맡는다.
// 그 밖에 바뀐 점(others)은 위 항목에 못 든 변화를 주제별 한 줄로 썼다:
//   expressions(이모티콘): #5471 #5481 (추가하기의 자리와 웹 신고·삭제, 이모지 탭의 팀 작은 이모지 줄, 스레드 입력칸은 :이름: 글로 들어가고 미리 보기가 없다)
//   agents(에이전트): #5449(#5373, 「맡기기」 단추에 팀 Hermes. 운영자가 Hermes를 핀으로 둔 서버에서만 보인다)
//   phone(폰): #5445(#5436, 「안 읽은 동안」 한 줄 띠. 이슈 목록에는 없었지만 v0.1.43 태그 뒤 착륙해 [Unreleased]에 있다) #5477(#5473)
// 싣지 않은 것: 운영 #5457(브랜치 보호), 설계 문서와 코어 타입·픽스처 #5458(ADR-0218 증보 6: Hermes 세트 제안은 화면이 아직 없다),
// Hermes 위임 S1·S3(승격 핀 뒤 착륙 예정, 사용자에게 아직 보이지 않는다), 발행 기록 #5441, 합치기 기록 #5440 #5446 #5448.
//
// 핵심 항목은 6개이고 앞이 더 중요하다. 문장은 해요체이고, 말하는 화면(`surfaces`)은 폰·데스크탑이다(브라우저 탭은 데스크탑과 같은
// 화면이다). 키보드 자리 창은 폰에만 있다. 이전 소식(v0.1.43)이 알린 탭 이름 「우리 팀, 기본, GIF」는 이번에 「이모티콘, 이모지, GIF」로
// 바뀌었고, 글에 말했다. 폰 단추·화면 이름은 착륙한 코드로 맞대었다: 웃는 얼굴 단추(낭독 이름 「이모티콘 고르기」, 창이 서면 눌린 모양에 「키보드 열기」),
// 탭 「이모티콘·이모지·GIF」, 미리 보기 ✕(「… 미리 보기 지우기」), 추천 줄 ✕(「이 낱말 추천 끄기」), 그림을 길게 눌러 즐겨찾기, 창 아래 세트 띠와 끝의 +(「추가하기」).
//
// 남은 확인: #5484(#5482, 첫 탭)가 착륙하지 않으면 emoticonWindowChanged(ko·en)에서 「처음 열면 이모티콘 탭이 먼저 보이고, 웹과 데스크탑의
// 반응 고르기만 예전처럼 이모지 탭부터 열려요.」 / 「The window opens on the Emoticons tab first; only the reaction picker on web and desktop still
// starts on Emoji.」 한 문장씩만 뺀다(웹은 지금 코드로는 이모지 탭부터 열린다). 사전 키가 바뀌면 `i18n:generate`를 다시 돌린다.
//
// 번호 (모두 승격 때 통합자가 확정한다):
//   · `phoneBuild`: 확정 대기(TBD). 지금 3061은 임시 최솟값이다(앞 소식 v0.1.43의 3060보다 커야 등록부 시험이 통과한다). 이 소식을 처음 담는 폰
//     빌드가 받을 번호 **이하**여야 한다(빌드 번호 규칙은 날짜 기준이라 오늘 빌드는 3067). 빌드를 만든 뒤에 고치면 그 빌드는 옛 값을 갖는다.
//   · `releasedOn`: 임시로 승격 예정일 2026-11-07. 승격 당일로 맞춘다(v0.1.43은 #5434에서 같은 일을 했다).
//   · `desktopFrom`: release 채널 `0.1.44`만 적었다. 다음 채널 빌드가 이 소식을 담게 되면 `0.1.0-next.N`을 더하는 것은 승격 때
//     통합자의 일이다.
// =============================================================================

export const RELEASE_NOTE_0_1_44: ReleaseNote = {
  version: "0.1.44",
  releasedOn: "2026-11-07",
  phoneBuild: 3061,
  desktopFrom: ["0.1.44"],
  summary: "releaseNotes.v0144.summary",
  items: [
    {
      id: "steadyEntry",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0144.steadyEntryTitle",
      changed: "releaseNotes.v0144.steadyEntryChanged",
      tryIt: "releaseNotes.v0144.steadyEntryTryIt",
    },
    {
      id: "emoticonWindow",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0144.emoticonWindowTitle",
      changed: "releaseNotes.v0144.emoticonWindowChanged",
      tryIt: "releaseNotes.v0144.emoticonWindowTryIt",
    },
    {
      id: "keyboardPanel",
      surfaces: ["phone"],
      title: "releaseNotes.v0144.keyboardPanelTitle",
      changed: "releaseNotes.v0144.keyboardPanelChanged",
      tryIt: "releaseNotes.v0144.keyboardPanelTryIt",
    },
    {
      id: "sendTogether",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0144.sendTogetherTitle",
      changed: "releaseNotes.v0144.sendTogetherChanged",
      tryIt: "releaseNotes.v0144.sendTogetherTryIt",
    },
    {
      id: "suggestions",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0144.suggestionsTitle",
      changed: "releaseNotes.v0144.suggestionsChanged",
      tryIt: "releaseNotes.v0144.suggestionsTryIt",
    },
    {
      id: "lighterEmoticons",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0144.lighterEmoticonsTitle",
      changed: "releaseNotes.v0144.lighterEmoticonsChanged",
      tryIt: "releaseNotes.v0144.lighterEmoticonsTryIt",
    },
  ],
  others: [
    {
      id: "expressions",
      title: "releaseNotes.v0144.expressionsTopic",
      lines: [
        "releaseNotes.v0144.expressionsLine1",
        "releaseNotes.v0144.expressionsLine2",
        "releaseNotes.v0144.expressionsLine3",
      ],
    },
    {
      id: "agents",
      title: "releaseNotes.topic.agents",
      lines: ["releaseNotes.v0144.agentsLine1"],
    },
    {
      id: "phone",
      title: "releaseNotes.v0144.phoneTopic",
      lines: ["releaseNotes.v0144.phoneLine1", "releaseNotes.v0144.phoneLine2"],
    },
  ],
};
