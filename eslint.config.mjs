import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const layer = (from, patterns) => ({
  files: [`src/${from}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: patterns.map((g) => ({
          group: [g],
          message: `${from} must not import this layer`,
        })),
      },
    ],
  },
});

export default tseslint.config(
  { ignores: ['node_modules', 'out', 'dist', 'release', 'docs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  // Import rules from ARCHITECTURE.md section 3.
  layer('renderer', ['**/main/**', '**/engine/**', '**/preload/**', 'electron', 'node:*']),
  layer('engine', ['**/main/**', '**/renderer/**', '**/preload/**', 'electron']),
  layer('main', ['**/engine/**', '**/renderer/**']),
  layer('shared', [
    '**/main/**',
    '**/engine/**',
    '**/renderer/**',
    '**/preload/**',
    'electron',
    'node:*',
  ]),
);
