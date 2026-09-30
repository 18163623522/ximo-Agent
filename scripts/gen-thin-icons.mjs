#!/usr/bin/env node
/**
 * 生成「lucide 兜底图标等宽包装」与桥接层导出块。
 *
 * 作用：把未自绘的 lucide 图标统一到 XIMO_STROKE 描边，
 *       避免自绘图标（1.6）与兜底图标（lucide 默认 2）混排时粗细跳变。
 *
 * 用法：npm run icons:thin   （或 node scripts/gen-thin-icons.mjs）
 * 产出：
 *   1) src/renderer/src/components/icons/ximo/lucide-thin.tsx
 *   2) 重写 src/renderer/src/lib/lucide-bridge.ts 中 AUTO-GENERATED 标记块
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN = [join(ROOT, 'src/renderer/src'), join(ROOT, 'src/main')]
const THIN_FILE = join(ROOT, 'src/renderer/src/components/icons/ximo/lucide-thin.tsx')
const BRIDGE_FILE = join(ROOT, 'src/renderer/src/lib/lucide-bridge.ts')
const CUSTOM_INDEX = join(ROOT, 'src/renderer/src/components/icons/ximo/index.ts')
const EXTS = new Set(['.ts', '.tsx'])
const SKIP = new Set(['node_modules', 'out', 'release', '.workbuddy'])

/** 收集源码中实际用到的 lucide 具名导入 */
function collectUsed() {
  const names = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (EXTS.has(extname(entry))) {
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
          if (/import\s+type\s*\{/.test(m[0])) continue
          for (const raw of m[1].split(',')) {
            const item = raw.trim()
            // 跳过行内 type 说明符（如 `type LucideIcon`）与空项
            if (!item || item.startsWith('type ')) continue
            const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/)
            const name = asMatch ? asMatch[1] : item
            if (!/^\w+$/.test(name)) continue
            names.add(name)
          }
        }
      }
    }
  }
  for (const dir of SCAN) walk(dir)
  return names
}

/** 自绘字形集合（已由 ximo/index.ts 导出，无需包装） */
function collectCustom() {
  const src = readFileSync(CUSTOM_INDEX, 'utf8')
  const names = new Set([...src.matchAll(/export const (\w+) = build\('(\w+)'\)/g)].map((m) => m[1]))
  // 桥接层里的尺寸感知覆盖位（export const Xxx = responsive(...)）由立体/线稿接管，不该再被兜底包装
  const bridge = readFileSync(BRIDGE_FILE, 'utf8')
  for (const m of bridge.matchAll(/export const (\w+) = responsive\(/g)) names.add(m[1])
  return names
}

const used = collectUsed()
const custom = collectCustom()
const fallback = [...used].filter((n) => !custom.has(n)).sort()

if (!fallback.length) {
  console.log('[gen-thin-icons] 没有需要包装的兜底图标')
  process.exit(0)
}

const thinSrc = `/**
 * ⚠️ 自动生成，请勿手改。
 * 重新生成：npm run icons:thin
 *
 * lucide 兜底图标等宽包装：把描边统一到 XIMO_STROKE（${'${XIMO_STROKE}'}），
 * 与 Ximo 自绘字形混排时粗细一致。
 */
import { forwardRef } from 'react'
import * as L from 'lucide-react'
import type { LucideIcon, LucideProps } from 'lucide-react'
import { XIMO_STROKE } from './stroke'

function thin(Cmp: LucideIcon): LucideIcon {
  const W = forwardRef<SVGSVGElement, LucideProps>(function ThinIcon(props, ref) {
    return <Cmp ref={ref} strokeWidth={XIMO_STROKE} {...props} />
  })
  W.displayName = \`\${Cmp.displayName ?? 'LucideIcon'}·thin\`
  return W as unknown as LucideIcon
}

${fallback.map((n) => `export const ${n} = thin(L.${n})`).join('\n')}
`
writeFileSync(THIN_FILE, thinSrc)

// 重写桥接层的 AUTO-GENERATED 块
const bridge = readFileSync(BRIDGE_FILE, 'utf8')
const START = '// === AUTO-GENERATED: lucide 兜底等宽包装 ==='
const END = '// === END AUTO-GENERATED ==='
const si = bridge.indexOf(START)
const ei = bridge.indexOf(END)
if (si === -1 || ei === -1) {
  console.error('[gen-thin-icons] 桥接层缺少 AUTO-GENERATED 标记块，已跳过桥接更新')
  process.exit(1)
}
const block = `${START}
export {
${fallback.map((n) => `  ${n}`).join(',\n')}
} from '../components/icons/ximo/lucide-thin'
${END}`
writeFileSync(BRIDGE_FILE, bridge.slice(0, si) + block + bridge.slice(ei + END.length))

console.log(`[gen-thin-icons] 兜底包装 ${fallback.length} 个 / 自绘覆盖 ${custom.size} 个`)
