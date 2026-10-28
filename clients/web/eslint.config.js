import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { busyLockPlugin } from "./eslint-rules/busyLockGrammar.js";
import { BUSY_LOCK_GRAMMAR_FILES, BUSY_LOCK_PRIMITIVES_FILE } from "./eslint-rules/busyLockScope.js";

/**
 * Flat config (ESLint 9). Beyond the stock TS/React rules this file carries two
 * momo design guards that the grep pre-flight also checks, so a violation fails
 * at `npm run lint` instead of at review time:
 *
 *   1. no JSX `style={{...}}` — the Tauri/web shell runs under CSP
 *      `style-src 'self'`, and inline style is also the classic slop vector.
 *   2. no raw color literal in a source string — color comes from the Dawn
 *      tokens in src/design/tokens.css, never from a hex typed in a component.
 */
export default tseslint.config(
  { ignores: ["dist", "node_modules", "src-tauri"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2021 },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='style']",
          message:
            "Inline style is blocked by CSP style-src 'self'. Use a Tailwind class bound to a Dawn token.",
        },
        {
          selector: "Literal[value=/#[0-9a-fA-F]{6}\\b/]",
          message:
            "Raw color literal. Color lives in src/design/tokens.css and reaches components as a token utility.",
        },
      ],
    },
  },
  {
    // 진행·잠금 문법의 전수 규칙 (#4711, 옛 settingsFieldsBusy·rawControlBusySplit 의 그물).
    // `<SaveButton canSave>`·`<ChoiceRadios disabled>` 에 진행 어휘가 접혀 들어오지 않는다.
    // 규칙 정의와 이유는 eslint-rules/busyLockGrammar.js. 시험 파일(.test.tsx)은 뺀다: 진행 중
    // 상태를 일부러 그려 보이는 식을 쓸 수 있다(옛 그물은 시험 .tsx 도 훑었지만 그 안에 두
    // 컴포넌트의 소비는 하나도 없었다).
    files: ["src/features/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    plugins: { momo: busyLockPlugin },
    rules: { "momo/in-flight-lock-props": "error" },
  },
  {
    // 쓰기를 내는 설정·호스티드 표면의 진행·잠금 문법 (#4711). 범위 목록과 이유는
    // eslint-rules/busyLockScope.js (옛 시험 셋이 이름을 달아 재던 열한 파일).
    files: BUSY_LOCK_GRAMMAR_FILES,
    plugins: { momo: busyLockPlugin },
    rules: { "momo/busy-lock-grammar": "error" },
  },
  {
    // 위 규칙이 이름으로 겨누는 컴포넌트(SaveButton·ConfirmButton·ChoiceRadios)의 정의 파일 (#4711).
    // 이름이 바뀌어 규칙이 조용히 눈먼 초록이 되지 않게 한다.
    files: [BUSY_LOCK_PRIMITIVES_FILE],
    plugins: { momo: busyLockPlugin },
    rules: { "momo/busy-lock-primitives": "error" },
  },
  {
    // Vendored shadcn/ui primitives export their cva() variants by convention.
    files: ["src/design/ui/**/*.tsx"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // The palette verifier is the one place allowed to name hex values: it
    // parses tokens.css and measures it, so the literals ARE the assertion.
    files: [
      "src/design/tokens.contrast.test.ts",
      // 같은 성격: 액센트 카탈로그 대비 시험은 측정할 hex 자체를 들어야 한다 (ADR-0174 D5, BZ-5a #1868).
      "src/design/themes/catalog.contrast.test.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // Gate runners and capture scripts are Node, but their page.evaluate()
    // bodies are serialized into the browser, so both global sets apply.
    files: ["gates/**/*.mjs", "scripts/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
  }
);
