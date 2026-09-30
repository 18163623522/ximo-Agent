/**
 * Ximo Icons · 渲染工厂
 *
 * 生成与 lucide-react 组件签名兼容的图标组件：
 * - props: size / strokeWidth / color / absoluteStrokeWidth / className / style / svg 属性透传
 * - 描边默认 XIMO_STROKE（1.6，viewBox 单位）→ 实际渲染厚度 = 1.6 × size / 24：
 *   13px 处 0.87px、24px 处 1.6px，随尺寸等比，小图标不发闷；absoluteStrokeWidth 时改为固定像素
 * - 部件模型：p=路径 / f=填充 / c=圆 / fc=填充圆 / e=椭圆 / d=实心焦点圆点（家族签名）
 */
import { forwardRef } from 'react'
import type { CSSProperties, SVGProps } from 'react'
import type { XimoPart } from './spec-core'
import { XIMO_STROKE } from './stroke'

export interface XimoIconProps
  extends Omit<SVGProps<SVGSVGElement>, 'stroke' | 'strokeWidth' | 'fill'> {
  size?: string | number
  /** 与 lucide 一致，允许 string（如 '2'） */
  strokeWidth?: string | number
  color?: string
  absoluteStrokeWidth?: boolean
  style?: CSSProperties
}

function renderPart(part: XimoPart, key: number, strokeColor: string) {
  const opacity = 'o' in part && part.o !== undefined ? part.o : undefined
  switch (part.t) {
    case 'p':
      return <path key={key} d={part.d} opacity={opacity} />
    case 'f':
      return <path key={key} d={part.d} fill={strokeColor} stroke="none" opacity={opacity} />
    case 'c':
      return <circle key={key} cx={part.x} cy={part.y} r={part.r} opacity={opacity} />
    case 'fc':
      return (
        <circle
          key={key}
          cx={part.x}
          cy={part.y}
          r={part.r}
          fill={strokeColor}
          stroke="none"
          opacity={opacity}
        />
      )
    case 'e':
      return <ellipse key={key} cx={part.cx} cy={part.cy} rx={part.rx} ry={part.ry} opacity={opacity} />
    case 'd':
      return (
        <circle key={key} cx={part.x} cy={part.y} r={part.r} fill={strokeColor} stroke="none" />
      )
  }
}

export function createXimoIcon(displayName: string, parts: XimoPart[]) {
  const Icon = forwardRef<SVGSVGElement, XimoIconProps>(function XimoIcon(props, ref) {
    const {
      size = 24,
      strokeWidth = XIMO_STROKE,
      color,
      absoluteStrokeWidth = false,
      style,
      ...rest
    } = props
    const strokeColor = color ?? 'currentColor'
    const n = Number(size)
    // 描边语义与 lucide 对齐（Icon.js:31）：
    //   默认 → strokeWidth 为 viewBox 单位（随尺寸等比，小图标自动变细，不会发闷）
    //   absoluteStrokeWidth → 固定屏幕像素（strokeWidth * 24 / size）
    // 早前误把默认实现成固定像素，导致 11-13px 小图标上顶着 1.6px 实粗线。
    const sw =
      absoluteStrokeWidth && Number.isFinite(n) && n > 0
        ? Number(strokeWidth) * (24 / n)
        : strokeWidth
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={strokeColor}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={style}
        aria-hidden="true"
        {...rest}
      >
        {parts.map((part, i) => renderPart(part, i, strokeColor))}
      </svg>
    )
  })
  Icon.displayName = displayName
  return Icon
}
