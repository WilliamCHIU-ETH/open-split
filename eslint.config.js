import openSplit from "@open-split/eslint-plugin";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
      "**/coverage/**",
      "**/.lighthouseci/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "open-split": openSplit },
    rules: {
      "open-split/no-number-money": "error",
      "open-split/no-ledger-math-outside-core": "error",
      "open-split/no-zod-outside-contracts": "error",
      "open-split/core-no-io": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["apps/web/**/*.tsx"],
    ...jsxA11y.flatConfigs.recommended,
  },
);
