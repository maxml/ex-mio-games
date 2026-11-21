module.exports = {
  extends: ['../../.eslintrc.mvc.cjs'],
  overrides: [
    {
      // The database tests (`*.pgtest.ts`) inspect and tamper with the tables on purpose, as a
      // superuser connection next to the runtime role: raw SQL is their job, in any directory.
      files: ['src/**/*.pgtest.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ],
};
