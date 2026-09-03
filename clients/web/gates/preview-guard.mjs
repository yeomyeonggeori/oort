// 게이트 전용 vite preview 가드 — #1563 이 발견하고 PR #1569 가 한 레인에 넣은
// 규율의 공용 판이다(#1571). 전 레인이 이 모듈로 preview 를 띄운다.
//
// 함정의 모양: 게이트는 `--strictPort` 로 preview 를 띄우는데, 다른 워크트리의
// preview 가 이미 그 포트를 잡고 있으면 우리 서버는 EADDRINUSE 로 **즉시
// 죽는다**. `stdio: "ignore"` 였던 시절 그 죽음은 어디에도 뜨지 않았고, fetch
// 폴링은 **남의 빌드**에 성공해 게이트가 자기 워크트리를 한 줄도 재지 않은 채
// 초록이 됐다(#1563 — 약 40분의 무효 측정).
//
// PR #1569 의 8줄 가드는 첫 응답 뒤 300ms 고정 창 안에서 죽음이 보고되길
// 기대했다 — Vite 가 그보다 늦게 죽으면 fail-open 이다(grok freeze M1). 그래서
// 이 판은 시계를 버리고 **자식의 결정적 신호**만 본다. fetch 는 판정에 쓰지
// 않는다:
//
//   준비    vite 가 stdout 에 자기 주소(`Local: http://127.0.0.1:PORT/`)를
//           인쇄한다 — 커널이 그 bind 를 **우리 자식에게** 내준 뒤에만 나오는
//           줄이고, strictPort 아래에서 그 주소는 요청한 포트 그 자체다. 이
//           줄이 곧 소유 증명이므로, 이 뒤의 응답은 우리 자식일 수밖에 없다.
//   점유    자식이 죽었고 출력에 EADDRINUSE(또는 vite 의 "is already in use")가
//           있다 → 요란한 FAIL. 이 실행이 남의 빌드를 쟀을 판이다.
//   그 외   자식이 그 서명 없이 죽었다 → 포트 탓이 아니다. 사인(死因)을 exit
//           code 와 마지막 출력 그대로 들고 실패한다(grok freeze L3 — 진단이
//           「포트 점유」 하나로 뭉개지면 다른 죽음이 엉뚱한 수리를 부른다).
//   침묵    마감까지 주소도 죽음도 없다 → 그것대로 실패한다. 어느 갈래도
//           fail-open 이 아니다.
//
// 준비 신호는 vite 의 출력 문면에 기대므로, vite 를 올릴 때 이 줄의 모양이
// 바뀌면 게이트는 (초록이 아니라) 침묵 갈래로 요란하게 죽는다 — 그때 이
// 모듈의 READY 판정만 고치면 전 레인이 함께 고쳐진다.

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SQUAT_SIGNATURE = /EADDRINUSE|is already in use/i;

/** picocolors 는 CI 환경변수만 있어도 색을 켠다 — 주소 안의 포트 숫자가 bold
 *  코드로 감싸여 문자열 매칭이 깨진다. NO_COLOR 를 주고, 그래도 벗겨 읽는다. */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * strictPort preview 를 띄우고, **우리 자식이 그 포트를 실제로 들었을 때만**
 * 돌아온다. 그 밖의 모든 갈래는 사인을 구분한 Error 로 던진다.
 *
 * @param {object} options
 * @param {string} options.webRoot     clients/web 절대경로 (vite bin·cwd)
 * @param {number} options.port        레인의 포트
 * @param {string} [options.host]      기본 127.0.0.1
 * @param {object} [options.env]       vite 프로세스 env (기본 process.env)
 * @param {string} [options.portEnvVar] 이 레인의 포트를 옮기는 env 변수 이름 —
 *                                      점유 FAIL 문구의 탈출구 안내에 쓴다
 * @param {number} [options.timeoutMs] 준비 마감 (기본 30초)
 * @returns {Promise<{origin: string, probe: Response, child: import("node:child_process").ChildProcess, stop: () => Promise<void>}>}
 *   probe 는 준비 신호 **뒤의** 첫 응답이다 — 헤더를 검사하는 레인(csp)이 쓴다.
 *   stop() 은 SIGTERM 을 보내고 **실제로 죽을 때까지** 기다린다: 같은 포트를
 *   연이어 strictPort 로 잡는 레인(csp-deploy)이 있어서다.
 */
