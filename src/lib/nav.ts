// 一级导航栏目的单一来源：数组顺序即顶栏从左到右的显示顺序。
// 顶栏（TopBar）与 keep-mounted 渲染顺序（App）都必须从这里取，
// 否则会出现「顺序改了但页面挂载顺序没改」的两份硬编码不同步问题。

import type { HomeTab } from '../types'

export interface HomeTabDefinition {
  id: HomeTab
  label: string
}

/**
 * 侧栏显示的导航（Agent Hub Edition 精简）：启动 / Agent 工具 / 插件 / 技能 / 预设。
 * 整合包与 DSH 版本两个管理页不在侧栏露出——入口收进「设置」对话框，
 * 页面本体仍可渲染（HOME_TAB_ORDER 保留全部，keep-mounted 与跳转同源）。
 */
export const HOME_TABS: ReadonlyArray<HomeTabDefinition> = [
  { id: 'start', label: '启动' },
  { id: 'agents', label: 'Agent 工具' },
  { id: 'plugins', label: '插件' },
  { id: 'skills', label: '技能' },
  { id: 'presets', label: '预设' },
]

/** 面板挂载顺序（含不在侧栏露出的管理页），派生自全量 tab 集。 */
export const HOME_TAB_ORDER: HomeTab[] = [...HOME_TABS.map(tab => tab.id), 'packs', 'versions']

/** 「设置」对话框里的管理入口：收进设置的其余页面。 */
export const SETTINGS_MANAGE_ENTRIES: ReadonlyArray<HomeTabDefinition> = [
  { id: 'packs', label: '整合包管理' },
  { id: 'versions', label: 'DSH 版本管理' },
]
