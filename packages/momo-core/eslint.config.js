import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The core's own flat config (ESLint 9).
 *
 * It carries the same purity rule as `scripts/purity.mjs`, on purpose and with a
 * different mechanism: this one is SCOPE-AWARE (a local variable named `window`
 * is fine, a free reference to the global is not) and fires in the editor while
 * you type. The script is the one CI can trust with no eslint installed, and it
 * additionally checks things a lint rule cannot see — file extensions, and the
 * package's own dependency list.
 *
 * Neither is decoration: the whole value of packages/momo-core is that it runs
 * unchanged under Metro/Hermes, and every entry below is something that compiles
 * on web and then breaks — or worse, silently no-ops — on a phone.
 */
export default tseslint.config(
  { ignores: ["node_modules"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-globals": [
        "error",
        ...[
          "window",
          "document",
          "localStorage",
          "sessionStorage",
          "navigator",
          "history",
          "location",
          "alert",
          "confirm",
          "matchMedia",
          "getComputedStyle",
          "requestAnimationFrame",
          "process",
          "require",
          "__dirname",
        ].map((name) => ({
          name,
          message:
            "Platform global. The core takes platform facts as parameters (see notifications/model.ts) or reads them through src/runtime/host.ts.",
        })),
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/*"],
              message:
                '"@/" is the web client\'s alias. The core must not import from clients/web.',
            },
            {
              group: [
                "react",
                "react/*",
                "react-dom",
                "react-dom/*",
                "react-native",
                "react-native/*",
                "react-router",
                "react-router-dom",
                "@react-native/*",
                "@tanstack/*",
                "@tauri-apps/*",
                "@radix-ui/*",
                "@xterm/*",
                "centrifuge",
                "livekit-client",
                "lucide-react",
                "clsx",
                "tailwind*",
                "class-variance-authority",
                "cmdk",
                "expo*",
              ],
              message:
                "UI / platform / transport package. Its interface belongs in the core; its implementation belongs in a host client.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MetaProperty[meta.name='import']",
          message:
            "`import.meta` is bundler-specific and does not exist under Metro/Hermes. Configuration arrives through src/runtime/host.ts.",
        },
      ],
    },
  }
);
