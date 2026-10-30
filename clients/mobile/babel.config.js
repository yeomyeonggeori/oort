module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // FormatJS's ESM uses static class blocks; the RN preset needs this before class fields.
  // Keep this test adapter scoped to Jest. Shipping Metro integration belongs to P0-4.
  env: {
    test: {
      plugins: ['@babel/plugin-transform-class-static-block', '@babel/plugin-transform-dynamic-import'],
    },
  },
};
