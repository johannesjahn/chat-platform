import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Paths that should never be linted: dependencies, build output, and
  // generated code we don't own.
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "out/**",
      "drizzle/**",
      "web/.tanstack/**",
      "web/src/routeTree.gen.ts",
      "web/src/lib/api-types.ts",
    ],
  },

  // Shared baseline for every TypeScript/JavaScript file in the repo.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Backend + tooling: runs on Bun, so expose Node/Bun globals.
  {
    files: ["src/**/*.ts", "scripts/**/*.ts", "*.ts", "*.js"],
    languageOptions: {
      globals: { ...globals.node, Bun: "readonly" },
    },
  },

  // Frontend: React in the browser.
  {
    files: ["web/**/*.{ts,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // Pinned rather than "detect": the lint job only installs root
    // dependencies, so eslint-plugin-react can't resolve web/'s react
    // package to detect its version and silently falls back to assuming
    // latest, which is non-deterministic across environments.
    settings: { react: { version: "19" } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat["jsx-runtime"].rules,
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },

  // Playwright e2e tests run under Node (not the browser) even though they
  // live under `web/`, and Playwright's fixture API has a parameter
  // literally named `use` — not a React hook, so skip the React-specific
  // rules here and expose Node globals instead of browser ones.
  {
    files: ["web/e2e/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "no-empty-pattern": "off",
    },
  },

  // TanStack Router route files must export a `Route` alongside their
  // component, and shadcn/ui files export variant helpers next to theirs —
  // both are intentional, so the fast-refresh warning is just noise here.
  {
    files: [
      "web/src/routes/**/*.tsx",
      "web/src/router.tsx",
      "web/src/components/ui/**/*.tsx",
    ],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },

  // Disable stylistic rules that would fight Prettier. Must stay last.
  prettier,
);
