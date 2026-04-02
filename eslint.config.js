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
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.ts'],
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
