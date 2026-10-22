import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', 'packages/client/src/generated/**'] },
  {
    // An eslint-disable comment would defeat the rules below, so inline directives are ignored (and reported as warnings,
    // which `eslint --max-warnings 0` turns into a failure).
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    languageOptions: { globals: globals.node },
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Wire types come from the generated schema; a cast would hide a drift the compiler should report. `as const` stays legal.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    // The scripts are plain Node ESM, type-checked by tsc through JSDoc (checkJs), not by typed linting.
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
