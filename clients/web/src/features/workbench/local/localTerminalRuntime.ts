// =============================================================================
// 로컬 터미널 칸의 xterm 런타임 (#2774). `features/work/terminalRuntime.ts`와
// 같은 이유로 한 모듈 뒤에 둔다: 무게(도크를 처음 열 때만 받는다)와 CSS(이
// 모듈을 import하는 청크에 xterm.css가 붙는다).
//
// `@xterm/headless` 6.0.0은 package.json의 `module`이 없는 파일(`lib/xterm.mjs`)을
// 가리킨다. 번들러가 그 필드를 먼저 읽으면 해석에 실패하므로, 실제로 배포된
// ESM 파일을 경로로 가져온다. 형식은 `xtermHeadless.d.ts`가 원래 패키지 형식을
// 다시 내보낸다.
// =============================================================================

import "@xterm/xterm/css/xterm.css";

export { Terminal } from "@xterm/xterm";
export { FitAddon } from "@xterm/addon-fit";
export { SerializeAddon } from "@xterm/addon-serialize";
export { Terminal as HeadlessTerminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
export type { ITheme } from "@xterm/xterm";
