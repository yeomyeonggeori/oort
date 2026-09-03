import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

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
  { ignores: ["dist", "node_modules", "src-tauri", "measure"] },
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
