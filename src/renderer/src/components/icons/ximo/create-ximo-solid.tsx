/**
 * Ximo Icons · 立体矢量（2.5D）渲染工厂
 *
 * 与线稿集并行的一套字形语言：用「底色 + 高光 + 暗部 + 挖空细节」四类图层，
 * 光位固定在左上 45°，形成统一的浮雕方向感。
 * - 底色取 currentColor → 跟随主题色，不写死品牌色
 * - 高光/暗部用白/黑半透明叠加 → 无需 defs 渐变，避免多实例 id 冲突
 * - 尺寸/描边缩放语义与线稿集一致，可混排
 */
import { forwardRef } from 'react'
import type { CSSProperties, SVGProps } from 'react'

export type SolidRole = 'base' | 'gloss' | 'shade' | 'detail'

export type SolidPart =
  | { t: 'p'; d: string; role: SolidRole; o?: number; dx?: number; dy?: number }
  | { t: 'sp'; d: string; w: number; role: SolidRole; o?: number; dx?: number; dy?: number }
  | { t: 'c'; x: number; y: number; r: number; role: SolidRole; o?: number }
  | { t: 'e'; cx: number; cy: number; rx: number; ry: number; role: SolidRole; o?: number }
  | { t: 'sc'; x: number; y: number; r: number; w: number; role: SolidRole; o?: number }

const ROLE_OPACITY: Record<SolidRole, number> = {
  base: 1,
  gloss: 0.42,
  shade: 0.16,
  detail: 0.9
}

export interface SolidIconProps
  extends Omit<SVGProps<SVGSVGElement>, 'stroke' | 'strokeWidth' | 'fill'> {
  size?: string | number
  color?: string
  style?: CSSProperties
}

function paint(role: SolidRole, color: string) {
  if (role === 'gloss') return { fill: '#fff', stroke: '#fff' }
  if (role === 'shade') return { fill: '#000', stroke: '#000' }
  if (role === 'detail') return { fill: '#fff', stroke: '#fff' }
  return { fill: color, stroke: color }
}

export function createSolidIcon(displayName: string, parts: SolidPart[]) {
  const Icon = forwardRef<SVGSVGElement, SolidIconProps>(function SolidIcon(props, ref) {
    const { size = 24, color, style, ...rest } = props
    const base = color ?? 'currentColor'
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={style}
        aria-hidden="true"
        {...rest}
      >
        {parts.map((part, i) => {
          const { fill, stroke } = paint(part.role, base)
          const opacity = part.o ?? ROLE_OPACITY[part.role]
          if (part.t === 'p') {
            return (
              <path
                key={i}
                d={part.d}
                fill={fill}
                stroke="none"
                opacity={opacity}
                transform={part.dx || part.dy ? `translate(${part.dx ?? 0} ${part.dy ?? 0})` : undefined}
              />
            )
          }
          if (part.t === 'sp') {
            return (
              <path
                key={i}
                d={part.d}
                fill="none"
                stroke={stroke}
                strokeWidth={part.w}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={opacity}
                transform={part.dx || part.dy ? `translate(${part.dx ?? 0} ${part.dy ?? 0})` : undefined}
              />
            )
          }
          if (part.t === 'c') {
            return <circle key={i} cx={part.x} cy={part.y} r={part.r} fill={fill} stroke="none" opacity={opacity} />
          }
          if (part.t === 'e') {
            return (
              <ellipse
                key={i}
                cx={part.cx}
                cy={part.cy}
                rx={part.rx}
                ry={part.ry}
                fill={fill}
                stroke="none"
                opacity={opacity}
              />
            )
          }
          return (
            <circle
              key={i}
              cx={part.x}
              cy={part.y}
              r={part.r}
              fill="none"
              stroke={stroke}
              strokeWidth={part.w}
              opacity={opacity}
            />
          )
        })}
      </svg>
    )
  })
  Icon.displayName = displayName
  return Icon
}
