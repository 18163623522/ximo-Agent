/**
 * host:build — 把 agent-hostd 打包成单文件 CJS（dist-host/agent-hostd.cjs）
 *
 * 为什么用 esbuild 而不是 tsc：
 * - 依赖图里有 import.meta（SkillStore→rrweb 等），tsc 的 CJS 目标直接报错，
 *   esbuild 降级为 undefined 并告警（这些路径主机运行时不会执行）
 * - 原生支持 @main/@shared 别名，无需运行时重写
 * - 单文件产物 + .cjs 扩展名，规避仓库 "type": "module" 的加载歧义，
 *   systemd 直接 ExecStart=node agent-hostd.cjs
 * electron 保持 external — 运行时由 src/host/electron-shim.ts 的钩子接管
 */
import * as esbuild from 'esbuild'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await esbuild.build({
  entryPoints: [join(root, 'src/host/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: join(root, 'dist-host/agent-hostd.cjs'),
  alias: {
    '@main': join(root, 'src/main'),
    '@shared': join(root, 'src/shared'),
  },
  external: ['electron', 'playwright-core', 'chromium-bidi'],
  sourcemap: false,
  logLevel: 'warning',
  legalComments: 'none',
})

console.log('[host-build] dist-host/agent-hostd.cjs 完成')
