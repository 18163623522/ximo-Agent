/* eslint-env node */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  settings: {
    react: { version: 'detect' },
  },
  rules: {
    // 允许 console（Electron 主进程日志常用）
    'no-console': 'off',
    // 允许未使用 vars 以 warn 级别提醒（不阻断构建）
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    // 关闭 require-await（与项目异步风格冲突）
    '@typescript-eslint/require-await': 'off',
    // 允许显式 any（项目中有大量与第三方 API 交互的代码）
    '@typescript-eslint/no-explicit-any': 'off',
    // 关闭 React display-name（函数组件不需要）
    'react/display-name': 'off',
    // 关闭 React prop-types（TS 已处理类型检查）
    'react/prop-types': 'off',
  },
  ignorePatterns: [
    'out/',
    'dist/',
    'dist-host/',
    'release/',
    'node_modules/',
    '*.config.js',
    '*.config.ts',
  ],
  overrides: [
    {
      // host 可移植层 — 这些模块被 esbuild 打包成 CJS 单文件跑在裸 Node 上，
      // import.meta.url 会被降级为 {} 导致 TypeError。
      // 参见 src/host/tools/office-docs-tool.ts 的同类修复说明。
      files: ['src/main/tools/**/*.ts', 'src/main/deepseek/**/*.ts', 'src/host/**/*.ts'],
      rules: {
        'no-restricted-syntax': ['error',
          {
            // 禁止 import.meta.url（import.meta 其他用法不限制）
            selector: "MemberExpression[object.meta='meta'][property='url']",
            message: 'host 可移植层禁止 import.meta.url — esbuild CJS 产物中 import.meta 被降级为 {}，会导致 TypeError。用 __dirname（CJS）或条件检测代替。',
          },
        ],
      },
    },
  ],
}
