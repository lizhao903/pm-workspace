// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 外部插件（P1-a）的数据访问：读列表、解析安装来源、安装、启停、卸载。
// 接口形状见 brief §5 / docs/api-contract.md「外部插件（P1-a，草案）」；运行时加载见 core/plugin/external.ts。
// 写操作报 { kind: 'plugin' }，插件列表、对象类型和今日卡片一起刷新（外部插件的模块和槽位也在里面）。
import { useMutation, useQuery } from '@tanstack/react-query'
import { request, requestList } from '../api'
import type {
  ExternalInstallResult, ExternalMarketView, ExternalPreview, ExternalRow, ExternalSource,
} from '../plugin/external' 
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

const BASE = '/api/plugins/external'
const path = (id: string, action: string) => `${BASE}/${encodeURIComponent(id)}/${action}`

export type ExternalAction = 'enable' | 'disable' | 'uninstall'

export const externalPluginsApi = {
  list: (signal?: AbortSignal) => requestList<ExternalRow>(BASE, { signal }).then((r) => r.data),
  /** 读包/目录/Release 元数据并校验，只打算装什么，不改状态 */
  resolve: (source: ExternalSource) => request<ExternalPreview>('POST', `${BASE}/resolve`, { body: { source } }),
  /** 装完默认启用（enable 缺省 true）；confirm_permissions 要覆盖非高风险项 */
  install: (input: { source: ExternalSource; confirmPermissions: string[]; enable?: boolean }) =>
    request<ExternalInstallResult>('POST', `${BASE}/install`, {
      body: { source: input.source, confirm_permissions: input.confirmPermissions, enable: input.enable ?? true },
    }),
  enable: (id: string) => request<ExternalRow>('POST', path(id, 'enable'), { body: {} }),
  disable: (id: string) => request<ExternalRow>('POST', path(id, 'disable'), { body: {} }),
  uninstall: (id: string, deleteData = false) =>
    request<ExternalRow>('POST', path(id, 'uninstall'), { body: { delete_data: deleteData } }),
  /** 只允许 plugin.command.run / plugin.health / plugin.event.deliver（brief §5） */
  call: (id: string, method: string, params?: unknown) =>
    request<unknown>('POST', path(id, 'call'), { body: { method, params: params ?? {} } }),
  /** 单独授予高风险权限（fs:write:any / network:any / process:spawn）；confirm 必须是插件名 */
  grantPermission: (id: string, permission: string, confirm: string) =>
    request<ExternalRow>('POST', path(id, 'permissions/grant'), { body: { permission, confirm } }),
  /** 收回已授予的高风险权限；没授予时也 200 */
  revokePermission: (id: string, permission: string) =>
    request<ExternalRow>('POST', path(id, 'permissions/revoke'), { body: { permission } }),
  /** 升级到新版本包：confirmPermissions 要覆盖新版本的非高风险权限 */
  upgrade: (id: string, source: ExternalSource, confirmPermissions: string[]) =>
    request<ExternalRow>('POST', path(id, 'upgrade'), {
      body: { source, confirm_permissions: confirmPermissions },
    }),
  /** 回到上一版本（代码/清单回滚，数据库迁移不回退） */
  rollback: (id: string) => request<ExternalRow>('POST', path(id, 'rollback'), { body: {} }),
  /** 拉取/校验一个市场索引 URL */
  market: (url: string) => request<ExternalMarketView>('POST', `${BASE}/market`, { body: { url } }),
  /** 重新扫描 --plugin-dev-dir（开发者模式链接安装） */
  reloadDev: () => request<ExternalRow[]>('POST', `${BASE}/dev/reload`, { body: {} }),
}

/** 外部插件列表；接口没有（老程序）或读失败时返回空数组，设置页不报错 */
export function useExternalPlugins() {
  return useQuery({
    queryKey: [...dataKeys.plugins.all, 'external'],
    queryFn: async ({ signal }) => {
      try {
        return await externalPluginsApi.list(signal)
      } catch {
        return []
      }
    },
  })
}

export function useResolveExternalPlugin() {
  return useMutation({ mutationFn: (source: ExternalSource) => externalPluginsApi.resolve(source) })
}

export function useInstallExternalPlugin() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: { source: ExternalSource; confirmPermissions: string[]; enable?: boolean }) =>
      externalPluginsApi.install(input),
    onSettled: () => notify({ kind: 'plugin' }),
  })
}

export function useReloadExternalDev() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: () => externalPluginsApi.reloadDev(),
    onSettled: () => notify({ kind: 'plugin' }),
  })
}

export function useFetchExternalMarket() {
  return useMutation({ mutationFn: (url: string) => externalPluginsApi.market(url) })
}

export function useUpgradeExternalPlugin() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: { id: string; source: ExternalSource; confirmPermissions: string[] }) =>
      externalPluginsApi.upgrade(input.id, input.source, input.confirmPermissions),
    onSettled: () => notify({ kind: 'plugin' }),
  })
}

export function useRollbackExternalPlugin() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => externalPluginsApi.rollback(id),
    onSettled: () => notify({ kind: 'plugin' }),
  })
}

export function useGrantExternalPermission() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: { id: string; permission: string; confirm: string }) =>
      externalPluginsApi.grantPermission(input.id, input.permission, input.confirm),
    onSettled: () => notify({ kind: 'plugin' }),
  })
}

export function useRevokeExternalPermission() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: { id: string; permission: string }) =>
      externalPluginsApi.revokePermission(input.id, input.permission),
    onSettled: () => notify({ kind: 'plugin' }),
  })
}

/** 启用 / 停用 / 卸载共用一个 mutation；成功后刷新插件相关缓存 */
export function useExternalAction() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: { id: string; action: ExternalAction; deleteData?: boolean }) => {
      switch (input.action) {
        case 'enable':
          return externalPluginsApi.enable(input.id)
        case 'disable':
          return externalPluginsApi.disable(input.id)
        case 'uninstall':
          return externalPluginsApi.uninstall(input.id, input.deleteData === true)
      }
    },
    onSettled: () => notify({ kind: 'plugin' }),
  })
}
