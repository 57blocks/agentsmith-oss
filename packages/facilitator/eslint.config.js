// Base: the recommended presets of ESLint and typescript-eslint, with formatting left to Prettier.
// Size and complexity limits are warnings: they flag code worth a second look without failing the
// build. Change a rule here, in a PR, with the reason in the description.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      // Size and complexity — ESLint's default thresholds, as warnings
      complexity: ['warn', 20],
      'max-depth': ['warn', 4],
      'max-params': ['warn', 4],
      'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],

      // Type-aware rules that catch real bugs: an unawaited or misused Promise
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      '@typescript-eslint/consistent-type-imports': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': 'warn',
    },
  },
  {
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // describe/it callbacks are long by nature; the limit is for production code
    files: ['tests/**/*.ts'],
    rules: { 'max-lines-per-function': 'off' },
  },
  prettier,
);
