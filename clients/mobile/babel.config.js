module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // RN's preset transforms class fields before static blocks. These exact runtime
  // packages use static blocks; keep the shipping transform out of app/core code.
  overrides: [{
    test: /node_modules[/\\](?:intl-messageformat|@formatjs[/\\](?:intl-locale|intl-pluralrules|intl-relativetimeformat))[/\\]/,
    plugins: ['@babel/plugin-transform-class-static-block'],
  }],
  // FormatJS's ESM uses static class blocks; the RN preset needs this before class fields.
  // Jest additionally transforms dynamic import; retain its existing adapter.
  env: {
    test: {
      plugins: ['@babel/plugin-transform-class-static-block', '@babel/plugin-transform-dynamic-import'],
    },
  },
};
