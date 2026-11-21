module.exports = {
  extends: ['../../.eslintrc.cjs'],
  rules: {
    // Nest resolves constructor dependencies from emitted decorator metadata; a
    // type-only import of an injected class would erase it and break injection.
    '@typescript-eslint/consistent-type-imports': 'off',
  },
};
