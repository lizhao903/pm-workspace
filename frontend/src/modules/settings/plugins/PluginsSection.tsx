// 设置里的「插件」分节（CORE-09）：已安装、可安装两组卡片，点卡片开详情抽屉。
// 原型里还没有这页，卡片加抽屉照原型 connectors.tsx，生命周期照 docs/plugin-api.md 第 4 节。
// 后端写成功后由这里让前端跟着变：启用调 activatePlugin（启动时没路由的整页重新加载），停用调 deactivatePlugin
import { useEffect, useState, type ReactNode } from 'react'
import { activatePlugin, deactivatePlugin, discoverPlugins, parseManifest } from '../../../core/plugin'
import {
  enabledDependents, errorText, installedDependents, QueryState, useDisablePlugins, useEnablePlugin, useInstallPlugin, usePlugins,
  useUninstallPlugin, useUpgradePlugin, type PluginInfo,
} from '../../../core/data'
import { Button, cls, EmptyState, PageTitle, Pill } from '../../../core/ui'
import { DisableDialog, InstallDialog, UninstallDialog, UpgradeDialog } from './dialogs'
import { nameOf, pluginStatus, quoteNames, STATUS_VIEW } from './labels'
import { PluginDrawer, PluginLogo } from './PluginDrawer'
import './plugins.css'

type Notice = { tone: 'ok' | 'danger'; text: ReactNode }
type Dialog = { kind: 'install' | 'disable' | 'uninstall' | 'upgrade'; id: string }

// 整页重新加载后还要看到的提示，放 sessionStorage；拿不到存储就算了
const NOTICE_KEY = 'pmw-plugin-notice'
function takeSavedNotice(): Notice | null {
  try {
    const t = sessionStorage.getItem(NOTICE_KEY)
    if (!t) return null
    sessionStorage.removeItem(NOTICE_KEY)
    return { tone: 'ok', text: t }
  } catch {
    return null
  }
}
function saveNotice(text: string) {
  try { sessionStorage.setItem(NOTICE_KEY, text) } catch { /* 重新加载后不提示 */ }
}

// 模块加载时读一次（整页重新加载后进到这里）
let bootNotice = takeSavedNotice()

function tablePrefixOf(id: string): string | undefined {
  const src = discoverPlugins().find((s) => s.id === id)
  const r = src?.manifest === undefined ? undefined : parseManifest(src.manifest)
  return r?.ok ? r.manifest.table_prefix : undefined
}

/** 依赖里还没启用的（安装、启用前要先启用它们） */
function missingDeps(p: PluginInfo, list: readonly PluginInfo[]): string[] {
  return Object.keys(p.depends ?? {}).filter((d) => !list.find((x) => x.id === d)?.enabled)
}

