module.exports = {
  root: true,
  extends: '@react-native',
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
