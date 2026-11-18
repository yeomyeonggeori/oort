import type { ReleaseNote } from "../model";

// =============================================================================
// 업데이트 소식 v0.1.47 (#5968, 글은 사전으로 #5054). v0.1.46(#5736)과 같은 절차의 파일이다(순서는 `notes/README.md`, 등록은
// `notes/index.ts`).
//
// 이 파일에는 글이 없다: 번호·빌드·**사전 키 목록**이다. 글(ko·en)은 `i18n/catalogs/{ko-KR,en-US}/releaseNotes.json`의
// `releaseNotes.v0147.…` 키에 있다. 키 이름 규칙은 `model.test.ts`의 등록부 시험이 잰다.
//
// 근거: v0.1.46 승격(main 55fb1f49a) 뒤 track/uxui(e3fc9fd02, 수리 #5960 · #5964 포함)와 track/engine(61a64f362)에 착륙한 PR에서
// 사용자에게 보이는 것을 골랐다. 화면 낱말은 사전(`channels.*` · `timeline.*` · `directory.*` · `workspace.*` · `expressions.*`)과
// 코어 글자에서 그대로 가져왔다. 항목마다 고른 PR 묶음:
//   1. channelBrowse: 서버 #5893(E1 표시 두 열 · 새 공개 채널은 켜진 채 · 초대 수락은 기본 채널만 · 읽음 위치) #5917(둘러보기 ·
//      스스로 참여, 참여 때 읽음 위치를 끝으로) #5922(「둘러보기에 보이기」 PATCH) #5949 안의 #5840(미리 보기) · #5841(기본 채널 지정)
//      · #5909(migration 186 안전망). 화면 #5923(웹·데스크탑 창 · + · ⌘K) #5928(스위치 · 관리자 묶음) #5936(웹 미리 보기)
//      #5945(「기본 채널로 지정」) #5927(폰 둘러보기 · 홈 이름 검색 묶음) #5930(폰 미리 보기) #5960 #5964(검수 수리).
//      이미 있던 공개 채널이 승격 뒤 어떻게 되는지는 ADR-0224 D2 · D6 · D7 · D10과 migration 184 · 186으로 확인했다: 열을 더할 때
//      모두 꺼짐이고, 워크스페이스마다 기본 채널 하나(보관 안 된 공개 general 중 가장 오래된 것, 없으면 가장 오래된 공개 채널)만
//      둘러보기에 켜진 채 시작한다. 멤버십은 아무도 넣거나 빼지 않는다(D10). 새로 오는 사람은 기본 채널에만(D7).
//      관리자의 할 일(이미 있던 채널을 켜기)은 「바뀐 점」과 「이렇게 써 보세요」에 적었다. 스위치와 기본 채널 지정은 웹·데스크탑에만
//      있어 글에 화면을 적었다(폰은 D12로 이번에 없음).
//   2. dmLeave: 서버 #5860(엔진-3) 코어 #5855 웹·데스크탑 #5868 폰 #5862 #5896 #5915. 「대화 닫기」 → 「목록에서 숨기기」 낱말은
//      #5789(코어 낱말이라 세 화면 같음). 확인 문장은 사전 `channels.dmLeave.*`.
//   3. channelNames: 서버 #5854(모든 언어의 글자 · 숫자) #5898(이름 바꾸기 PATCH) #5949 안의 #5905. 코어 #5871 #5900 웹 #5875
//      폰 #5918 이름 바꾸기 화면 #5937. 다른 사람 화면은 다음 채널 목록 조회에서 바뀌어서(실시간 이벤트 없음, #5937) 「내 사이드바와
//      채널 머리에 바로」까지만 말한다.
//   4. channelMembers: #5818(일반 멤버 나가기 · 채널 멤버 패널의 내보내기, 폰은 나가기만) #5793(프로필 창) #5813(정지 · 정지 풀기 ·
//      워크스페이스에서 내보내기) 서버 #5819(정지된 멤버도 명부에). 내보내기 · 정지는 웹·데스크탑에만 있어 글에 화면을 적었다.
//   5. agentLinks: 서버 #5882(에이전트 글 링크 미리보기 끔) #5949 안의 #5884(고친 글까지) · #5899(그림 링크는 승인 뒤에, migration
//      185) 웹·데스크탑 카드 #5944. 폰의 표현 카드는 링크 후보를 그리지 않아(`clients/mobile/src/features/expressions`에 링크 후보
//      없음) 카드 부분은 웹·데스크탑으로 적었다. 이미 만들어진 미리보기와 링크를 눌러 여는 동작은 그대로다(ADR-0170 증보
//      2026-11-14 「바뀌지 않는 것」). 보안 쪽 말(무엇이 새었는지 · 「더 안전해졌어요」)은 쓰지 않았다.
//   6. reconnectSync: #5953(웹·데스크탑·폰, 열린 대화의 화면에 든 구간만). 「읽는 동안 줄이 움직이지 않는다」는 재지 않은 주장이라
//      쓰지 않았다.
//   7. tooltips: #5956(웹·데스크탑). 화면 검수 r1의 잘림(사이드바 발치 도움말 · 스레드 입력칸 등)과 대화 줄 아바타 툴팁은 #5965가
//      고친다. 글은 아바타와 툴팁 방향을 말하지 않고, 「이렇게 써 보세요」는 잘림 목록 밖의 사이드바 「채널」 머리 + 단추를 고른다.
//      그래서 #5965 착륙 여부와 무관하게 참이다(조건부 키 없음).
// 그 밖에 바뀐 점(others):
//   channels(채널): Line1 · Line2는 #5789(정렬 단추 뺌 — PR 메모가 「업데이트 소식 한 줄 필요」, 읽은 줄 연하게). Line3은 #5796(만든 직후
//     멤버 수 · 「멤버 추가」 잇기, 웹·폰). Line4 · Line5는 #5880(한글 조합 중 찾기 · 정렬 자). Line4는 PR이 고친 장면(「디자인」을
//     치는 도중의 「디장」)만 말한다: 겹모음 · 겹받침 도중에는 아직 깜빡여요(검수 Medium). Line5의 정렬 자는 작성창 # · ⌘K ·
//     폰 검색만 쓰고 사이드바 차례는 바꾸지 않는다. Line6은 #5900 #5906 #5918(채널 만들기 실패 문장만 — 참여 · 스위치 · 이름 바꾸기의
//     망 실패 문장은 영어 화면에 아직 한국어가 섞여요, 화면 검수 rvW1 5842-M4).
//   look(화면): Line1 #5801(메뉴 아이콘 · 하위 메뉴) Line2 #5797(멤버 탭 이메일, 게스트 가림은 화면 가림) Line3 #5810(아바타 점 모양,
//     폰도) Line4 · Line5 #5798(워크스페이스 추가 창 · 프로필 메뉴) Line6 #5806 #5788(폰 줄 끝 아이콘 · 종 아이콘).
//   settings(설정): Line1 #5790(테마 고르기).
//   agents(에이전트): Line1 #5802(Claude Code → 사람용 MCP) Line2 #5940(승인 화면의 채널 고르기, 웹).
// 싣지 않은 것: 보안 수리 세부(#5805 로그아웃 뒤 초안, #5848 인증이 실린 요청의 서버 묶기, #5921 #5924 팀 AI · 에이전트 쪽 「공개
// 채널」 판정, #5869 에이전트가 제안한 닮은꼴 이름) — 공개 저장소라 무엇이 새었는지를 적지 않는다. 팀 AI 감사 기록(#5889,
// 운영자용 — CHANGELOG 몫). 팀 AI 이름 찾기 · 에이전트 길의 상한(#5866), oort 명령줄 도구의 '#이름' 찾기(#5886, 앱 밖). 내려받기
// 페이지(#5773, 앱 밖). 의존성 공지 예외(#5891 #5892 #5894 #5895). ADR · 문서만 바꾼 것(#5821 #5865 #5879). 합치기 · 열차 기록.
// 검수가 「남은 것」으로 넘긴 장면(#5959 #5962 Medium · Low, 폰의 채널에서 내보내기, 웹 · 데스크탑 「멤버 추가」 뒤 초점 등).
//
// 핵심 항목은 7개이고 앞이 더 중요하다. 첫 실행 창에는 요약과 앞 넷의 제목이 나온다. 항목 7은 웹·데스크탑에만 있어 폰에서는 거른다.
// 항목 1 · 2 · 3 · 4 · 5에서 웹·데스크탑에만 있는 부분은 글 안에서 화면을 말했다. 「그 밖에 바뀐 점」에는 화면 칸이 없어 줄마다 화면을
// 적었다(적지 않은 줄은 세 화면 같음).
//
// 조건부 문장: 없다. #5965(잘리는 툴팁 · 대화 줄 아바타 툴팁 · 만들기 창 실패 문장의 자리)에 기대는 키가 없다(항목 7 참고).
//
// 번호 (승격 때 통합자가 확정한다):
//   · `phoneBuild`: 3064. 앞 소식 v0.1.46의 3063보다 커야 등록부 시험이 통과하고, 이 소식을 처음 담는 폰 빌드가 받을 번호 **이하**여야
//     한다. 빌드 번호 규칙(`docs/runbooks/ios-testflight.md` §2, BUILD = 3000 + 2026-09-01부터의 KST 일수)으로 2026-11-19 빌드는
//     3079다(`archive-release.sh --print-build-number`로 확인). 3064는 v0.1.46처럼 앞 소식 + 1의 임시 최솟값이다.
//   · `releasedOn`: 승격 예정일 2026-11-19. 승격 당일로 맞춘다.
//   · `desktopFrom`: release 채널 `0.1.47`만 적었다. 다음 채널 빌드가 이 소식을 담게 되면 `0.1.0-next.N`을 더하는 것은 승격 때
//     통합자의 일이다.
// =============================================================================

