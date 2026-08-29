module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    // A conditional hook after an early return shipped once and crashed the
    // app on a route change. The compiler cannot see that; this rule can.
    'plugin:react-hooks/recommended',
  ],
  rules: { '@typescript-eslint/no-explicit-any': 'error' },
  ignorePatterns: ['dist', 'node_modules', 'src-tauri'],
};
