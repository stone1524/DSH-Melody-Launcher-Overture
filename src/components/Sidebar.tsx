import { Bot, HardDriveDownload, Layers3, Package, Play, Puzzle, Settings, SlidersHorizontal, Sparkles, SquareArrowOutUpRight } from 'lucide-react'
import { APP_BRAND_NAME } from '../constants'
import { HOME_TABS } from '../lib/nav'
import type { HomeTab } from '../types'

/**
 * macOS 风格左侧边栏：窗口红绿灯（左上）+ 品牌区 + 一级导航 + 底部动作。
 * 顶栏导航（TopBar）整体由本组件替代；栏目顺序仍以 src/lib/nav.ts 为单一来源。
 * 拖拽区只盖住红绿灯与品牌两段，导航与按钮保持可点。
 */

const TAB_ICONS: Record<HomeTab, typeof Play> = {
  start: Play,
  packs: Package,
  versions: HardDriveDownload,
  plugins: Puzzle,
  skills: Sparkles,
  presets: SlidersHorizontal,
  agents: Bot,
}

interface SidebarProps {
  activeTab: HomeTab | null
  /** DSH 运行中且有本地 Web 地址时，导航底部出现「打开网页」。 */
  openWebVisible: boolean
  onSelectTab: (tab: HomeTab) => void
  onOpenHarness: () => void
  onOpenSettings: () => void
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}

export function Sidebar({ activeTab, openWebVisible, onSelectTab, onOpenHarness, onOpenSettings, onMinimize, onToggleMaximize, onClose }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-traffic" aria-hidden="false">
        <button type="button" className="traffic-light traffic-close" title="关闭" aria-label="关闭窗口" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
        <button type="button" className="traffic-light traffic-min" title="最小化" aria-label="最小化窗口" onClick={onMinimize}>
          <span aria-hidden="true">−</span>
        </button>
        <button type="button" className="traffic-light traffic-max" title="最大化/还原" aria-label="最大化或还原窗口" onClick={onToggleMaximize}>
          <span aria-hidden="true">+</span>
        </button>
      </div>

      <div className="sidebar-brand">
        <span className="sidebar-logo" aria-hidden="true"><Layers3 size={17} /></span>
        <span className="sidebar-name">{APP_BRAND_NAME}</span>
      </div>

      <nav className="sidebar-nav" aria-label="一级导航">
        {HOME_TABS.map(tab => {
          const Icon = TAB_ICONS[tab.id]
          return (
            <button
              key={tab.id}
              type="button"
              className={`sidebar-item ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => onSelectTab(tab.id)}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          )
        })}
        {openWebVisible && (
          <button type="button" className="sidebar-item sidebar-item-action" onClick={onOpenHarness} title="打开 DSH 网页工作台">
            <SquareArrowOutUpRight size={15} aria-hidden="true" />
            <span>打开网页</span>
          </button>
        )}
      </nav>

      <div className="sidebar-footer">
        <button type="button" className="sidebar-item" onClick={onOpenSettings}>
          <Settings size={15} aria-hidden="true" />
          <span>设置</span>
        </button>
      </div>
    </aside>
  )
}
