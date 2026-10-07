/**
 * Skill 工具目录共享常量
 *
 * 原先 RrwebReplayer.ts 和 RrwebRecorder.ts 各自构建 RRWEB_BUNDLE_PATH，
 * 现统一导出。
 */
import { join } from 'path'
import { fileURLToPath } from 'url'

/**
 * rrweb UMD bundle 的文件路径 — 兼容 ESM（Electron 主应用）与 CJS（host 产物）。
 *
 * 不能直接用 import.meta.url：host 产物是 esbuild CJS 单文件，import.meta 被
 * 降级为 {}，new URL('.', undefined) 抛 TypeError: Invalid URL，导致 skill
 * 模块组加载失败、四个工具被 lazy-registry 静默吞错过滤。
 * 也不能直接用 __dirname：ESM 环境下不存在该变量。
 * 运行时检测可用的来源，两者取其一。
 */
export function rrwebBundlePath(): string {
  // CJS 路径（host 产物）— __dirname 由 esbuild 注入
  // 用 globalThis 访问绕过 TS 静态类型推导（@types/node 声明 __dirname 为 string）
  if (typeof (globalThis as Record<string, unknown>).__dirname === 'string') {
    return join((globalThis as { __dirname: string }).__dirname, '../../../node_modules/rrweb/dist/rrweb.umd.cjs')
  }
  // ESM 路径（Electron 主应用）
  // eslint-disable-next-line no-restricted-syntax
  return join(fileURLToPath(new URL('.', import.meta.url)), '../../../node_modules/rrweb/dist/rrweb.umd.cjs')
}
