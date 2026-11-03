import type { ReleaseNote } from "../model";

// =============================================================================
// 업데이트 소식 v0.1.41 (#4937). 승격 때 통합자가 이 모양의 파일을 새 릴리스마다 하나씩 쓴다
// (`docs/RELEASING.md` §1, 등록은 `notes/index.ts`).
//
// 근거: 증거 빌드 10-31의 5분 스모크 목록(#2568 쪽 코멘트)과 `CHANGELOG.md` `[Unreleased]`(v0.1.41의 바뀐 점).
// 사용자에게 보이는 것만 쉬운 말로 적었다. 서버만 바뀐 것, 아직 보이지 않는 것(결정 무대·묶음 카드, 사진으로 이모티콘
// 만들기)은 뺐다. 이 소식을 처음 보는 빌드에서 이미 없어진 화면(폰의 햅틱 고르기 줄 등)도 쓰지 않았다.
//
// 항목은 8개 이하이고 앞이 더 중요하다. 문장은 해요체이고, 말하는 화면(`surfaces`)은 폰·데스크탑이다
// (브라우저 탭은 데스크탑과 같은 화면이다).
// =============================================================================

export const RELEASE_NOTE_0_1_41: ReleaseNote = {
  version: "0.1.41",
  releasedOn: "2026-10-31",
  // 증거 빌드 10-31: 폰 빌드 3058, 데스크탑 0.1.41. 다음 채널 빌드는 아직 이 소식을 담지 않았다.
  phoneBuild: 3058,
  desktopFrom: ["0.1.41"],
  summary: {
    "ko-KR": "대화 화면이 더 보기 좋아지고, 언어 설정과 팀 이모지, 에이전트 비용이 들어왔어요.",
    "en-US": "Conversations look better, and a language setting, team emoji and agent costs are new.",
  },
  items: [
    {
      id: "typing",
      surfaces: ["phone", "desktop"],
      copy: {
        "ko-KR": {
          title: "작성 중 표시",
          changed:
            "입력창 아래에서 누가 쓰고 있는지 이름을 굵게 보여 주고, 점 셋이 움직여요. 동작 줄이기를 켜면 점은 멈춰 있어요.",
          tryIt: "대화에서 다른 사람이나 에이전트가 답을 쓰는 동안 입력창 아래를 봐 주세요.",
        },
        "en-US": {
          title: "Typing indicator",
          changed:
            "Under the composer, the name of who is typing is bold and three dots move. With Reduce Motion on, the dots stay still.",
          tryIt: "Watch the line under the composer while a person or an agent is writing a reply.",
        },
      },
    },
    {
      id: "channel-notifications",
      surfaces: ["phone", "desktop"],
      copy: {
        "ko-KR": {
          title: "채널 알림 켜짐·꺼짐 표시",
          changed:
            "채널 알림이 켜져 있는지 꺼져 있는지 종 아이콘과 글자로 보여 줘요. 누르면 바로 바뀌고, 저장하지 못하면 그 채널만 원래대로 돌아가요.",
          tryIt:
            "폰은 대화 정보 페이지, ⋮ 메뉴, 채널 행 메뉴에서 알림 줄을 눌러 보세요. 데스크탑은 채널 머리의 ⋮ 메뉴와 사이드바 행 메뉴에서 눌러 보세요.",
        },
        "en-US": {
          title: "Channel notification state",
          changed:
            "A channel's notification line shows its state with a bell icon and words. It flips the moment you tap, and if saving fails only that channel goes back.",
          tryIt:
            "On the phone, tap the notification line on the conversation info page, in the ⋮ menu or in a channel row menu. On the desktop, use the channel header ⋮ menu or the sidebar row menu.",
        },
      },
    },
    {
      id: "photo-viewer",
      surfaces: ["phone", "desktop"],
      copy: {
        "ko-KR": {
          title: "사진 열고 닫기",
          changed:
            "사진을 누르면 누른 자리에서 커지며 열리고, 닫으면 그 자리로 돌아가요. 뒤로 가기, Esc, 아래로 끌기로 닫을 수 있고, 동작 줄이기를 켜면 바로 열리고 닫혀요.",
          tryIt: "대화에 올라온 사진을 눌러 열고, 여러 방법으로 닫아 보세요.",
        },
        "en-US": {
          title: "Opening and closing photos",
          changed:
            "A photo grows out of the picture you tapped and closes back into it. Back, Esc or a drag down closes it, and with Reduce Motion on it opens and closes at once.",
          tryIt: "Open a photo in a conversation and close it in a few different ways.",
        },
      },
    },
    {
      id: "composer-height",
      surfaces: ["phone", "desktop"],
      copy: {
        "ko-KR": {
          title: "입력창 높이",
          changed:
            "입력창이 폰은 4줄, 데스크탑은 5줄까지 늘어난 뒤 안에서 스크롤돼요. 긴 글을 붙여 넣어도 높이가 맞고, 마지막 줄이 잘리지 않아요.",
          tryIt: "여러 줄을 입력해 보고, 긴 글을 붙여 넣어 보세요.",
        },
        "en-US": {
          title: "Composer height",
          changed:
            "The composer grows to four lines on the phone and five on the desktop, then scrolls inside. A long pasted text fits its height and the last line is no longer clipped.",
          tryIt: "Type several lines, then paste a long text.",
        },
      },
    },
    {
      id: "phone-conversation",
      surfaces: ["phone"],
      copy: {
        "ko-KR": {
          title: "폰 대화 머리와 다시 연결",
          changed:
            "대화 맨 위 띠가 없어지고 뒤로, 이름, ⋮ 유리 단추 셋이 떠 있어요. 앱으로 돌아오거나 잠금을 풀면 연결이 더 빨리 돌아오고, 대화 맨 위에서 당기면 연결을 다시 확인해요. 메시지를 길게 누르거나 반응을 달 때 가벼운 진동도 와요.",
          tryIt:
            "대화를 열어 위로 올려 보고, 앱을 잠시 나갔다 돌아와 보세요. 연결이 끊긴 띠가 보이면 「지금 다시 연결」을 눌러 보세요.",
        },
        "en-US": {
          title: "Phone conversation header and reconnecting",
          changed:
            "The band at the top of a conversation is gone: back, the name and ⋮ float as three glass buttons. Coming back to the app or unlocking the phone reconnects sooner, pulling down at the top of a conversation re-checks the connection, and a light tap comes with a long press or a reaction.",
          tryIt:
            "Open a conversation and scroll to the top, then leave the app for a moment and come back. If the disconnected band shows, tap Reconnect now.",
        },
      },
    },
    {
      id: "settings",
      surfaces: ["phone", "desktop"],
      copy: {
        "ko-KR": {
          title: "언어 설정과 폰 테마 고르기",
          changed:
            "설정 › 프로필 › 언어에서 기기 언어 따르기, 한국어, English를 골라요. 바꾸면 바로 적용되지만 아직 모든 화면이 바뀌지는 않아요. 폰은 설정 › 테마 › 테마 스타일이 전체 화면 고르개를 열어요.",
          tryIt:
            "언어를 바꿔 설정 화면의 글자가 바뀌는지 보세요. 폰에서는 테마 스타일도 하나 골라 보세요.",
        },
        "en-US": {
          title: "Language setting and phone theme picker",
          changed:
            "Settings › Profile › Language lets you follow the device language or pick 한국어 or English. It applies at once, though not every screen is translated yet. On the phone, Settings › Theme › Theme style opens a full-screen picker.",
          tryIt:
            "Change the language and check that the settings screen changes. On the phone, also pick a theme style.",
        },
      },
    },
    {
      id: "emoji",
      surfaces: ["phone", "desktop"],
      copy: {
        "ko-KR": {
          title: "이모지와 팀 이모지",
          changed:
            "폰의 반응과 상태에서 표준 이모지를 모두 쓸 수 있어요. 이모지 고르개의 「우리 팀」 칸에서는 팀 이모지, 스티커, GIF를 쓰고 새로 등록해요.",
          tryIt:
            "폰은 빠른 반응 줄의 +를 눌러 이름으로 찾아 보세요. 폰과 데스크탑 모두 이모지 고르개의 「우리 팀」 칸을 열어 보세요.",
        },
        "en-US": {
          title: "Emoji and team emoji",
          changed:
            "On the phone, reactions and status take every standard emoji. The Our team slot of the emoji picker holds team emoji, stickers and GIFs, and you can register new ones.",
          tryIt:
            "On the phone, tap + in the quick reaction row and search by name. On both, open the Our team slot of the emoji picker.",
        },
      },
    },
    {
      id: "agents",
      surfaces: ["phone", "desktop"],
      copy: {
        "ko-KR": {
          title: "에이전트 비용과 DM에 에이전트 부르기",
          changed:
            "에이전트 목록과 프로필에 이번 달 비용이 보이고, 관리자는 월간 보고서를 볼 수 있어요. 사람끼리의 DM에서 에이전트를 부르면 모두에게 동의를 먼저 물어보고, 모두 동의하면 에이전트가 들어와요.",
          tryIt:
            "에이전트 목록과 프로필을 열어 보세요. 관리자라면 데스크탑은 설정 › 사용량, 폰은 설정 › 에이전트 월 보고를 열어 보세요. DM에서는 @로 에이전트를 불러 동의 카드가 뜨는지 봐 주세요.",
        },
        "en-US": {
          title: "Agent costs and calling an agent in a DM",
          changed:
            "Agent lists and profiles show this month's cost, and admins get a monthly report. In a DM between people, calling an agent first asks everyone for consent, and the agent joins once all agree.",
          tryIt:
            "Open the agent list and a profile. As an admin, open Settings › Usage on the desktop or Settings › Monthly report on the phone. In a DM, mention an agent and look for the consent card.",
        },
      },
    },
  ],
};