export const RELEASE_NOTE_0_1_47: ReleaseNote = {
  version: "0.1.47",
  releasedOn: "2026-11-19",
  phoneBuild: 3064,
  desktopFrom: ["0.1.47"],
  summary: "releaseNotes.v0147.summary",
  items: [
    {
      id: "channelBrowse",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0147.channelBrowseTitle",
      changed: "releaseNotes.v0147.channelBrowseChanged",
      tryIt: "releaseNotes.v0147.channelBrowseTryIt",
    },
    {
      id: "dmLeave",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0147.dmLeaveTitle",
      changed: "releaseNotes.v0147.dmLeaveChanged",
      tryIt: "releaseNotes.v0147.dmLeaveTryIt",
    },
    {
      id: "channelNames",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0147.channelNamesTitle",
      changed: "releaseNotes.v0147.channelNamesChanged",
      tryIt: "releaseNotes.v0147.channelNamesTryIt",
    },
    {
      id: "channelMembers",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0147.channelMembersTitle",
      changed: "releaseNotes.v0147.channelMembersChanged",
      tryIt: "releaseNotes.v0147.channelMembersTryIt",
    },
    {
      id: "agentLinks",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0147.agentLinksTitle",
      changed: "releaseNotes.v0147.agentLinksChanged",
      tryIt: "releaseNotes.v0147.agentLinksTryIt",
    },
    {
      id: "reconnectSync",
      surfaces: ["phone", "desktop"],
      title: "releaseNotes.v0147.reconnectSyncTitle",
      changed: "releaseNotes.v0147.reconnectSyncChanged",
      tryIt: "releaseNotes.v0147.reconnectSyncTryIt",
    },
    {
      id: "tooltips",
      surfaces: ["desktop"],
      title: "releaseNotes.v0147.tooltipsTitle",
      changed: "releaseNotes.v0147.tooltipsChanged",
      tryIt: "releaseNotes.v0147.tooltipsTryIt",
    },
  ],
  others: [
    {
      id: "channels",
      title: "releaseNotes.v0147.channelsTopic",
      lines: [
        "releaseNotes.v0147.channelsLine1",
        "releaseNotes.v0147.channelsLine2",
        "releaseNotes.v0147.channelsLine3",
        "releaseNotes.v0147.channelsLine4",
        "releaseNotes.v0147.channelsLine5",
        "releaseNotes.v0147.channelsLine6",
      ],
    },
    {
      id: "look",
      title: "releaseNotes.v0147.lookTopic",
      lines: [
        "releaseNotes.v0147.lookLine1",
        "releaseNotes.v0147.lookLine2",
        "releaseNotes.v0147.lookLine3",
        "releaseNotes.v0147.lookLine4",
        "releaseNotes.v0147.lookLine5",
        "releaseNotes.v0147.lookLine6",
      ],
    },
    {
      id: "settings",
      title: "releaseNotes.topic.settings",
      lines: ["releaseNotes.v0147.settingsLine1"],
    },
    {
      id: "agents",
      title: "releaseNotes.topic.agents",
      lines: ["releaseNotes.v0147.agentsLine1", "releaseNotes.v0147.agentsLine2"],
    },
  ],
};
