import type { ReleaseNote } from "../model";

// =============================================================================
// 업데이트 소식 v0.1.46 (#5736, 글은 사전으로 #5054). v0.1.45(#5550)와 같은 절차의 파일이다(순서는 `notes/README.md`, 등록은
// `notes/index.ts`).
//
// 이 파일에는 글이 없다: 번호·빌드·**사전 키 목록**이다. 글(ko·en)은 `i18n/catalogs/{ko-KR,en-US}/releaseNotes.json`의
// `releaseNotes.v0146.…` 키에 있다. 키 이름 규칙은 `model.test.ts`의 등록부 시험이 잰다.
//
// 근거: v0.1.45 승격(main a1d399fd1, #5553) 뒤 track/uxui(6010f2cbd)와 track/engine(869878cba)에 착륙한 PR에서 사용자에게 보이는
// 것을 골랐다. 항목마다 고른 PR 묶음:
//   1. steadyChat: #5583(웹·데스크탑, 가만히 있어도 튀던 것) #5574 #5634(여러 줄 떨림, 「작성 중」 한 줄, 두 이름 남기기는 폰도)
//      #5637(보낸 직후 머리 줄, 코어 공용이라 폰도) #5617(같은 분 묶음은 코어 공용, 위에서 보내도 맨 아래는 웹·데스크탑)
//      #5668(옛 글 불러오기 실패 줄 「이전 글을 불러오지 못했어요」 + 「다시 시도」, 웹·데스크탑). 제목은 고친 장면만 말한다:
//      #5583·#5670이 「남은 것」으로 적은 장면(위로 올리는 중의 스크롤 등)까지 「흔들리지 않는다」고 하지 않는다. 대화에 들어갈 때의
//      자리(#5717 뒷걸음)는 이 항목이 말하지 않는다(아래 조건부 conversationsLine1).
//   2. needsReply: #5657(웹·데스크탑 「작업」 › 「내 작업」 맨 위 「응답 필요」, 내 에이전트 run의 승인은 그 줄에서 승인·거부)
//      #5642(engine, 내 맥 세션 `waiting`) #5605(웹·데스크탑 멈추기 = 폰과 같은 kill, 맥 세션 권한 요청의 데스크탑 OS 알림)
//      #5621(폰 작업 목록 「응답 필요」 먼저, 세션 줄·권한 알림 → 세션 화면) #5584 #5620(데스크탑 터미널 칸의 OSC 7501:
//      Codex 칸이 처음으로 「응답 필요」, Claude Code 칸은 hook 대신 프로그램 보고) #5614(engine, 맥 작업 멈춤 알림: 끊김·실패·
//      권한 요청 600초 만료 → 세션 스레드 한 줄 + 주인 푸시. spawn 거절은 한 줄만이라 「멈추면」 문장에 넣지 않았다).
//      내 맥 세션의 권한 요청 줄에는 승인·거부 단추가 없다(목록이 요청 내용을 싣지 않음): 데스크탑 앱은 「열어서 답하기」, 브라우저는
//      「허락은 폰이나 데스크탑 앱에서 보내 주세요」. 글은 그대로 나눠 말한다.
//   3. backgroundDesktop: #5666(치운 창의 웹뷰 유지·메뉴 막대 표시 즉시·DM과 따라가는 스레드 답글을 셈·열어 둔 대화는 앞에서 볼 때
//      읽음·폰 알림 「스레드 · 」 빼기는 notificationsLine1) #5669(engine, 따라가는 스레드 안 읽은 답글 수) #5610(깬 뒤 헛
//      「서버에 닿지 못했어요」, 연결 기록 카드는 desktopLine2) #5704(웹, 「모두 읽음 처리」가 스레드 답글 몫까지, 예전 키 `dockDm`을
//      읽지 않아 꺼 둔 기기도 한 번 켜짐) #5697(engine, POST threads/read-all).
//   4. updateNotice: #5664(6시간·깬 직후 확인, 「확인 안 함」·「마지막 확인」, 3초 카운트다운·「지금 말고」, 「이 맥의 작업이 끝나면
//      다시 시작해요」, 끊길 것 한 줄, 다시 시작이 작업 데몬까지, 접힌 사이드바의 알약) #5715(카드 안 Tab, 「다시 시작」 통일).
//   5. whoIsDoing: #5695 #5709(웹·데스크탑 채널 멤버 패널의 둘째 줄과 묶음 「일하는 에이전트·그 밖의 에이전트·온라인·오프라인」)
//      #5710(인박스 출처 줄, 웹·데스크탑·폰). 화면 이름은 웹·폰 모두 「인박스」라 그 낱말을 썼다(지난 판들의 「받은함」과 다르다).
//   6. suggestPick: #5597(낱말뿐이면 바꾸기·문구면 더하기·여러 낱말) #5643(방금 친 낱말이 키워드일 때만, Esc·쓸어내리기 「이번만
//      닫기」는 다음 키워드까지) #5626 #5632(폰: 끊겨도 :이름: 글자 없음, 3초 넘게 못 받은 큰·중간 칸에 이름).
// 그 밖에 바뀐 점(others):
//   desktop(데스크탑): desktopLine1은 이슈 수용 기준 「앱을 완전히 끄고 다시 켜 주세요」. 소식 모양에 이 안내만 두는 칸이 없어 이
//     줄로 썼다(첫 실행 창에는 others가 안 나온다). 까닭은 #5664 「알려진 한계」: 이 수정 전 판의 앱 안 업데이트는 작업 데몬을
//     바꾸지 않을 수 있다. desktopLine2는 #5610의 「연결 기록」 카드.
//   conversations(대화): Line1·Line2·Line3은 아래 조건부, Line4는 #5658(폰 큰 글자의 「작성 중」 줄 자리).
//   agents(에이전트): Line1은 #5609(engine, 팀 AI 답의 모델 칩, 폰 행도), Line2는 아래 조건부.
//   notifications(알림): Line1은 #5666의 폰 알림 「스레드 · 」 빼기.
// 싣지 않은 것: Hermes 위임 S6·S7(#5596 #5656, 천장 #5692 #5698 #5718. 설정의 「Hermes 도움」 행은 관리자에게 서지만 답의 칩은
// 팀 Hermes가 연결된 서버에서만 나와 브리프 기본대로 뺐다: 인계의 「planner가 정할 것」), 보안 수리 세부(#5573 #5635 #5655 #5675
// #5676), 다국어 바탕(#5598, 보이는 변화 없음), 내려받기 페이지·문서(#5564 #5580 #5611, 앱 밖), 작업 서랍 전면 문턱(#5725, 1200~
// 1291px 창에만 닿는 작은 자리 수리), ADR·문서·시험·게이트·CI만 바꾼 것(#5570 #5581 #5608 #5612 #5644 #5659 #5688 #5705 #5723
// #5729), 발행 기록 #5558, 합치기 기록.
//
// 핵심 항목은 6개이고 앞이 더 중요하다. 문장은 해요체이고, 말하는 화면(`surfaces`)은 폰·데스크탑이다(브라우저 탭은 데스크탑과 같은
// 화면이다). 항목 3·4는 데스크탑에만 있어 폰에서는 거른다. 항목 1·5에서 웹·데스크탑에만 있는 부분은 글 안에서 화면을 말했다.
//
// 남은 확인(조건부 문장, 글을 쓸 때 PR이 아직 검수 중이었다). 조건부 사실은 저마다 **한 키, 한 문장**이라 착륙하지 않으면 그 키를
// 사전 두 파일과 아래 `lines`에서 함께 빼고 `i18n:generate`를 다시 돌린다. 대체 문장은 없다(줄째 뺀다). 다른 키의 글은 이
// PR들에 기대지 않는다. 쌓인 차례가 #5670 → #5694 → #5699(#5717 포함)라, 앞 PR이 빠지면 뒤 PR도 함께 빠진다.
//   · #5699(#5717) 미착륙 → `conversationsLine1` 뺌.
//       ko 「웹과 데스크탑에서 대화에 들어가면 첫 화면부터 가장 새 글이 맨 아래에 서요.」
//       en 「On web and desktop, opening a chat shows the newest message at the bottom right from the start.」
//   · #5694 미착륙 → `conversationsLine2` 뺌(그러면 #5699도 못 들어와 Line1도 뺀다).
//       ko 「데스크탑에서 맨 아래 글에 반응을 달거나 떼도 대화가 살짝 움직이던 것을 고쳤어요.」
//       en 「On desktop, adding or removing a reaction on the last message no longer nudges the chat.」
//   · #5670 미착륙 → `conversationsLine3` 뺌(그러면 Line1·Line2도 뺀다. Line4가 남아 묶음은 그대로 선다).
//       ko 「웹과 데스크탑의 스레드에서 위쪽 답글이 자라거나 줄어도 보던 답글이 제자리에 있고, 맨 아래에서는 새 답글을 따라가요.」
//       en 「In web and desktop threads, the reply you read stays put as replies above change; new ones stay in view at the bottom.」
//   · #5735 미착륙 → `agentsLine2` 뺌(Line1이 남는다). 다른 글은 「작업 콘솔」이라는 화면 이름을 쓰지 않는다.
//       ko 「웹과 데스크탑의 「작업 콘솔」은 「작업」 안의 세션 화면이 되었고, 「← 작업」으로 돌아가면 열었던 줄로 돌아와요.」
//       en 「On web and desktop, the work console is now the session view inside Work, and “← Work” returns to the row you opened.」
//   · #5732(「응답 필요」 줄 누르기 다듬기)·#5720(멤버 패널 좁은 폭 실패 줄)은 싣지 않는다. 착륙과 무관하게 글은 그대로다.
//
// 번호 (승격 때 통합자가 확정한다):
//   · `phoneBuild`: 3063. 앞 소식 v0.1.45의 3062보다 커야 등록부 시험이 통과하고, 이 소식을 처음 담는 폰 빌드가 받을 번호 **이하**여야
//     한다. 빌드 번호 규칙(`docs/runbooks/ios-testflight.md` §2)으로는 2026-11-13 KST 빌드가 3073이라, 3063은 그 이하의 임시 최솟값이다.
//   · `releasedOn`: 승격 예정일 2026-11-13. 승격 당일로 맞춘다.
//   · `desktopFrom`: release 채널 `0.1.46`만 적었다. 다음 채널 빌드가 이 소식을 담게 되면 `0.1.0-next.N`을 더하는 것은 승격 때
//     통합자의 일이다.
// =============================================================================

