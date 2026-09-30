/**
 * Ximo Icons · 立体矢量字形导出（与线稿集并行，不覆盖同名线稿）
 */
import { createSolidIcon } from './create-ximo-solid'
import { SOLID_GLYPHS } from './solid'

function build(name: string) {
  const parts = SOLID_GLYPHS[name]
  if (!parts) throw new Error(`[ximo-solid] missing glyph spec: ${name}`)
  return createSolidIcon(`${name}Solid`, parts)
}

export const BriefcaseSolid = build('Briefcase')
export const Code2Solid = build('Code2')
export const PenToolSolid = build('PenTool')
export const PlusSolid = build('Plus')
export const SearchSolid = build('Search')
export const FolderOpenSolid = build('FolderOpen')
export const FileTextSolid = build('FileText')
export const BrainSolid = build('Brain')
export const ServerSolid = build('Server')
export const UsersSolid = build('Users')
export const SettingsSolid = build('Settings')
export const SparklesSolid = build('Sparkles')

export const SOLID_ICONS = {
  BriefcaseSolid,
  Code2Solid,
  PenToolSolid,
  PlusSolid,
  SearchSolid,
  FolderOpenSolid,
  FileTextSolid,
  BrainSolid,
  ServerSolid,
  UsersSolid,
  SettingsSolid,
  SparklesSolid
}
