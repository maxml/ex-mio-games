// ESLint ignores dot-directories by default; un-ignore `.storybook` so its config files are
// linted (not flagged as "ignored") when passed explicitly, e.g. by the lint-staged pre-commit hook.
module.exports = {
  ignorePatterns: ['!.storybook'],
};
