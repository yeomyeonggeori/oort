import { useEffect, useId, useState, type FormEvent } from "react";
import { resetUserFonts, setUserFonts, useFontMono, useFontSans } from "@/design/theme";
import {
  canQueryLocalFonts,
  FONT_NAME_MAX,
  loadInstalledFontFamilies,
  parseFontName,
  type InstalledFontsResult,
} from "@/design/userFont";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { SettingsRow } from "./shell/SettingsRow";

// =============================================================================
// 설정 > 모양 > 글꼴 (#3774 단계 2). owner 결정: 기본은 시스템 서체, 사용자가 자기 기기에
// 설치한 글꼴 이름을 넣거나 고른다(VS Code의 font family 설정과 같은 모양).
//
// 베이스라인은 이름 직접 입력이다. `queryLocalFonts`가 있는 곳(Chromium, 보안 컨텍스트)
// 에서만 「설치된 글꼴 불러오기」 단추가 생기고, 불러온 목록은 같은 입력 칸의 후보
// (`<datalist>`, 브라우저 기본 컨트롤)로 붙는다. 데스크탑 앱의 WKWebView에는 이 API가
// 없으므로 입력만 보인다. 앱 안에서 글꼴 목록을 세는 일은 네이티브 의존이 필요해서 후속이다.
//
// 칸은 두 개(본문, 코드)까지다. 저장은 이 기기이고 적용은 즉시다. 이름이 이 기기에
// 없으면 font-family 뒤의 `var(--font-sans|mono)`가 시스템 서체를 대신한다(CSS 폴백).
// =============================================================================

type Kind = "sans" | "mono";

const REASON: Record<"chars" | "long", string> = {
  chars: "글꼴 이름에는 글자, 숫자, 공백, 점, 밑줄, 하이픈, +, &만 쓸 수 있어요.",
  long: `글꼴 이름은 ${FONT_NAME_MAX}자까지만 쓸 수 있어요.`,
};

type ListState = { status: "idle" } | { status: "loading" } | InstalledFontsResult;

export function FontFamilyRows() {
  const fontSans = useFontSans();
  const fontMono = useFontMono();
  const listId = useId();
  const [families, setFamilies] = useState<string[]>([]);
  const [list, setList] = useState<ListState>(
    canQueryLocalFonts() ? { status: "idle" } : { status: "unsupported" }
  );

  async function loadList() {
    setList({ status: "loading" });
    const result = await loadInstalledFontFamilies();
    if (result.status === "ok") setFamilies(result.families);
    setList(result);
  }

  const listHint = listMessage(list, families.length);
  const custom = fontSans !== undefined || fontMono !== undefined;

  return (
    <>
      <datalist id={listId}>
        {families.map((family) => (
          <option key={family} value={family} />
        ))}
      </datalist>
      <SettingsRow
        label="본문 글꼴"
        description="메시지와 설정 같은 앱 전체 글자에 써요. 비워 두면 시스템 서체예요."
        labelId="font-sans-label"
        descriptionId="font-sans-hint"
        stack
      >
        <FontField
          kind="sans"
          stored={fontSans}
          listId={listId}
          families={families}
          placeholder="예: Pretendard"
          testId="font-sans"
        />
      </SettingsRow>
      <SettingsRow
        label="코드 글꼴"
        description="코드 블록, 명령어, 숫자 열에 써요. 비워 두면 시스템 고정폭 서체예요."
        labelId="font-mono-label"
        descriptionId="font-mono-hint"
        stack
      >
        <FontField
          kind="mono"
          stored={fontMono}
          listId={listId}
          families={families}
          placeholder="예: D2Coding"
          testId="font-mono"
        />
      </SettingsRow>
      <SettingsRow
        label="설치된 글꼴"
        description={listHint}
        descriptionId="font-list-hint"
        plain={false}
        testId="font-list"
      >
        {list.status !== "unsupported" ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={list.status === "loading"}
            onClick={() => void loadList()}
            data-testid="font-list-load"
            aria-describedby="font-list-hint"
          >
            {list.status === "ok" ? "글꼴 목록 다시 불러오기" : "설치된 글꼴 불러오기"}
          </Button>
        ) : null}
      </SettingsRow>
      <SettingsRow label="미리보기" description="적용한 글꼴이 이렇게 보여요." stack testId="font-preview-row">
        <div
          data-testid="font-preview"
          className="flex w-full min-w-0 flex-col gap-2 rounded-lg bg-surface-muted p-4"
        >
          <p className="break-keep text-body text-ink">
            오늘 배포는 Friday 오후로 미뤘어요. QA 끝나면 release notes를 채널에 올려 줄래요?
          </p>
          <code className="font-mono break-all text-code text-ink">
            git switch -c fix/3774-font-picker && npm test
          </code>
        </div>
      </SettingsRow>
      <SettingsRow label="되돌리기" description="두 칸을 비우고 시스템 서체로 돌아가요." testId="font-reset-row">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!custom}
          onClick={resetUserFonts}
          data-testid="font-reset"
        >
          기본으로 되돌리기
        </Button>
      </SettingsRow>
    </>
  );
}

