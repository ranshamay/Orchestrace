import tseslint from 'typescript-eslint';

const relaxRules = {
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  '@typescript-eslint/no-explicit-any': 'warn',
};

export default [
    {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.config.*',
      'smoke_test.ts',
      'temp_script.ts',
      'get_log.ts',
      'get_results.ts',
    ],
  },
  ...tseslint.configs.recommended,
    {
    files: ['packages/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      ...relaxRules,
    },
  },
];
