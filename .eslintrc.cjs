/* Root config — workspaces extend this */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint', '@nx'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  ignorePatterns: ['node_modules', 'dist', '.next', 'coverage', '.nx'],
  rules: {
    '@nx/enforce-module-boundaries': [
      'error',
      {
        enforceBuildableLibDependency: false,
        allow: [],
        depConstraints: [
          {
            sourceTag: 'type:app',
            onlyDependOnLibsWithTags: ['type:lib'],
          },
          {
            sourceTag: 'type:lib',
            onlyDependOnLibsWithTags: ['type:lib'],
          },
          {
            sourceTag: 'type:tool',
            onlyDependOnLibsWithTags: ['type:lib', 'type:tool'],
          },
          {
            sourceTag: 'scope:web',
            onlyDependOnLibsWithTags: ['scope:shared'],
          },
          {
            sourceTag: 'scope:api',
            onlyDependOnLibsWithTags: ['scope:shared', 'scope:auth'],
          },
          {
            sourceTag: 'scope:auth',
            onlyDependOnLibsWithTags: ['scope:shared'],
          },
          {
            sourceTag: 'scope:shared',
            onlyDependOnLibsWithTags: ['scope:shared'],
          },
        ],
      },
    ],
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/consistent-type-imports': 'warn',
  },
  overrides: [
    {
      files: ['*.js', '*.cjs'],
      env: { node: true, commonjs: true },
      parserOptions: { sourceType: 'script' },
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
  ],
};
