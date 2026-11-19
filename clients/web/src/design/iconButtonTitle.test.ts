import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// =============================================================================
// 「아이콘만 있는 단추에는 브라우저 기본 툴팁(`title=`)을 쓰지 않는다」 (#5779, design-system §2.9).
//
// 아이콘 단추의 이름은 `aria-label`이고, 눈으로 보는 이름은 공용 `Tooltip`(0.12초, 키보드 초점에서 즉시, 터치에서는 안 뜸)이다.
// 브라우저 기본 툴팁은 늦게 뜨는 회색 상자라 같은 이름이 두 번(둘이 같이) 뜨거나 아예 다른 모양으로 뜬다.
//
// 가르는 기준(소스의 JSX 속성을 TypeScript로 읽는다): 시험이 아닌 `.tsx`에서 `title` 속성이 달린 요소가
//   · `button` · `Button`이거나,
//   · `aria-label`도 함께 가진 보통 요소(`span` 등)이면 「아이콘 단추의 이름」으로 본다.
// 컴포넌트의 `title` 속성(`SettingsSection title=` 등)은 DOM 툴팁이 아니라 화면 글이라 세지 않는다. `span`·`p`·`h1`에 말줄임된
// 긴 글을 풀어 주는 `title`도 세지 않는다(`aria-label`이 없으면 이름이 아니라 글이다).
//
// 허용은 파일이 아니라 줄마다 이유를 적은 아래 표뿐이다(파일 이름 + `title` 식으로 가른다: 줄 번호는 흔들려서 쓰지 않는다).
// 표에 없는 새 `title` 아이콘 단추는 빨개지고, 표에 있는데 소스에서 사라진 줄도 빨개진다(낡은 허용을 남기지 않는다).
// =============================================================================

const WEB_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = join(WEB_ROOT, "src");

interface Allowed {
  file: string;
  /** `title={…}`의 식 그대로(공백은 하나로 접는다). */
  title: string;
  reason: string;
}

const ALLOWED: readonly Allowed[] = [
  {
    file: "features/agents/ActivityRail.tsx",
    title: "{live ? rail.text : `${rail.text} ${TURN_STALE_SENTENCE}`}",
    reason: "보이는 한 줄이 말줄임되는 에이전트 상태 글의 전문 풀이(단추의 이름은 따로 aria-label). 아이콘 단추가 아니다.",
  },
  {
    file: "features/agents/MessageRunStatus.tsx",
    title: "{text}",
    reason: "보이는 글(에이전트 이름 + 상태)이 긴 줄에서 잘릴 때 전문을 푸는 단추. 글이 보이는 단추라 이름 툴팁이 아니다.",
  },
  {
    file: "features/auth/ClaimPage.tsx",
    title: '{offline ? "오프라인 상태에서는 연결할 수 없습니다." : undefined}',
    reason: "글자가 보이는 제출 단추(비밀번호 설정)가 막힌 까닭을 푸는 설명. 아이콘 단추가 아니다.",
  },
  {
    file: "features/auth/ConnectPage.tsx",
    title: '{online ? undefined : "오프라인 상태에서는 연결할 수 없습니다."}',
    reason: "글자가 보이는 제출 단추(들어가기 · 참여)가 막힌 까닭을 푸는 설명. 로그인 전 화면이라 두 줄(754 · 896)이 같은 식이다. 아이콘 단추가 아니다.",
  },
  {
    file: "features/inbox/MailboxList.tsx",
    title: "{entry.reason}",
    reason: "받은함 한 줄 전체가 단추이고(아바타 · 이름 · 미리보기 글이 보인다) title은 「왜 여기 왔는지」 부가 설명이다. 아이콘 단추가 아니다.",
  },
  {
    file: "features/timeline/AttachmentList.tsx",
    title: "{label}",
    reason: "그림 썸네일 자체가 단추(내용이 그림)이고 title은 파일 이름이다. 아이콘 단추가 아니다(확대 아이콘 단추는 Tooltip으로 옮겼다).",
  },
  {
    file: "features/timeline/QuoteBlock.tsx",
    title: "{QUOTE_JUMP_HINT}",
    reason: "인용 카드 전체가 단추이고 글이 보인다. title은 「원문으로 이동」 안내다. aria-label이 없는 글 단추라 아이콘 단추가 아니다.",
  },
  {
    file: "features/timeline/ReactionChips.tsx",
    title: "{names || undefined}",
    reason: "이모지 + 개수가 보이는 반응 칩이고 title은 「누가 눌렀는지」 이름 목록이다(툴팁이 이름을 말하는 단추가 아니라 정보를 푸는 칩).",
  },
  {
    file: "features/work/ObserverTerminal.tsx",
    title: "{OBSERVER_COUNT_NOTE}",
    reason: "보는 사람 수 숫자가 보이는 span이고 title은 그 숫자의 뜻 풀이다. 단추가 아니다.",
  },
  {
    file: "features/work/TerminalDock.tsx",
    title: "{session.label}",
    reason: "세션 이름 글이 보이는 탭이고(aria-label 없음) title은 말줄임된 이름의 전문이다. 아이콘 단추가 아니다.",
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".tsx") && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

/** 규칙에 걸리는 `title` 속성: 아이콘 단추의 이름 자리. */
function iconTitleHits(): { file: string; title: string }[] {
  const hits: { file: string; title: string }[] = [];
  for (const full of sourceFiles(SRC_DIR)) {
    const source = readFileSync(full, "utf8");
    if (!source.includes("title")) continue;
    const sf = ts.createSourceFile(full, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText() === "title" && node.initializer !== undefined) {
        const element = node.parent.parent;
        const tag = element.tagName.getText();
        const names = node.parent.properties.map((p) => (ts.isJsxAttribute(p) ? p.name.getText() : ""));
        const isButton = tag === "button" || tag === "Button";
        const isNamedPlain = /^[a-z]/.test(tag) && names.includes("aria-label");
        if (isButton || isNamedPlain) {
          hits.push({ file: relative(SRC_DIR, full), title: node.initializer.getText().replace(/\s+/g, " ") });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

describe("아이콘 단추에는 기본 툴팁(title=)을 쓰지 않는다 (#5779)", () => {
  const hits = iconTitleHits();
  const key = (h: { file: string; title: string }) => `${h.file} :: ${h.title}`;

  it("표에 없는 title 단추가 없다(새 아이콘 단추는 공용 Tooltip + aria-label)", () => {
    const allowed = new Set(ALLOWED.map(key));
    expect(hits.map(key).filter((k) => !allowed.has(k))).toEqual([]);
  });

  it("허용 표의 모든 줄이 소스에 아직 있다(낡은 허용을 남기지 않는다)", () => {
    const live = new Set(hits.map(key));
    expect(ALLOWED.map(key).filter((k) => !live.has(k))).toEqual([]);
  });

  it("허용 줄마다 이유가 있다", () => {
    expect(ALLOWED.filter((row) => row.reason.trim().length < 20)).toEqual([]);
  });
});
