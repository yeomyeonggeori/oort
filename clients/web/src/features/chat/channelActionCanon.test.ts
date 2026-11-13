import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// =============================================================================
// 채널 액션 정본이 **하나**인가 (BT-1 / #1929).
//
// 헤더 ⋮ 메뉴와 사이드바 행 우클릭 메뉴는 같은 다섯 가지 일을 한다. 이 파일이
// 재는 것은 한 가지뿐이다: 그 일이 **한 번만 적혀 있는가**.
//
// 왜 소스를 훑는가 — 이 결함은 행동으로 잡히지 않기 때문이다. 두 표면이 알림
// PUT 을 각자 들고 있어도 둘 다 초록으로 통과한다. 갈라지는 것은 **다음 수리**가
// 한쪽에만 들어간 순간이고, 그때는 이미 출하돼 있다. `ChatShell.header.test.ts`
// 가 헤더의 「이름 수정 없음」을 소스에서 재는 것과 같은 갈래의 게이트다.
//
// 재는 방식은 「임포트했는가」가 아니라 **호출이 어디 있는가**다. import 를 세면
// 그 상수의 개명만 막고, 새 파일이 코어 함수를 직접 불러 쓰면 수는 그대로다.
// =============================================================================

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "..");

/** 이 레포는 주석에 반례를 그대로 인용한다. 판정 전에 걷어낸다. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC).map((path) => ({
  path: relative(SRC, path),
  code: codeOnly(readFileSync(path, "utf8")),
}));

function callers(fn: string): string[] {
  const call = new RegExp(`(?<![\\w.])${fn}\\s*\\(`);
  return FILES.filter((file) => call.test(file.code)).map((file) => file.path);
}

function fileCode(path: string): string {
  const found = FILES.find((file) => file.path === path);
  if (!found) throw new Error(`${path} 가 없다 — 파일이 옮겨졌으면 이 게이트를 옮겨라`);
  return found.code;
}

const HEADER = "features/chat/ChannelHeaderMenu.tsx";
const ROW = "features/sidebar/SidebarRowContextMenu.tsx";
const CANON = "features/chat/channelActions.tsx";
// 모델은 코어로 올라갔다(#4229): 폰이 같은 표를 쓴다. 웹 소스를 훑는 이 게이트는 호출자만 세고,
// 모델 본문은 코어 파일을 직접 읽는다 — 파일이 옮겨지면 읽기가 던져 게이트가 조용히 비지 않는다.
const MODEL_CODE = codeOnly(
  readFileSync(
    join(SRC, "..", "..", "..", "packages", "momo-core", "src", "features", "channels", "actionModel.ts"),
    "utf8"
  )
);

describe("실행부는 한 벌이다", () => {
  it("알림 PUT 을 부르는 자리는 정본 하나뿐이다", () => {
    // 두 번째 파일이 나타나면 그 순간 두 메뉴는 갈라질 수 있다.
    expect(callers("setChannelNotificationPref")).toEqual([CANON]);
  });

  it("관리자 길(남의 멤버십 끝내기)과 본인 나가기 길은 다른 함수다 — 나가기는 본인 길 하나다", () => {
    // `removeChannelMember`(`…/members/{id}`)는 소유자·관리자가 **남의** 채널 멤버십을 끝내는 길이다. 에이전트 허브가
    // 에이전트를, 채널 멤버 패널이 사람을 내보낼 때 쓴다(#5778). 「내가 나간다」는 그 길이 아니라 본인 길
    // (`leaveChannel`, `…/members/me`)이다 — 관리자 길로 자기를 지우면 일반 멤버는 403 이었다(#5778 이전).
    // 새 이름이 붙으면 그 자리에서 이유를 적어야 한다.
    expect(callers("removeChannelMember").sort()).toEqual(
      ["features/agentHub/AgentChannelsSection.tsx", "features/channels/useRemoveChannelMember.ts"].sort()
    );
    expect(callers("leaveChannel")).toEqual([CANON]);
    // 「나가기」 흐름 자체 — 실패 문장·확인 문장 — 은 한 벌이다.
    expect(callers("channelLeaveFailure")).toEqual([CANON]);
    expect(callers("channelLeaveConfirmBodyKey")).toEqual([CANON]);
    const dialogs = FILES.filter((file) =>
      /timeline\.channelLeave\.title/.test(file.code)
    ).map((file) => file.path);
    expect(dialogs).toEqual([CANON]);
  });

  it("읽음 광고는 헬퍼 한 곳이다 — 「읽음 처리」가 네 번째 HTTP 호출을 만들지 않았다", () => {
    // ChatShell · 이 메뉴 · useInbox · 「여기부터 안 읽음」은 같은 PUT 이고,
    // 호출은 advertiseReadState 한 곳으로 모인다 (ADR-0178 D6).
    expect(callers("updateReadState").sort()).toEqual(
      ["features/chat/advertiseReadState.ts"].sort()
    );
    // 표면은 어느 것도 직접 부르지 않는다.
    expect(fileCode(HEADER)).not.toMatch(/updateReadState/);
    expect(fileCode(ROW)).not.toMatch(/updateReadState/);
  });

  it("두 표면 어느 쪽도 서버를 직접 부르지 않는다", () => {
    for (const path of [HEADER, ROW]) {
      const code = fileCode(path);
      expect(code).not.toMatch(/setChannelNotificationPref/);
      expect(code).not.toMatch(/removeChannelMember/);
      expect(code).not.toMatch(/useMutation/);
    }
  });
});

describe("한 곳의 수리가 두 표면을 함께 닫는다 (design-review #1937)", () => {
  it("나가기의 낙관 삭제는 정본에서 걷혔다 — 되돌릴 것을 만들지 않는다", () => {
    // H-1: `onMutate` 가 목록을 먼저 편집하면 그 행이 언마운트되고, 확인
    // 다이얼로그가 함께 죽어 「나가는 중」과 실패 배너가 화면에 도달하지 못했다.
    // 두 표면이 같은 결함을 갖고 있었고 이 파일 하나를 고쳐 둘이 닫혔다.
    const canon = fileCode(CANON);
    expect(canon).not.toMatch(/onMutate/);
    expect(canon).not.toMatch(/cancelQueries/);
    // 목록 편집은 서버가 답한 뒤다.
    const success = canon.slice(canon.indexOf("leaveMutation"));
    expect(success).toMatch(/onSuccess[\s\S]{0,600}setQueryData/);
  });

  it("표면 어느 쪽도 자기 나가기 흐름을 갖지 않는다", () => {
    for (const path of [HEADER, ROW]) {
      const code = fileCode(path);
      expect(code).toMatch(/ChannelLeaveConfirmDialog/);
      expect(code).not.toMatch(/setQueryData/);
      expect(code).not.toMatch(/aria-busy/);
    }
  });

  it("메뉴 항목을 잠그는 코드가 정본에도 표면에도 없다", () => {
    // N-1: `States.tsx` 규율 — never disabled, never dimmed. 진행은 낱말과
    // `aria-busy` 가 말한다.
    const canon = fileCode(CANON);
    expect(canon).toMatch(/"aria-busy": busy \|\| undefined/);
    expect(canon).not.toMatch(/disabled: /);
    expect(canon).toMatch(/busyLabel/);
  });
});

describe("두 표면이 같은 모델을 소비한다", () => {
  it("헤더 ⋮ 도 행 우클릭도 항목을 스스로 짓지 않는다", () => {
    for (const path of [HEADER, ROW]) {
      const code = fileCode(path);
      expect(code).toMatch(/ChannelActionMenuItems/);
      expect(code).toMatch(/useChannelActions/);
      expect(code).toMatch(/ChannelLeaveConfirmDialog/);
      // 낱말을 표면이 직접 적으면 두 메뉴가 다른 문장을 말할 수 있다.
      expect(code).not.toMatch(/CHANNEL_LEAVE_LABEL/);
      expect(code).not.toMatch(/channelMuteToggleLabel/);
      expect(code).not.toMatch(/CHANNEL_MARK_READ_LABEL/);
    }
  });

  it("표면별 차이는 모델의 표 하나에만 있다", () => {
    expect(MODEL_CODE).toMatch(/SURFACE_KEYS/);
    // 표면 이름이 모델 밖에서 분기를 만들면 그 표는 정본이 아니다.
    expect(fileCode(HEADER)).toMatch(/surface="header"/);
    expect(fileCode(ROW)).toMatch(/surface="row"/);
  });

  it("인벤토리를 부르는 곳은 모델과 정본뿐이다", () => {
    // 웹에서 부르는 자리는 정본 하나다(모델의 내부 호출은 코어 파일 안이라 이 훑기 밖이다).
    expect(callers("channelActionItemsForSurface")).toEqual([CANON]);
    expect(callers("channelActionAvailability")).toEqual([CANON]);
    // 그리고 정의는 코어에 있다 — 웹에 두 번째 정의가 생기면 폰과 표가 갈라진다.
    expect(MODEL_CODE).toMatch(/export function channelActionAvailability\(/);
    expect(MODEL_CODE).toMatch(/export function channelActionItemsForSurface\(/);
    expect(
      FILES.filter((file) => /function channelActionAvailability\(/.test(file.code))
    ).toEqual([]);
  });
});

describe("#3963: 새 낱말과 새 쓰기 길도 한 곳이다", () => {
  it("두 표면은 새 낱말을 직접 적지 않는다 — 모델과 코어만 안다", () => {
    for (const path of [HEADER, ROW]) {
      const code = fileCode(path);
      expect(code).not.toMatch(/CHANNEL_MARK_UNREAD_LABEL/);
      expect(code).not.toMatch(/CHANNEL_COPY_ID_LABEL/);
      expect(code).not.toMatch(/CHANNEL_COPY_GROUP_LABEL/);
      expect(code).not.toMatch(/DM_CLOSE_LABEL/);
      expect(code).not.toMatch(/channelCopyIdLabel/);
    }
  });

  it("읽지 않음으로 표시도 읽음 광고 헬퍼 한 곳을 지난다(mark_unread 사유)", () => {
    const canon = fileCode(CANON);
    expect(canon).toMatch(/advertiseReadState\(\s*workspaceId,\s*channel\.id,\s*readState\.lastReadSeq,\s*"mark_unread"/);
    // 표면은 어느 쪽도 직접 부르지 않는다.
    for (const path of [HEADER, ROW]) {
      expect(fileCode(path)).not.toMatch(/advertiseReadState/);
      expect(fileCode(path)).not.toMatch(/markUnreadBeforeSeq/);
    }
  });

  it("DM 닫기가 쓰는 자리는 한 훅이다: 서버 쓰기와 옛 원장은 `useDmVisibility` 를 지난다(모듈 정의는 제외)", () => {
    // 행 메뉴·호버 X 가 각자 쓰면 닫는 순서(이웃 → 쓰기 → 착지 → 캐럿)와 서버·원장 갈래가 갈라진다.
    // 두 입구는 사이드바의 `closeDmRow` 하나를 지나고, 그 안의 쓰기는 `useDmClosureActions` 하나가 서버/원장을 고른다.
    const sidebar = "features/sidebar/Sidebar.tsx";
    const module = "features/sidebar/sidebarDmClosure.ts";
    const hook = "features/sidebar/useDmVisibility.ts";
    expect(callers("closeDmOnDevice").sort()).toEqual([module, hook].sort());
    // 다시 열기는 훅(액션·이전)과 사이드바의 「열림」 효과(옛 서버의 원장 항목 지우기)다.
    expect(callers("reopenDmOnDevice").sort()).toEqual([module, hook, sidebar].sort());
    expect(callers("closeDm").sort()).toContain(hook);
    expect(callers("closeDm")).not.toContain(sidebar);
    for (const path of [HEADER, ROW, "features/sidebar/SidebarRow.tsx"]) {
      expect(fileCode(path)).not.toMatch(/closeDmOnDevice|reopenDmOnDevice|localStorage|\bcloseDm\(/);
    }
  });
});

describe("#3963 H1: `/` 가 여는 대화는 한 함수가 고른다", () => {
  it("사이드바와 ChatShell 이 같은 함수를 부르고, 각자 `dms[0]` 폴백을 쓰지 않는다", () => {
    // 둘이 따로 고르면 채널이 없는 멤버의 첫 DM 을 닫았을 때 `/` 가 그 DM 을 도로 열어 닫기가 무반응이
    // 된다(design-review R1 H1). 함수 하나가 닫은 DM 을 후보에서 빼는 일을 지므로 둘은 어긋날 수 없다.
    const sidebar = "features/sidebar/Sidebar.tsx";
    const shell = "features/chat/ChatShell.tsx";
    expect(callers("indexFallbackChannelId").sort()).toEqual(
      ["features/sidebar/sidebarDmClosure.ts", shell, sidebar].sort()
    );
    // 그 함수에 건네는 판정도 한 훅이다(코어 `dmVisibility` 한 함수가 그 뒤에 선다).
    expect(callers("useDmVisibility").sort()).toEqual(
      ["features/sidebar/useDmVisibility.ts", shell, sidebar].sort()
    );
    for (const path of [sidebar, shell]) {
      expect(fileCode(path)).not.toMatch(/dms\[0\]/);
    }
  });
});

describe("게이트가 실제로 파일을 읽고 있다", () => {
  it("훑은 목록에 두 표면과 정본이 전부 들어 있다", () => {
    const paths = FILES.map((file) => file.path);
    expect(paths).toContain(HEADER);
    expect(paths).toContain(ROW);
    expect(paths).toContain(CANON);
    expect(MODEL_CODE.length).toBeGreaterThan(1000);
    // 시험 파일은 세지 않는다: 시험이 코어 함수를 모킹하는 것은 이중화가 아니다.
    expect(paths.filter((path) => /\.test\./.test(path))).toEqual([]);
  });

  it("호출 탐지가 임포트만 보고 초록이 되지 않는다", () => {
    // `import { x }` 는 호출이 아니다. 이 판정이 무너지면 위의 단정들은
    // 「임포트 세기」로 퇴화한다.
    expect(
      callers("thisFunctionDoesNotExistAnywhereInTheClient")
    ).toEqual([]);
    const canon = fileCode(CANON);
    expect(canon).toMatch(/setChannelNotificationPref\(/);
  });
});

// =============================================================================
// N-1 (design-review #1932) — 무리도 표면 분기를 탄다
// =============================================================================

describe("섹션 이동 무리 · 하위 메뉴의 그릇", () => {
  /** 이 파일의 이름 붙은 함수 하나의 본문(다음 최상위 `function` 앞까지). */
  function body(name: string): string {
    const code = fileCode("features/chat/channelActions.tsx");
    const start = code.indexOf(`function ${name}`);
    expect(start).toBeGreaterThan(-1);
    const rest = code.slice(start);
    return rest.slice(0, rest.indexOf("\nfunction ", 1));
  }

  it("`surface` 로 그릇을 고르고, 컨텍스트 메뉴를 하드코딩하지 않는다", () => {
    // 코어 `channels/actionModel.ts` 는 확장점을 「열쇠 하나·분기 하나·SURFACE_KEYS
    // 항목 하나」라고 광고한다. 그 한 줄을 믿고 헤더에 `move-to-section` 을 넣는
    // 사람이 Radix 루트 없는 컨텍스트 메뉴 조각을 렌더하면, 광고한 확장점이
    // 실제로는 그것보다 비쌌던 것이다. #5777 부터는 하위 메뉴(복사 · 섹션 이동)의
    // 여는 줄과 판도 같은 갈래를 탄다.
    const choices = body("ChannelSectionMoveChoices");
    for (const picked of [
      "surface === \"header\" ? DropdownMenuRadioGroup : ContextMenuRadioGroup",
      "surface === \"header\" ? DropdownMenuRadioItem : ContextMenuRadioItem",
    ]) {
      expect(choices).toContain(picked);
    }
    const cluster = body("ChannelActionClusterRows");
    for (const picked of [
      "surface === \"header\" ? DropdownMenuSub : ContextMenuSub",
      "surface === \"header\" ? DropdownMenuSubTrigger : ContextMenuSubTrigger",
      "surface === \"header\" ? DropdownMenuSubContent : ContextMenuSubContent",
    ]) {
      expect(cluster).toContain(picked);
    }
    // 고른 뒤에는 그릇 이름이 본문에 다시 나오지 않는다.
    for (const code of [choices, cluster]) {
      expect(code).not.toMatch(/<ContextMenu[A-Z]/);
      expect(code).not.toMatch(/<DropdownMenu[A-Z]/);
    }
  });
});