export function PluginsSection({ reload = () => window.location.reload() }: {
  /** 启用了启动时没路由的插件后整页重新加载；测试里换掉 */
  reload?: () => void
}) {
  const q = usePlugins()
  const [openId, setOpenId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [notice, setNotice] = useState<Notice | null>(() => bootNotice)
  // 重新加载前存下的提示只给第一次打开用
  useEffect(() => { bootNotice = null }, [])
  const install = useInstallPlugin()
  const enable = useEnablePlugin()
  const disable = useDisablePlugins()
  const uninstall = useUninstallPlugin()
  const upgrade = useUpgradePlugin()
  const busy = install.isPending || enable.isPending || disable.isPending || uninstall.isPending || upgrade.isPending

  const list = q.data ?? []

  const fail = (what: string, e: unknown) => setNotice({ tone: 'danger', text: `${what}失败：${errorText(e)}` })

  // 后端启用成功后加载前端部分
  async function afterEnabled(p: PluginInfo, prefix = '') {
    if (!p.running) {
      setNotice({ tone: 'danger', text: `${prefix}已启用「${p.name}」，但有 ${p.pending_migrations} 条迁移还没应用，没在运行` })
      return
    }
    const r = await activatePlugin(p.id)
    if (!r.ok) {
      setNotice({ tone: 'danger', text: `${prefix}后端已启用「${p.name}」，前端没能加载：${r.reasons.join('；')}` })
      return
    }
    const text = `${prefix}已启用「${p.name}」，菜单里已出现`
    if (r.reload) {
      saveNotice(text)
      reload()
      return
    }
    setNotice({ tone: 'ok', text })
  }

  function onInstall(p: PluginInfo, permissions: string[]) {
    install.mutate({ id: p.id, permissions }, {
      onSuccess: (r) => {
        setDialog(null)
        const backup = r.backup ? `安装前已备份数据库：${r.backup}。` : ''
        if (r.enableError) setNotice({ tone: 'danger', text: `${backup}已安装「${p.name}」，启用失败：${errorText(r.enableError)}` })
        else void afterEnabled(r.plugin, backup)
      },
      onError: (e) => { setDialog(null); fail(`安装「${p.name}」`, e) },
    })
  }

  function onEnable(p: PluginInfo) {
    enable.mutate(p.id, {
      onSuccess: (r) => { void afterEnabled(r) },
      onError: (e) => fail(`启用「${p.name}」`, e),
    })
  }

  function onDisable(p: PluginInfo, deps: PluginInfo[]) {
    const ids = [...deps.map((d) => d.id), p.id]
    disable.mutate(ids, {
      onSuccess: () => {
        setDialog(null)
        for (const id of ids) deactivatePlugin(id)
        const also = deps.length ? `，连同${quoteNames(deps.map((d) => d.name))}` : ''
        setNotice({ tone: 'ok', text: `已停用「${p.name}」${also}，菜单里已去掉，数据都保留` })
      },
      onError: (e) => { setDialog(null); fail(`停用「${p.name}」`, e) },
    })
  }

  // 升级后：原来没在跑（迁移没跑、启动时没起）现在跑起来了，按启用加载前端；否则只提示
  function onUpgrade(p: PluginInfo, permissions: string[]) {
    upgrade.mutate({ id: p.id, permissions }, {
      onSuccess: (r) => {
        setDialog(null)
        const backup = r.backup ? `升级前已备份数据库：${r.backup}。` : ''
        const text = `${backup}已把「${p.name}」从 ${r.from} 升级到 ${r.plugin.installed_version}`
        if (r.plugin.running && !p.running) void afterEnabled(r.plugin, `${text}，`)
        else setNotice({ tone: 'ok', text: permissions.length ? `${text}，新增的权限已确认` : text })
      },
      onError: (e) => { setDialog(null); fail(`升级「${p.name}」`, e) },
    })
  }

  function onUninstall(p: PluginInfo, deleteData: boolean) {
    uninstall.mutate({ id: p.id, deleteData }, {
      onSuccess: (r) => {
        setDialog(null)
        if (!r.data_deleted) {
          setNotice({ tone: 'ok', text: `已卸载「${p.name}」，数据保留，重新安装后接着用` })
          return
        }
        const tables = r.dropped_tables.length ? `删掉 ${r.dropped_tables.length} 张表（${r.dropped_tables.join('、')}）` : '没有要删的表'
        setNotice({
          tone: 'ok',
          text: (
            <>
              已卸载「{p.name}」并删除数据：{tables}。删除前已自动备份，快照在
              <code className="plg-code plg-path" data-backup>{r.backup ?? '（后端没有返回路径）'}</code>
            </>
          ),
        })
      },
      onError: (e) => { setDialog(null); fail(`卸载「${p.name}」`, e) },
    })
  }

  // 一个插件当下能做的操作：卡片底部和抽屉底栏共用
  function actionsFor(p: PluginInfo, where: 'card' | 'drawer'): ReactNode {
    const size = where === 'card' ? 'sm' : undefined
    const st = pluginStatus(p)
    const missing = missingDeps(p, list)
    const needDeps = missing.length > 0 && <span className="plg-hint">要先启用{quoteNames(missing.map((d) => nameOf(d, list)))}</span>
    if (st === 'available') {
      return (
        <>
          {needDeps}
          <div className="spacer" />
          <Button size={size} variant="primary" disabled={busy || missing.length > 0} onClick={() => setDialog({ kind: 'install', id: p.id })}>安装</Button>
        </>
      )
    }
    // 换了二进制、版本变了：已安装的都给升级入口
    const up = p.upgradable && (
      <Button size={size} variant="primary" disabled={busy} onClick={() => setDialog({ kind: 'upgrade', id: p.id })}>升级</Button>
    )
    if (st === 'disabled') {
      const blockers = installedDependents(p.id, list)
      return (
        <>
          {where === 'drawer' && (
            <Button variant="danger-ghost" disabled={busy || blockers.length > 0} onClick={() => setDialog({ kind: 'uninstall', id: p.id })}>卸载</Button>
          )}
          {where === 'drawer' && blockers.length > 0 && <span className="plg-hint">先卸载{quoteNames(blockers.map((b) => b.name))}</span>}
          {needDeps}
          <div className="spacer" />
          {up}
          <Button size={size} variant="primary" disabled={busy || missing.length > 0} onClick={() => onEnable(p)}>启用</Button>
        </>
      )
    }
    const deps = enabledDependents(p.id, list)
    return (
      <>
        {deps.length > 0 && <span className="plg-hint">被{quoteNames(deps.map((d) => d.name))}依赖</span>}
        <div className="spacer" />
        {up}
        <Button size={size} variant="outline" disabled={busy} onClick={() => setDialog({ kind: 'disable', id: p.id })}>停用</Button>
      </>
    )
  }

  const card = (p: PluginInfo) => {
    const st = STATUS_VIEW[pluginStatus(p)]
    return (
      <div key={p.id} className={cls('plg-card', pluginStatus(p) === 'stalled' && 'plg-card-bad')} data-plugin={p.id}>
        <div role="button" tabIndex={0} className="plg-card-top" aria-label={`查看「${p.name}」详情`}
          onClick={() => setOpenId(p.id)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setOpenId(p.id) }}>
          <PluginLogo name={p.name} />
          <div className="plg-card-text">
            <div className="plg-name">{p.name}<span className="plg-version">{p.version}</span></div>
            <div className="plg-desc">{p.description}</div>
          </div>
        </div>
        <div className="plg-card-foot">
          {p.installed && <Pill label={st.label} color={st.color} />}
          {actionsFor(p, 'card')}
        </div>
      </div>
    )
  }

  // 抽屉开着的插件不在列表里了就不显示
  const open = openId ? list.find((p) => p.id === openId) : undefined
  const target = dialog ? list.find((p) => p.id === dialog.id) : undefined
  const installed = list.filter((p) => p.installed)
  const available = list.filter((p) => !p.installed)

  return (
    <section className="plg-page">
      <PageTitle parent="设置" count={q.data ? `${installed.length} 个已安装` : undefined}
        desc="第一方插件随程序分发，在这里安装、启停和卸载">插件</PageTitle>
      {notice && (
        <div className={cls('plg-notice', notice.tone === 'danger' && 'plg-notice-danger')} role="status">
          <span className="plg-notice-text">{notice.text}</span>
          <Button size="sm" onClick={() => setNotice(null)}>知道了</Button>
        </div>
      )}
      <QueryState query={q}>
        {() => (
          <>
            <section className="plg-section" aria-label="已安装">
              <div className="plg-section-head"><h2>已安装</h2><span className="plg-muted">{installed.length} 个</span></div>
              {installed.length ? <div className="plg-grid">{installed.map(card)}</div> : <EmptyState compact title="还没有安装插件" />}
            </section>
            <section className="plg-section" aria-label="可安装">
              <div className="plg-section-head"><h2>可安装</h2><span className="plg-muted">{available.length} 个</span></div>
              {available.length ? <div className="plg-grid">{available.map(card)}</div> : <EmptyState compact title="程序里带的插件都装上了" />}
            </section>
          </>
        )}
      </QueryState>

      {open && <PluginDrawer plugin={open} list={list} actions={actionsFor(open, 'drawer')} onClose={() => setOpenId(null)} />}

      {dialog?.kind === 'install' && target && (
        <InstallDialog plugin={target} busy={install.isPending} onConfirm={(perms) => onInstall(target, perms)} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === 'upgrade' && target && (
        <UpgradeDialog plugin={target} busy={upgrade.isPending} onConfirm={(perms) => onUpgrade(target, perms)} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === 'disable' && target && (
        <DisableDialog plugin={target} deps={enabledDependents(target.id, list)} busy={disable.isPending}
          optional={list.filter((x) => x.enabled && target.id in (x.optional_depends ?? {}))}
          onConfirm={() => onDisable(target, enabledDependents(target.id, list))} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === 'uninstall' && target && (
        <UninstallDialog plugin={target} tablePrefix={tablePrefixOf(target.id)} busy={uninstall.isPending}
          onConfirm={(del) => onUninstall(target, del)} onCancel={() => setDialog(null)} />
      )}
    </section>
  )
}
