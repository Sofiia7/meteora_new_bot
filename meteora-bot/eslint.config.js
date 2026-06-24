// ESLint 9 flat config (CommonJS — в проекте нет "type":"module").
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // В проекте есть оправданные any (axios-обёртки) с локальными disable-комментами.
      '@typescript-eslint/no-explicit-any': 'off',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
      'no-var': 'error',
    },
  },
];
