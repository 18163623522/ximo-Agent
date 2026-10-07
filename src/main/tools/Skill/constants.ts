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
  // CJS 路径（host 产物）— esbuild 在 CJS 模式下注入 __dirname。
  // typeof 对未声明变量安全（返回 'undefined'），不会抛 ReferenceError。
  // @ts-ignore __dirname 在 ESM 模式下不存在，TS 在 module:ESNext 下可能报错
  if (typeof __dirname === 'string') {
    // @ts-ignore 同上
    return join(__dirname, '../../../node_modules/rrweb/dist/rrweb.umd.cjs')
  }
  // ESM 路径（Electron 主应用）
  // eslint-disable-next-line no-restricted-syntax
  return join(fileURLToPath(new URL('.', import.meta.url)), '../../../node_modules/rrweb/dist/rrweb.umd.cjs')
}
