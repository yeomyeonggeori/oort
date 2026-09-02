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
const MODEL = "features/chat/channelActionModel.ts";

describe("실행부는 한 벌이다", () => {
  it("알림 PUT 을 부르는 자리는 정본 하나뿐이다", () => {
    // 두 번째 파일이 나타나면 그 순간 두 메뉴는 갈라질 수 있다.
    expect(callers("setChannelNotificationPref")).toEqual([CANON]);
  });

  it("멤버십 DELETE 의 임자는 둘이고, 둘은 다른 일이다", () => {
    // `removeChannelMember` 자체는 「나가기」 전용 동사가 아니다. 에이전트
    // 허브가 **남(에이전트)의** 채널 멤버십을 관리하며 같은 라우트를 부르는데,
    // 그것은 이 메뉴의 「내가 나간다」와 다른 행위다. 그래서 목록은 둘이고,
    // 새 이름이 붙으면 그 자리에서 이유를 적어야 한다.
    expect(callers("removeChannelMember").sort()).toEqual(
      [CANON, "features/agentHub/AgentChannelsSection.tsx"].sort()
    );
    // 「나가기」 흐름 자체 — 실패 문장·확인 문장 — 은 한 벌이다.
    expect(callers("channelLeaveFailureMessage")).toEqual([CANON]);
    expect(callers("channelLeaveConfirmBody")).toEqual([CANON]);
    const dialogs = FILES.filter((file) =>
      /CHANNEL_LEAVE_CONFIRM_TITLE/.test(file.code)
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
    const model = fileCode(MODEL);
    expect(model).toMatch(/SURFACE_KEYS/);
    // 표면 이름이 모델 밖에서 분기를 만들면 그 표는 정본이 아니다.
    expect(fileCode(HEADER)).toMatch(/surface="header"/);
    expect(fileCode(ROW)).toMatch(/surface="row"/);
  });

  it("인벤토리를 부르는 곳은 모델과 정본뿐이다", () => {
    expect(callers("channelActionItemsForSurface").sort()).toEqual(
      [MODEL, CANON].sort()
    );
    expect(callers("channelActionAvailability").sort()).toEqual(
      [MODEL, CANON].sort()
    );
  });
});

describe("게이트가 실제로 파일을 읽고 있다", () => {
  it("훑은 목록에 두 표면과 정본이 전부 들어 있다", () => {
    const paths = FILES.map((file) => file.path);
    expect(paths).toContain(HEADER);
    expect(paths).toContain(ROW);
    expect(paths).toContain(CANON);
    expect(paths).toContain(MODEL);
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

describe("섹션 이동 무리의 그릇", () => {
  it("`surface` 로 그릇을 고르고, 컨텍스트 메뉴를 하드코딩하지 않는다", () => {
    // `channelActionModel.ts` 는 확장점을 「열쇠 하나·분기 하나·SURFACE_KEYS
    // 항목 하나」라고 광고한다. 그 한 줄을 믿고 헤더에 `move-to-section` 을 넣는
    // 사람이 Radix 루트 없는 컨텍스트 메뉴 조각을 렌더하면, 광고한 확장점이
    // 실제로는 그것보다 비쌌던 것이다.
    const code = fileCode("features/chat/channelActions.tsx");
    const group = code.slice(code.indexOf("function ChannelSectionMoveGroup"));
    const body = group.slice(0, group.indexOf("\nfunction "));
    for (const picked of [
      "surface === \"header\" ? DropdownMenuLabel : ContextMenuLabel",
      "surface === \"header\" ? DropdownMenuRadioGroup : ContextMenuRadioGroup",
      "surface === \"header\" ? DropdownMenuRadioItem : ContextMenuRadioItem",
    ]) {
      expect(body).toContain(picked);
    }
    // 고른 뒤에는 그릇 이름이 본문에 다시 나오지 않는다.
    expect(body).not.toContain("<ContextMenuRadioItem");
    expect(body).not.toContain("<ContextMenuLabel");
  });
});
