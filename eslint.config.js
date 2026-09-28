import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Coding-standards enforcement for the refund decision system.
 * Each block names the rule from the project's standards list that it enforces.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The root tsconfig.json covers the build and tool configs; each package
        // brings its own for its sources.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // --- Rule 7: check return values -----------------------------------------
  // No floating promises (unchecked rejections), no unchecked `any` flow, and
  // non-null assertions are banned outright: `x!` is how a null dereference
  // enters a language that has no pointers.
  {
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },

  // --- Rule 8: minimise ambient / escape hatches ----------------------------
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-empty-object-type': 'error',
    },
  },

  // --- Rule 1: avoid complex control flow -----------------------------------
  {
    rules: {
      complexity: ['error', 10],
      'max-depth': ['error', 4],
      'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
      'max-statements': ['error', 30],
      'no-nested-ternary': 'error',
    },
  },

  // --- Rule 2: no infinite loops -------------------------------------------
  {
    rules: {
      'no-constant-condition': ['error', { checkLoops: true }],
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
    },
  },

  // --- Rule 10: complete all warnings ---------------------------------------
  {
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },

  // --- Test files relax function-length: table-driven cases read better long.
  {
    files: ['**/src/test/**/*.ts', '**/*.test.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-statements': 'off',
      complexity: 'off',
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/shop/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-console': 'off',
    },
  },

  {
    files: ['apps/api/**/*.ts', 'packages/shared/**/*.ts', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
