// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 插件详情抽屉：版本、依赖、权限、提供的扩展点；底栏是这个插件当下能做的操作。照原型 ConnectorDrawer 的头像加分组
import type { ReactNode } from 'react'
import type { PluginInfo } from '../../../core/data'
import { Drawer, Pill } from '../../../core/ui'
import { nameOf, permissionInfo, pluginStatus, providedGroups, RISK_LABEL, STATUS_VIEW } from './labels'

const when = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '')

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="plg-row">
      <span className="plg-row-label">{label}</span>
      <span className="plg-row-value">{children}</span>
    </div>
  )
}

export function PluginLogo({ name, size = 36 }: { name: string; size?: number }) {
  return <span className="plg-logo" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">{name.slice(0, 1)}</span>
}

export function PluginDrawer({ plugin, list, actions, onClose }: {
  plugin: PluginInfo
  list: readonly PluginInfo[]
  /** 底栏操作，由列表页按状态给 */
  actions: ReactNode
  onClose: () => void
}) {
  const st = STATUS_VIEW[pluginStatus(plugin)]
  const deps = Object.entries(plugin.depends ?? {})
  const optional = Object.entries(plugin.optional_depends ?? {})
  const groups = providedGroups(plugin)
  const separate = new Set(plugin.permissions_separate ?? [])
  const depState = (id: string) => {
    const p = list.find((x) => x.id === id)
    if (!p) return '二进制里没有'
    return STATUS_VIEW[pluginStatus(p)].label
  }
  return (
    <Drawer open onClose={onClose} kicker="插件详情" aria-label={`插件「${plugin.name}」`} footer={actions}>
      <div className="form">
        <div className="plg-profile">
          <PluginLogo name={plugin.name} size={48} />
          <div className="plg-profile-text">
            <h2>{plugin.name}</h2>
            <div className="plg-muted">{plugin.description}</div>
          </div>
        </div>

        <div className="plg-group">
          <div className="plg-group-title">状态与版本</div>
          <Row label="状态"><Pill label={st.label} color={st.color} /></Row>
          <Row label="插件 id"><code className="plg-code">{plugin.id}</code></Row>
          <Row label="版本">
            {plugin.version}
            {plugin.installed && plugin.installed_version && plugin.installed_version !== plugin.version && `（已装 ${plugin.installed_version}）`}
            {plugin.upgradable && <span className="plg-risk plg-risk-info">可升级</span>}
          </Row>
          {plugin.installed && plugin.installed_at && <Row label="安装时间">{when(plugin.installed_at)}</Row>}
          {plugin.installed && plugin.enabled && !plugin.running && (
            <Row label="没在运行">有 {plugin.pending_migrations} 条迁移还没应用，启动时没有起它</Row>
          )}
          {plugin.jobs > 0 && <Row label="后台任务">{plugin.jobs} 个</Row>}
        </div>

        <div className="plg-group">
          <div className="plg-group-title">依赖</div>
          {deps.length === 0 && optional.length === 0 && plugin.dependents.length === 0 && <div className="plg-muted">不依赖别的插件，也没有插件依赖它</div>}
          {deps.map(([id, range]) => <Row key={id} label="依赖">「{nameOf(id, list)}」{range} · {depState(id)}</Row>)}
          {optional.map(([id, range]) => <Row key={id} label="可选依赖">「{nameOf(id, list)}」{range} · {depState(id)}</Row>)}
          {plugin.dependents.length > 0 && (
            <Row label="被依赖">{plugin.dependents.map((d) => `「${nameOf(d, list)}」`).join('')}，停用、卸载前要先处理它们</Row>
          )}
        </div>

        <div className="plg-group">
          <div className="plg-group-title">权限</div>
          {plugin.permissions.length === 0 ? <div className="plg-muted">不需要额外权限</div> : plugin.permissions.map((p) => {
            const info = permissionInfo(p)
            return (
              <Row key={p} label={RISK_LABEL[info.risk]}>
                {info.text} <code className="plg-code">{p}</code>
                {plugin.permissions_confirmed.includes(p) && <span className="plg-muted">{separate.has(p) ? '已单独授予' : '已确认'}</span>}
                {plugin.installed && !plugin.permissions_confirmed.includes(p) && (
                  separate.has(p)
                    ? <span className="plg-muted">安装、升级时不授予，在插件自己的设置里单独申请</span>
                    : <span className="plg-risk">还没确认，升级时确认</span>
                )}
              </Row>
            )
          })}
          {plugin.permissions_at && <div className="plg-muted">{plugin.installed ? '确认于' : '上次确认于'} {when(plugin.permissions_at)}</div>}
        </div>

        <div className="plg-group">
          <div className="plg-group-title">提供的扩展点</div>
          {groups.length === 0 ? <div className="plg-muted">没有声明扩展点</div> : groups.map((g) => (
            <Row key={g.key} label={g.label}>
              {g.items.map((x) => <code key={x} className="plg-code">{x}</code>)}
            </Row>
          ))}
        </div>
      </div>
    </Drawer>
  )
}
