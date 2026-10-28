import { useState } from 'react'
import { useNavigate } from 'react-router'
import { usePlugins, type Workspace } from '../data'
import { missingPlugins, setCurrentWorkspace, type MissingPlugin } from './workspace'
import { MissingPluginsDialog, PLUGINS_PATH } from './WorkspacePrompt'

/**
 * 切换工作台：需要的插件都在跑就直接切，缺了先提示。切换只改记下的当前工作台（菜单跟着变），不清任何缓存。
 * onSwitched 在切过去之后调（外壳拿来打开默认模块）；选「去插件管理安装」时切过去再打开插件管理页，不调它
 */
export function useWorkspaceSwitch(onSwitched?: (w: Workspace) => void) {
  const plugins = usePlugins()
  const navigate = useNavigate()
  const [pending, setPending] = useState<{ w: Workspace; missing: MissingPlugin[] } | null>(null)

  const done = (w: Workspace, toPlugins = false) => {
    setCurrentWorkspace(w.id)
    if (toPlugins) void navigate(PLUGINS_PATH)
    else onSwitched?.(w)
  }
  // 插件列表还没取到或取失败时不拦着
  const switchTo = (w: Workspace) => {
    const missing = plugins.data ? missingPlugins(w.plugins, plugins.data) : []
    if (missing.length) setPending({ w, missing })
    else done(w)
  }
  const prompt = pending && (
    <MissingPluginsDialog name={pending.w.name} missing={pending.missing} proceedLabel="先不装，照样切换"
      onInstall={() => { setPending(null); done(pending.w, true) }}
      onProceed={() => { setPending(null); done(pending.w) }}
      onCancel={() => setPending(null)} />
  )
  return { switchTo, prompt }
}
