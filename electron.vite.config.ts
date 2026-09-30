import { resolve, join } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { cpSync, existsSync } from 'fs'

/**
 * Vite 插件：把渲染进程的裸导入 `lucide-react` 重定向到 Ximo 图标桥接层。
 * - 桥接层与兜底包装内部的 `lucide-react` 导入按原包解析（importer 白名单防循环）
 * - 效果：全部存量 `import { X } from 'lucide-react'` 自动渲染 Ximo 字形，
 *   未覆盖的低频图标透传 lucide 原包，视觉同族零破坏
 * - 回退：删除本插件即可整体还原，源码零改动
 */
function ximoLucideBridge() {
  const bridge = resolve(__dirname, 'src/renderer/src/lib/lucide-bridge.ts')
  // 这两个文件需要直接访问 lucide 原包，不能再次重定向（否则成环）
  const exempt = ['lib/lucide-bridge', 'components/icons/ximo/lucide-thin']
  return {
    name: 'ximo-lucide-bridge',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (source !== 'lucide-react') return null
      const imp = importer?.replace(/\\/g, '/')
      if (imp && exempt.some((e) => imp.includes(e))) return null
      return bridge
    }
  }
}

/**
 * Vite 插件：构建后将静态资源复制到输出目录。
 * - Design 资源：design-systems / templates / ui-components / catalog
 * - DeepSeek tokenizer：tokenizer.json / tokenizer_config.json（BPE 分词器词表）
 *
 * 这些文件包含非 JS 资源，Vite 不会打包它们，需要手动复制。
 */
function copyStaticAssets() {
  return {
    name: 'copy-static-assets',
    closeBundle() {
      const outBase = resolve(__dirname, 'out/main')

      // Design 静态资源
      const designBase = resolve(__dirname, 'src/main/tools/Design')
      for (const dir of ['design-systems', 'templates', 'ui-components', 'ui-components-catalog.json']) {
        const src = join(designBase, dir)
        const dest = join(outBase, dir)
        if (existsSync(src)) {
          cpSync(src, dest, { recursive: true })
          console.log(`[copy-static-assets] ${dir} → ${dest}`)
        }
      }

      // DeepSeek tokenizer 词表
      const tokenizerSrc = resolve(__dirname, 'src/main/deepseek/tokenizer')
      const tokenizerDest = join(outBase, 'tokenizer')
      if (existsSync(tokenizerSrc)) {
        cpSync(tokenizerSrc, tokenizerDest, { recursive: true })
        console.log(`[copy-static-assets] tokenizer → ${tokenizerDest}`)
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyStaticAssets()],
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [ximoLucideBridge(), react()],
    build: {
      target: 'esnext',
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        },
        output: {
          manualChunks(id) {
            // 重依赖独立 chunk — 配合 React.lazy / 动态 import 实现按需加载
            if (id.includes('mermaid')) return 'mermaid'
            if (id.includes('react-syntax-highlighter')) return 'syntax-highlighter'
            if (id.includes('react-markdown') || id.includes('remark-gfm')) return 'react-markdown'
            if (id.includes('agents-raw.json')) return 'agents-data'
            if (id.includes('modes/prompts')) return 'mode-prompts'
            // lucide-react 按需导入，但拆分到独立 chunk 避免主包膨胀
            if (id.includes('lucide-react')) return 'lucide-icons'
            if (id.includes('components/icons/ximo')) return 'lucide-icons'
            if (id.includes('lib/lucide-bridge')) return 'lucide-icons'
            if (id.includes('playwright')) return 'playwright'
          }
        }
      }
    }
  }
})
