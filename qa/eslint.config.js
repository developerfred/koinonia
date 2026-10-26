// Lints studio/ and tokens/ (they ship no ESLint config of their own) plus qa/ itself.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.zig-cache/**", "**/zig-out/**", "**/coverage/**", "../site/**", "playwright-report/**", "test-results/**", ".out/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-irregular-whitespace": ["error", { skipStrings: true, skipTemplates: true, skipRegExps: true, skipComments: true }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  { files: ["**/*.mjs", "**/*.js"], languageOptions: { globals: { process: "readonly", console: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly", URL: "readonly", fetch: "readonly", setInterval: "readonly", clearInterval: "readonly" } } },
  { files: ["**/webmcp-polyfill.js"], languageOptions: { globals: { window: "readonly", navigator: "readonly" } } },
);
