// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 插件管理（CORE-09）：读插件列表，安装、启用、停用、卸载、升级（SEC-01）。契约见 docs/api-contract.md「插件管理」。
// 写完报 { kind: 'plugin' }，插件列表和对象类型一起刷新。前端的插件加载和撤销由设置页调 core/plugin 做，这里只管接口。
import { useMutation, useQuery } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

/** GET /api/plugins 的一项；enable、disable 的返回也是它 */
export type PluginInfo = {
  id: string
  name: string
  description: string
  /** 二进制里的版本 */
  version: string
  installed: boolean
  /** 状态表里的意愿 */
  enabled: boolean
  /** 现在真的在跑：前端按它决定加载哪些插件 */
  running: boolean
  /** 安装或上次升级时的版本，没装过为空串 */
  installed_version: string
  upgradable: boolean
  installed_at: string | null
  depends: Record<string, string>
  optional_depends: Record<string, string>
  /** 二进制里强依赖它的插件（不论装没装） */
  dependents: string[]
  permissions: string[]
  /** 用户确认过的权限，卸载后保留 */
  permissions_confirmed: string[]
  /** 清单里声明的、要单独申请的权限（如 trade:live）：安装、升级都不授予，在插件自己的设置里申请（TRD-08c）；老后端没有 */
  permissions_separate?: string[]
  permissions_at: string | null
  pending_migrations: number
  jobs: number
  provides: Record<string, string[]>
}

export type PluginInstallResult = { plugin: PluginInfo; backup: string | null }
export type PluginUpgradeResult = { plugin: PluginInfo; backup: string | null; from: string }
export type PluginUninstallResult = { plugin: PluginInfo; data_deleted: boolean; backup: string | null; dropped_tables: string[] }

const path = (id: string, action: string) => `/api/plugins/${encodeURIComponent(id)}/${action}`

export const pluginsApi = {
  list: (signal?: AbortSignal) => requestList<PluginInfo>('/api/plugins', { signal }).then((r) => r.data),
  install: (id: string, permissions: string[]) => request<PluginInstallResult>('POST', path(id, 'install'), { body: { permissions } }),
  enable: (id: string) => request<PluginInfo>('POST', path(id, 'enable'), { body: {} }),
  disable: (id: string) => request<PluginInfo>('POST', path(id, 'disable'), { body: {} }),
  /** permissions 要覆盖新版本新增的权限，没覆盖时 409，error.permissions 列出缺的 */
  upgrade: (id: string, permissions: string[]) => request<PluginUpgradeResult>('POST', path(id, 'upgrade'), { body: { permissions } }),
  /** 删数据时 confirm 必须等于插件 id */
  uninstall: (id: string, opts: { deleteData: boolean }) =>
    request<PluginUninstallResult>('POST', path(id, 'uninstall'), { body: { delete_data: opts.deleteData, confirm: opts.deleteData ? id : '' } }),
  /** 单独申请的权限（TRD-08c）：只接受用户本人在界面上申请，confirm 要等于插件名；插件不同意时 403 */
  grantPermission: (id: string, permission: string, confirm: string) =>
    request<PluginInfo>('POST', path(id, 'permissions/grant'), { body: { permission, confirm } }),
  revokePermission: (id: string, permission: string) => request<PluginInfo>('POST', path(id, 'permissions/revoke'), { body: { permission } }),
}

/** 二进制里的全部插件（已装和可装），按后端登记顺序 */
export function usePlugins() {
  return useQuery({ queryKey: dataKeys.plugins.list, queryFn: ({ signal }) => pluginsApi.list(signal) })
}

/**
 * 停用时要一起停用的插件：已启用、强依赖它的，连同依赖它们的，由远到近排（先停最外层）。
 * dependents 是二进制里的强依赖方，这里再按 enabled 筛
 */
export function enabledDependents(id: string, list: readonly PluginInfo[]): PluginInfo[] {
  const byId = new Map(list.map((p) => [p.id, p]))
  const out: PluginInfo[] = []
  const seen = new Set<string>([id])
  const visit = (x: string) => {
    for (const d of byId.get(x)?.dependents ?? []) {
      const p = byId.get(d)
      if (!p || !p.enabled || seen.has(d)) continue
      seen.add(d)
      visit(d)
      out.push(p)
    }
  }
  visit(id)
  return out
}

/** 安装、升级时要确认的权限：清单里的去掉单独申请的（docs/plugin-api.md 3.2） */
export function installPermissions(p: PluginInfo): string[] {
  const sep = new Set(p.permissions_separate ?? [])
  return (p.permissions ?? []).filter((x) => !sep.has(x))
}

/** 升级新增的权限：新版本清单里有、还没确认过的（docs/plugin-api.md 4.5）；单独申请的不算 */
export function newPermissions(p: PluginInfo): string[] {
  const done = new Set(p.permissions_confirmed ?? [])
  return installPermissions(p).filter((x) => !done.has(x))
}

/** 卸载前要先卸掉的插件：已安装（不论是否启用）、强依赖它的 */
export function installedDependents(id: string, list: readonly PluginInfo[]): PluginInfo[] {
  const p = list.find((x) => x.id === id)
  return (p?.dependents ?? []).map((d) => list.find((x) => x.id === d)).filter((x): x is PluginInfo => !!x && x.installed)
}

/** 安装并启用：界面上是一个动作，后端两步（docs/plugin-api.md 4） */
export function useInstallPlugin() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: async ({ id, permissions }: { id: string; permissions: string[] }) => {
      const r = await pluginsApi.install(id, permissions)
      try {
        const plugin = await pluginsApi.enable(id)
        return { ...r, plugin, enableError: null as unknown }
      } catch (e) {
        // 装上了但没启用起来：照样算装好，错误交给界面提示
        return { ...r, enableError: e }
      }
    },
    onSettled: () => notify({ kind: 'plugin' }),
  })
}

export function useEnablePlugin() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: (id: string) => pluginsApi.enable(id), onSettled: () => notify({ kind: 'plugin' }) })
}

/** 停用；ids 按顺序停（先停依赖方），中途失败就停下，已停的不回滚 */
export function useDisablePlugins() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const done: PluginInfo[] = []
      for (const id of ids) done.push(await pluginsApi.disable(id))
      return done
    },
    onSettled: () => notify({ kind: 'plugin' }),
  })
}

export function useUpgradePlugin() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, permissions }: { id: string; permissions: string[] }) => pluginsApi.upgrade(id, permissions),
    onSettled: () => notify({ kind: 'plugin' }),
  })
}

export function useUninstallPlugin() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, deleteData }: { id: string; deleteData: boolean }) => pluginsApi.uninstall(id, { deleteData }),
    onSettled: () => notify({ kind: 'plugin' }),
  })
}