export const RELEASE_NOTE_0_1_46: ReleaseNote = {
  version: "0.1.46",
  releasedOn: "2026-11-13",
  phoneBuild: 3063,
  desktopFrom: ["0.1.46"],
  summary: "releaseNotes.v0146.summary",
  items: [
    {
      id: "steadyChat",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0146.steadyChatTitle",
      changed: "releaseNotes.v0146.steadyChatChanged",
      tryIt: "releaseNotes.v0146.steadyChatTryIt",
    },
    {
      id: "needsReply",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0146.needsReplyTitle",
      changed: "releaseNotes.v0146.needsReplyChanged",
      tryIt: "releaseNotes.v0146.needsReplyTryIt",
    },
    {
      id: "backgroundDesktop",
      surfaces: ["desktop"],
      title: "releaseNotes.v0146.backgroundDesktopTitle",
      changed: "releaseNotes.v0146.backgroundDesktopChanged",
      tryIt: "releaseNotes.v0146.backgroundDesktopTryIt",
    },
    {
      id: "updateNotice",
      surfaces: ["desktop"],
      title: "releaseNotes.v0146.updateNoticeTitle",
      changed: "releaseNotes.v0146.updateNoticeChanged",
      tryIt: "releaseNotes.v0146.updateNoticeTryIt",
    },
    {
      id: "whoIsDoing",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0146.whoIsDoingTitle",
      changed: "releaseNotes.v0146.whoIsDoingChanged",
      tryIt: "releaseNotes.v0146.whoIsDoingTryIt",
    },
    {
      id: "suggestPick",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0146.suggestPickTitle",
      changed: "releaseNotes.v0146.suggestPickChanged",
      tryIt: "releaseNotes.v0146.suggestPickTryIt",
    },
  ],
  others: [
    {
      id: "desktop",
      title: "releaseNotes.v0146.desktopTopic",
      lines: ["releaseNotes.v0146.desktopLine1", "releaseNotes.v0146.desktopLine2"],
    },
    {
      id: "conversations",
      title: "releaseNotes.topic.conversations",
      lines: [
        "releaseNotes.v0146.conversationsLine1",
        "releaseNotes.v0146.conversationsLine2",
        "releaseNotes.v0146.conversationsLine3",
        "releaseNotes.v0146.conversationsLine4",
      ],
    },
    {
      id: "agents",
      title: "releaseNotes.topic.agents",
      lines: ["releaseNotes.v0146.agentsLine1", "releaseNotes.v0146.agentsLine2"],
    },
    {
      id: "notifications",
      title: "releaseNotes.topic.notifications",
      lines: ["releaseNotes.v0146.notificationsLine1"],
    },
  ],
};
