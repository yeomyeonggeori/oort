module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    // `void promise` is how this codebase says "deliberately not awaited", and
    // the places it appears are the ones where awaiting would be the bug: a
    // sign-out must not wait for the server to acknowledge the revocation, and a
    // `refetch()` fired from a retry button has no caller to return to. The
    // alternative the rule pushes toward — dropping the operator — makes those
    // floating promises indistinguishable from forgotten ones, which is the
    // failure the marker exists to prevent. The web client uses the same idiom.
    'no-void': 'off',
  },
  overrides: [
    {
      // Jest globals live in the setup file and the suites, not in app code.
      // Scoped rather than switched on project-wide, so a stray `jest.mock` in
      // `src/` is still an error.
      files: ['jest.setup.js', '__tests__/**/*.{js,ts,tsx}'],
      env: {jest: true},
    },
  ],
};
