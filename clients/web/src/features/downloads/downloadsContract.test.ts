import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "@momo/core/features/attachments/model";
import { DOWNLOAD_RING_STEPS, NOT_OPENED_EXTENSIONS } from "./downloadsModel";

// =============================================================================
// 웹 번들과 셸이 서로 모른 채 같은 약속을 해야 하는 자리들 (#4587). 한쪽만 바뀌면 번들 시험도
// 셸 시험도 각자는 초록이고, 앱 안에서만 조용히 어긋난다. 그래서 이 시험이 양쪽 원본을 읽어 묶는다.
//   1. 「열기」를 거절하는 확장자 목록: 모델(단추를 그리지 않는다)과 셸(실제로 거절한다)이 같은 집합이다.
//   2. 셸의 크기 상한 = 첨부 계약의 상한. 계약이 올라가는 날(#4585) 이 시험이 먼저 빨개진다.
//   3. 다리의 명령 이름·헤더 이름 = 셸의 명령 표·헤더 이름.
//   4. 링의 칸 수 = tokens.css의 칸 규칙(인라인 style이 없어서 CSS가 그린다).
// =============================================================================

const desktopSrc = new URL("../../../../desktop/src-tauri/", import.meta.url);
const read = (url: URL) => readFileSync(fileURLToPath(url), "utf8");
const downloadsRs = read(new URL("src/downloads.rs", desktopSrc));
const buildRs = read(new URL("build.rs", desktopSrc));
const libRs = read(new URL("src/lib.rs", desktopSrc));
const tauriTs = read(new URL("../../lib/tauri.ts", import.meta.url));
const tokensCss = read(new URL("../../design/tokens.css", import.meta.url));
const appShell = read(new URL("../../app/AppShell.tsx", import.meta.url));
const sessionTsx = read(new URL("../../app/session.tsx", import.meta.url));

/** `const NAME: &[&str] = &[ "a", "b", ... ];` 의 문자열들. */
function rustStringList(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = source.indexOf("&[", start);
  const close = source.indexOf("];", open);
  return [...source.slice(open, close).matchAll(/"([^"]*)"/g)].map((match) => match[1] as string);
}

describe("셸과 번들의 약속", () => {
  it("열기를 거절하는 확장자는 모델과 셸이 같은 집합이다", () => {
    const shell = rustStringList(downloadsRs, "NOT_OPENED_EXTENSIONS");
    expect(shell.length).toBeGreaterThan(40);
    expect(new Set(NOT_OPENED_EXTENSIONS)).toEqual(new Set(shell));
    // 중복도 없다: 목록이 부풀어 같은 말을 두 번 하지 않는다.
    expect(new Set(shell).size).toBe(shell.length);
    expect(new Set(NOT_OPENED_EXTENSIONS).size).toBe(NOT_OPENED_EXTENSIONS.length);
    // 실행·설치하는 대표 종류는 확실히 들어 있다(목록이 통째로 비는 사고를 막는다).
    for (const risky of ["command", "terminal", "pkg", "mobileconfig", "exe", "sh", "jar", "html"]) {
      expect(shell, risky).toContain(risky);
    }
  });

  it("셸의 크기 상한은 첨부 계약의 상한과 같다", () => {
    const match = /const MAX_DOWNLOAD_BYTES: usize = (\d+) \* 1024 \* 1024;/.exec(downloadsRs);
    expect(match, "MAX_DOWNLOAD_BYTES").not.toBeNull();
    expect(Number(match?.[1]) * 1024 * 1024).toBe(MAX_ATTACHMENT_BYTES);
  });

  it("다리가 부르는 명령은 셸의 명령 표에 있고 헤더 이름이 같다", () => {
    const called = [...tauriTs.matchAll(/"(download_[a-z_]+)"/g)].map((match) => match[1] as string);
    expect(new Set(called)).toEqual(
      new Set(["download_save", "download_probe", "download_reveal", "download_open", "download_folder_open"])
    );
    const manifest = new Set(rustStringList(buildRs, "APP_COMMANDS"));
    for (const command of new Set(called)) {
      expect(manifest.has(command), `${command} in build.rs APP_COMMANDS`).toBe(true);
      expect(libRs, `${command} in lib.rs`).toContain(`downloads::${command}`);
    }
    const header = /const NAME_HEADER: &str = "([^"]+)";/.exec(downloadsRs)?.[1];
    expect(header).toBe("x-oort-file-name");
    expect(tauriTs).toContain(`"${header}": encodeURIComponent(name)`);
  });

  it("셸의 명령은 파일을 이름으로만 받는다(요청에 경로 필드가 없다)", () => {
    const fields = [...downloadsRs.matchAll(/pub struct (NameRequest|ProbeRequest) \{\s*pub ([a-z_]+):/g)].map(
      (match) => [match[1], match[2]]
    );
    expect(fields).toEqual([
      ["NameRequest", "file_name"],
      ["ProbeRequest", "file_names"],
    ]);
  });
});

describe("앱 안의 자리", () => {
  it("상단 줄의 오른쪽 자리를 다운로드 단추가 채운다(앱 셸이 trailing을 넘긴다)", () => {
    // `<AppTitlebar` 뒤, 다음 형제 `<Sidebar` 앞에 그 prop이 있다(다른 요소의 prop이 아니다).
    expect(appShell).toMatch(
      /<AppTitlebar\b(?:(?!<Sidebar\b)[\s\S])*?trailing=\{<DownloadButton \/>\}/
    );
    expect(appShell).toContain('import { DownloadButton } from "@/features/downloads/DownloadButton";');
  });

  it("로그아웃과 로그인 만료가 기록을 지운다(부르는 자리가 둘이다)", () => {
    expect(sessionTsx.match(/clearDownloadHistory\(\)/g)).toHaveLength(2);
  });
});

describe("링의 칸", () => {
  it("1부터 칸 수까지 칸마다 호의 비율 규칙이 있고, 길이를 모르는 링은 4분의 1이다", () => {
    const fill = (step: string): number | null => {
      const rule = new RegExp(
        String.raw`\.download-ring\[data-ring-step="${step}"\]\s*\{\s*--download-ring-fill:\s*([0-9.]+)%;`
      ).exec(tokensCss);
      return rule === null ? null : Number(rule[1]);
    };
    for (let step = 1; step <= DOWNLOAD_RING_STEPS; step += 1) {
      const value = fill(String(step));
      expect(value, `step ${step}`).not.toBeNull();
      expect(value as number).toBeCloseTo((step / DOWNLOAD_RING_STEPS) * 100, 2);
    }
    expect(fill("unknown")).toBe(25);
    // 칸 밖의 값은 규칙이 없다(깨진 값이 조용히 그려지지 않는다).
    expect(fill("0")).toBeNull();
    expect(fill(String(DOWNLOAD_RING_STEPS + 1))).toBeNull();
  });

  it("링과 점의 색은 토큰이다(원색 리터럴이 없다)", () => {
    const start = tokensCss.indexOf(".download-ring {");
    const end = tokensCss.indexOf("/* S1/S2 스텝 크롬");
    const block = tokensCss.slice(start, end);
    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
    expect(block).toContain("var(--ink)");
    expect(block).toContain("var(--signal)");
    expect(block).toContain("var(--danger)");
  });
});