function listMessage(list: ListState, count: number): string {
  switch (list.status) {
    case "idle":
      return "이 기기의 글꼴 목록을 불러와 입력 칸의 후보로 보여 줘요. 브라우저가 허용을 물을 수 있어요.";
    case "loading":
      return "설치된 글꼴을 불러오고 있어요.";
    case "ok":
      return count > 0
        ? `설치된 글꼴 ${count}개를 불러왔어요. 위 칸에 글자를 입력하면 후보가 나와요.`
        : "불러올 수 있는 글꼴이 없어요. 이름을 직접 입력해 주세요.";
    case "denied":
      return "글꼴 목록을 볼 권한이 없어요. 브라우저의 사이트 설정에서 허용하거나, 이름을 직접 입력해 주세요.";
    case "error":
      return "글꼴 목록을 불러오지 못했어요. 다시 시도하거나, 이름을 직접 입력해 주세요.";
    case "unsupported":
      return "이 앱에서는 설치된 글꼴 목록을 볼 수 없어요. 글꼴 이름을 직접 입력해 주세요.";
  }
}

function FontField({
  kind,
  stored,
  listId,
  families,
  placeholder,
  testId,
}: {
  kind: Kind;
  stored: string | undefined;
  listId: string;
  families: string[];
  placeholder: string;
  testId: string;
}) {
  const errorId = useId();
  const [draft, setDraft] = useState(stored ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  // 되돌리기나 다른 탭의 변경이 저장값을 바꾸면 칸도 따라간다.
  useEffect(() => {
    setDraft(stored ?? "");
    setProblem(null);
  }, [stored]);

  function commit(value: string) {
    const result = parseFontName(value);
    if (!result.ok) {
      setProblem(REASON[result.reason]);
      return;
    }
    setProblem(null);
    setUserFonts(kind === "sans" ? { fontSans: result.name ?? null } : { fontMono: result.name ?? null });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    commit(draft);
  }

  const applied = parseFontName(draft);
  const unchanged = applied.ok && applied.name === stored;

  return (
    <form onSubmit={onSubmit} className="flex w-full min-w-0 flex-col gap-2" noValidate>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          type="text"
          value={draft}
          list={listId}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={FONT_NAME_MAX * 2}
          aria-labelledby={`font-${kind}-label`}
          aria-describedby={problem ? `font-${kind}-hint ${errorId}` : `font-${kind}-hint`}
          aria-invalid={problem ? true : undefined}
          className={problem ? "border-danger" : undefined}
          data-testid={`${testId}-input`}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            setProblem(null);
            // 후보를 골랐다면(목록과 정확히 같은 이름) 바로 적용한다.
            if (families.includes(value)) commit(value);
          }}
        />
        <Button type="submit" size="sm" disabled={unchanged} data-testid={`${testId}-apply`}>
          글꼴 적용하기
        </Button>
      </div>
      {problem ? (
        <p id={errorId} role="alert" className="break-keep text-meta text-danger" data-testid={`${testId}-error`}>
          {problem}
        </p>
      ) : null}
    </form>
  );
}
