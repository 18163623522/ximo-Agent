/**
 * lucide-react 桥接层
 *
 * 渲染进程构建配置将裸导入 `lucide-react` 重定向到本文件：
 * - 未覆盖的图标：从 lucide 原包星号透传（兜底，2px）
 * - 已覆盖的图标：显式导出 Ximo 自绘字形（1.6px，ESM 显式导出优先于星号导出）
 * - 已知兜底图标：显式导出等宽包装版（1.6px，见 AUTO-GENERATED 块）
 * 主进程 / 预加载 / vitest 不经过本桥接，行为不变。
 *
 * 回退方式：删除 electron.vite.config.ts 中的 ximoLucideBridge 插件即可整体还原。
 */
export * from 'lucide-react'

// 真实 lucide 命名空间（本文件在构建白名单内，不会被重定向成环）
import * as LucideReal from 'lucide-react'
import { responsive } from '../components/icons/ximo/responsive'
import {
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
} from '../components/icons/ximo/solid-index'
import {
  Plus as PlusLine,
  Search as SearchLine,
  FolderOpen as FolderOpenLine,
  FileText as FileTextLine,
  Brain as BrainLine,
  Server as ServerLine,
  Users as UsersLine,
  Settings as SettingsLine,
  Sparkles as SparklesLine
} from '../components/icons/ximo'

export {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  X,
  Check,
  Minus,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  AlertCircle,
  Info,
  HelpCircle,
  Ban,
  Clock,
  Loader2,
  Square,
  CircleDot,
  MoreHorizontal,
  MoreVertical,
  Terminal,
  Globe,
  Cpu,
  Box,
  Layers,
  Monitor,
  Copy,
  Trash2,
  Pencil,
  Edit3,
  Send,
  Paperclip,
  AtSign,
  Palette,
  Bot,
  Key,
  Wrench,
  Type,
  MessageSquare,
  Zap,
  Eye,
  Play,
  Upload,
  Download,
  RotateCcw,
  RefreshCw,
  Undo2,
  Reply,
  ExternalLink,
  History,
  Bell,
  Star,
  Sun,
  Moon,
  GitBranch
} from '../components/icons/ximo'

// === 立体矢量（2.5D）覆盖：高频识别位（模式/导航/新建/设置/AI）===
// 这 12 个名字在桥接层改指立体字形 → 全应用 121 个文件零改动自动生效。
// 想回退某个图标：把它从本块移回上面的线稿块即可。
// === 尺寸感知的立体/线稿覆盖 ===============================================
// 12 个高频识别位：≥SOLID_MIN_SIZE(18px) 走立体实心，更小尺寸自动回退精细线稿，
// 避免小图标顶着实心字形发闷发密。全应用 121 文件零改动自动生效。
// 想锁定某图标：把该行改成纯立体（只用 *Solid）或纯线稿（只用线稿组件）即可。
export const Briefcase = responsive(BriefcaseSolid, LucideReal.Briefcase)
export const Code2 = responsive(Code2Solid, LucideReal.Code2)
export const PenTool = responsive(PenToolSolid, LucideReal.PenTool)
export const Plus = responsive(PlusSolid, PlusLine)
export const Search = responsive(SearchSolid, SearchLine)
export const FolderOpen = responsive(FolderOpenSolid, FolderOpenLine)
export const FileText = responsive(FileTextSolid, FileTextLine)
export const Brain = responsive(BrainSolid, BrainLine)
export const Server = responsive(ServerSolid, ServerLine)
export const Users = responsive(UsersSolid, UsersLine)
export const Settings = responsive(SettingsSolid, SettingsLine)
export const Sparkles = responsive(SparklesSolid, SparklesLine)

// === AUTO-GENERATED: lucide 兜底等宽包装 ===
export {
  Activity,
  AlignLeft,
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpNarrowWide,
  BarChart3,
  Bolt,
  BookOpen,
  Bookmark,
  Bug,
  Calendar,
  CalendarDays,
  Camera,
  CheckCircle,
  CheckSquare,
  Circle,
  Clipboard,
  ClipboardCheck,
  Code,
  Coins,
  Columns,
  CornerDownRight,
  Database,
  Droplets,
  EyeOff,
  File,
  FileCheck,
  FileCode,
  FileCode2,
  FileDiff,
  FileEdit,
  FileJson,
  FilePlus,
  Film,
  Filter,
  FlaskConical,
  Folder,
  FolderInput,
  FolderPlus,
  FolderSearch,
  FolderTree,
  Gauge,
  GitCompare,
  GripVertical,
  Hand,
  Hash,
  Home,
  Image,
  Inbox,
  Infinity,
  KanbanSquare,
  Keyboard,
  Layout,
  LayoutDashboard,
  LayoutGrid,
  LayoutPanelTop,
  Library,
  Lightbulb,
  Link,
  Link2,
  List,
  ListChecks,
  ListFilter,
  ListOrdered,
  ListTodo,
  ListTree,
  Lock,
  LogOut,
  Mail,
  Maximize2,
  Menu,
  MessageCircle,
  MessageSquareText,
  MessagesSquare,
  Mic,
  Minimize2,
  MousePointer2,
  Network,
  Package,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  Power,
  Puzzle,
  Radio,
  Redo2,
  Rocket,
  RotateCw,
  Save,
  Scissors,
  SearchCheck,
  SearchCode,
  Share2,
  Shield,
  ShieldCheck,
  Sliders,
  Smartphone,
  Store,
  Table,
  Tag,
  Target,
  ToggleLeft,
  TrendingUp,
  TriangleAlert,
  Unlink,
  User,
  Volume2,
  Wand2,
  Webhook,
  Workflow
} from '../components/icons/ximo/lucide-thin'
// === END AUTO-GENERATED ===
