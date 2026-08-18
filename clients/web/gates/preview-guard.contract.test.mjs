// preview-guard 의 판정 계약 (#1571). 실제 vite 대신 **신호가 같은 픽스처 bin**
// 으로 다섯 갈래를 각각 검증한다 — 진짜 vite 가 정말 이 신호들을 내는지는 레인
// red proof(점유자 실측)와 green 재확인이 담당하고, 여기는 가드의 **판정
// 로직**이 각 신호에 옳게 반응하는지를 dist 없이도 재빨리 고정한다.
//
// 픽스처는 진짜 vite bin 과 같은 `#!/usr/bin/env node` 스크립트다. spawn 인자열이
// ["preview", "--port", <port>, "--strictPort", "--host", <host>] 이므로 포트는
// `process.argv[4]` 에 온다.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startGuardedPreview } from "./preview-guard.mjs";

// it() 의 30초 타임아웃에 대하여: 픽스처 bin 은 매 실행 새로 쓰인 실행 파일이라
// macOS 가 첫 exec 를 검사(syspolicyd)하며 수 초를 지연시킬 수 있다 — vitest
// 기본 5초가 그 지연에 걸리는 것을 실측했다. 단언 자체는 즉시 끝난다.
function fixtureRoot(viteScript) {
  const root = mkdtempSync(resolve(tmpdir(), "preview-guard-"));
  mkdirSync(resolve(root, "node_modules/.bin"), { recursive: true });
  writeFileSync(
    resolve(root, "node_modules/.bin/vite"),
    `#!/usr/bin/env node\n${viteScript}`,
    { mode: 0o755 }
  );
  return root;
}

const LISTEN_AND_ANNOUNCE = `
const http = require("node:http");
const port = Number(process.argv[4]);
const colored = process.env.MODE === "colored";
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("guard fixture");
});
server.listen(port, "127.0.0.1", () => {
  const url = colored
    ? "  \\u2192  \\x1b[36mhttp://127.0.0.1:\\x1b[1m" + port + "\\x1b[22m/\\x1b[39m"
    : "  \\u2192  Local:   http://127.0.0.1:" + port + "/";
  console.log(url);
});
process.on("SIGTERM", () => process.exit(0));
`;

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("preview-guard contract", () => {
  it("resolves only after the child announces its own address, and stop() frees the port", async () => {
    const root = fixtureRoot(LISTEN_AND_ANNOUNCE);
    roots.push(root);
    const server = await startGuardedPreview({ webRoot: root, port: 5471 });
    expect(server.probe.ok).toBe(true);
    expect(await (await fetch(server.origin)).text()).toBe("guard fixture");
    await server.stop();
    await expect(fetch(server.origin)).rejects.toThrow();
  }, 30_000);

  it("still reads the address through ANSI color (picocolors turns on under CI)", async () => {
    const root = fixtureRoot(LISTEN_AND_ANNOUNCE);
    roots.push(root);
    const server = await startGuardedPreview({
      webRoot: root,
      port: 5472,
      env: { ...process.env, MODE: "colored" },
    });
    expect(server.probe.ok).toBe(true);
    await server.stop();
  }, 30_000);

  it("a port squat fails loud and names the escape hatch", async () => {
    const root = fixtureRoot(`
console.error("error when starting preview server:");
console.error("Error: Port " + process.argv[4] + " is already in use");
process.exit(1);
`);
    roots.push(root);
    await expect(
      startGuardedPreview({ webRoot: root, port: 5473, portEnvVar: "X_GATE_PORT" })
    ).rejects.toThrow(
      /GATE FAIL: port 5473 is already served by another process[\s\S]*lsof -nP -iTCP:5473[\s\S]*X_GATE_PORT/
    );
  }, 30_000);

  it("a death that is not the port names its own cause instead (grok L3)", async () => {
    const root = fixtureRoot(
      'console.error("fixture: config exploded");\nprocess.exit(7);\n'
    );
    roots.push(root);
    let error = null;
    try {
      await startGuardedPreview({ webRoot: root, port: 5474 });
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toMatch(/died before it was listening/);
    expect(error?.message).toMatch(/exit code 7/);
    expect(error?.message).toMatch(/config exploded/);
    expect(error?.message).not.toMatch(/already served by another process/);
  }, 30_000);

  it("silence is a failure, not a pass (fail closed on an unknown vite voice)", async () => {
    const root = fixtureRoot(
      'console.log("unrecognised banner");\nsetTimeout(() => {}, 30_000);\n'
    );
    roots.push(root);
    await expect(
      startGuardedPreview({ webRoot: root, port: 5475, timeoutMs: 700 })
    ).rejects.toThrow(/announced neither its address nor a death[\s\S]*unrecognised banner/);
  }, 30_000);
});
