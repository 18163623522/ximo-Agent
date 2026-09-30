/**
 * 尺寸感知字形 —— 立体实心与精细线稿按渲染尺寸自动切换
 *
 * 为什么需要：实心字形在 ≥18px 时"有分量、立体"，但在 11-16px 的密集位
 * （侧栏、工具栏、行内）会发闷、并排时显密；线稿在这些小尺寸反而更清晰。
 * 这与 SF Symbols 按场景切换 filled/outline 的思路一致。
 *
 * 阈值集中在 SOLID_MIN_SIZE，想整体偏实心/偏线稿改这一个数即可。
 */
import { forwardRef } from 'react'
import type { ComponentType, ForwardRefExoticComponent, Ref, RefAttributes } from 'react'
import type { SolidIconProps } from './create-ximo-solid'
import { XIMO_STROKE } from './stroke'

export const SOLID_MIN_SIZE = 18

type IconLike = ComponentType<SolidIconProps & { strokeWidth?: string | number }>

export function responsive(
  solid: IconLike,
  line: IconLike,
  threshold = SOLID_MIN_SIZE
): ForwardRefExoticComponent<SolidIconProps & RefAttributes<SVGSVGElement>> {
  const Cmp = forwardRef<SVGSVGElement, SolidIconProps>(function ResponsiveIcon(props, ref) {
    const { strokeWidth, ...rest } = props as SolidIconProps & { strokeWidth?: string | number }
    const n = Number(props.size ?? 24)
    const Use = (Number.isFinite(n) && n < threshold ? line : solid) as ComponentType<
      SolidIconProps & { strokeWidth?: string | number; ref?: Ref<SVGSVGElement> }
    >
    // 关键：回退线稿时必须显式传描边 —— 否则 lucide 用自带的 2，比家族默认 1.6 粗一档
    return <Use {...rest} strokeWidth={strokeWidth ?? XIMO_STROKE} ref={ref} />
  })
  Cmp.displayName = `Responsive(${solid.displayName ?? 'solid'}|${line.displayName ?? 'line'})`
  return Cmp
}