export async function startGuardedPreview({
  webRoot,
  port,
  host = "127.0.0.1",
  env,
  portEnvVar,
  timeoutMs = 30_000,
}) {
  const origin = `http://${host}:${port}`;
  const child = spawn(
    resolve(webRoot, "node_modules/.bin/vite"),
    ["preview", "--port", String(port), "--strictPort", "--host", host],
    {
      cwd: webRoot,
      env: { ...(env ?? process.env), NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  const exit = { done: false, code: null, signal: null };
  let markExited;
  const exited = new Promise((done) => {
    markExited = done;
  });
  child.on("exit", (code, signal) => {
    exit.done = true;
    exit.code = code;
    exit.signal = signal;
    markExited();
  });
  // spawn 자체가 실패하면(ENOENT 등) 'exit' 는 오지 않는다 — 같은 죽음 갈래로
  // 접는다. 마감까지 침묵하는 판보다 지금 그 사유로 실패하는 편이 낫다.
  child.on("error", (spawnError) => {
    output += `\n${spawnError.message}\n`;
    exit.done = true;
    markExited();
  });

  const lastWords = () =>
    stripAnsi(output).trim().split("\n").slice(-12).join("\n    ");

  const deathError = () => {
    if (SQUAT_SIGNATURE.test(stripAnsi(output))) {
      const escape = portEnvVar ? ` or set ${portEnvVar}` : "";
      return new Error(
        `GATE FAIL: port ${port} is already served by another process, so this run ` +
          `would have measured somebody else's build. ` +
          `Free it (lsof -nP -iTCP:${port})${escape}.`
      );
    }
    return new Error(
      `GATE FAIL: vite preview died before it was listening ` +
        `(exit code ${exit.code}, signal ${exit.signal}) and the output carries no ` +
        `port squat — do not chase a squatter. Its last words:\n    ${lastWords()}`
    );
  };

  // 준비 신호를 기다린다. 고정 검출 창이 없다: 주소·죽음·마감 중 먼저 온 것이
  // 판정이고, 판정 전에는 fetch 를 한 번도 하지 않는다.
  const readyMark = `${origin}/`;
  await new Promise((ready, dead) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      fn(value);
    };
    const onData = () => {
      if (stripAnsi(output).includes(readyMark)) settle(ready);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(
        dead,
        new Error(
          `GATE FAIL: vite preview announced neither its address nor a death ` +
            `within ${timeoutMs} ms. Output so far:\n    ${lastWords()}`
        )
      );
    }, timeoutMs);
    exited.then(() => settle(dead, deathError()));
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    onData(); // 리스너를 달기 전에 이미 도착한 출력도 읽는다.
  });

  // Ready 뒤에도 stdout/stderr 를 비운다. `.off("data")` 만 하면 파이프가
  // paused 가 되고, vite 가 빠진 백엔드로 프록시 오류를 stderr 에 쌓다가
  // 버퍼가 차면 리스너가 죽는다 — 게이트는 한가운데 `ERR_CONNECTION_REFUSED`.
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});

  // 준비 신호 뒤의 첫 응답. 지금 이 포트를 들고 있는 것은 우리 자식뿐이다.
  const deadline = Date.now() + timeoutMs;
  let probe = null;
  for (;;) {
    if (exit.done) throw deathError();
    try {
      const response = await fetch(origin);
      if (response.ok) {
        probe = response;
        break;
      }
    } catch {
      /* 리스너가 accept 를 여는 중 */
    }
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(
        `GATE FAIL: vite preview printed its address but never answered OK on ${origin}.`
      );
    }
    await wait(100);
  }

  return {
    origin,
    probe,
    child,
    async stop() {
      if (exit.done) return;
      child.kill("SIGTERM");
      await Promise.race([exited, wait(5_000)]);
      if (!exit.done) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}
