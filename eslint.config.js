import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // TODO: fix all violations and change to 'error'
      '@typescript-eslint/no-explicit-any': 'warn',
      // Forbid unsafe type assertions like `as unknown as X`
      // TODO: fix all violations and change to 'error'
      '@typescript-eslint/no-unsafe-type-assertion': 'warn',
    },
  },
];
