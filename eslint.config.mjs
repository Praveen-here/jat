import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Logging goes through the sanitising logger, never console (it would bypass redaction).
      'no-console': 'error',
      // Email-derived values must be bound as SQL parameters, never inlined.
      'no-restricted-properties': [
        'error',
        { object: 'sql', property: 'lit', message: 'Inlines values into SQL (injection risk). Use sql`${value}` parameters.' },
        { object: 'sql', property: 'raw', message: 'Inlines text into SQL (injection risk). Use sql`${value}` parameters.' },
      ],
    },
  },
  {
    // The frontend must never import backend code (secrets, DB, tokens).
    files: ['frontend/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/backend/**', 'pg', 'pg-boss', 'pino', 'kysely'] }],
    },
  },
);
