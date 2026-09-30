import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  // tests/ui 下的组件测试需要 JSX automatic runtime
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'tests/**/*.spec.ts'
    ],
    coverage: {
      provider: 'v8',
      include: ['src/shared/**/*.ts', 'src/main/**/*.ts'],
      exclude: [
        'src/main/index.ts',
        'src/main/ipc/**',
        'src/main/tools/**/*.ts',
        'src/main/deepseek/tokenizer.ts',
        'src/**/*.d.ts',
        'src/**/*.json'
      ]
    }
  }
})
