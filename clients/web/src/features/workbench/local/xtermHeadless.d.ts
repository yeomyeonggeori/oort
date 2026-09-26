// `@xterm/headless`의 ESM 파일 경로 import에 원래 패키지 형식을 붙인다
// (localTerminalRuntime.ts 머리말).
declare module "@xterm/headless/lib-headless/xterm-headless.mjs" {
  export * from "@xterm/headless";
}
