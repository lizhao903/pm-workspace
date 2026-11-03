import { ConfirmDialog } from '../ui'
import { canInstallSome, missingText, type MissingPlugin } from './workspace'

export const PLUGINS_PATH = '/settings/plugins'

/**
 * 缺插件的提示（docs/plugin-api.md 第 6 节）：列出缺哪些、能去插件管理页装；「先不装」照样继续，缺的模块不在菜单里出现。
 * Esc、点遮罩、「取消」什么都不做
 */
export function MissingPluginsDialog({ name, missing, proceedLabel, onInstall, onProceed, onCancel }: {
  name: string
  missing: readonly MissingPlugin[]
  proceedLabel: string
  onInstall: () => void
  onProceed: () => void
  onCancel: () => void
}) {
  const installable = canInstallSome(missing)
  return (
    <ConfirmDialog open title={`「${name}」需要的插件还没装好`} impactsTitle="缺这些插件" impacts={missing.map(missingText)}
      confirmLabel={proceedLabel} onConfirm={onProceed} onCancel={onCancel}>
      <p className="ws-prompt-p">先不装也能用，缺的模块不在菜单里出现，插件装好启用后自动出现。</p>
      {installable
        ? <p className="ws-prompt-p"><button type="button" className="ws-link" onClick={onInstall}>去插件管理安装</button></p>
        : <p className="ws-prompt-p ws-prompt-muted">尚未提供的插件现在还装不了。</p>}
    </ConfirmDialog>
  )
}
