// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置 > 插件（CORE-09，SPEC-settings-28）：已安装、可安装两组卡片，点卡片开详情抽屉；安装（列权限，高风险逐条勾选）、
// 升级（只列新增的权限）、停用（被依赖时连同依赖它的一起停）、卸载（保留或删除数据，删除要输入插件名）。
// 正式产品 frontend/src/modules/settings/plugins/（以已提交的版本为准；工作树里在做的外部插件 / 插件社区没同步到原型）。
// 原型没有后端：插件清单照第一方插件的 plugin.json（名字、版本、依赖、权限、扩展点），状态在本页模拟，
// 停用、卸载不会真的把菜单里的模块去掉（菜单由工作台决定，见 SPEC-settings-2）。
import { Fragment, useState, type ReactNode } from 'react'
import { PageTitle } from './topbar'
import { cls } from './ui'
import './setx.css'

type Risk = 'normal' | 'high' | 'highest'
export interface PluginInfo {
  id: string; name: string; version: string; description: string
  installed: boolean; enabled: boolean; running: boolean
  /** 已装的版本；和 version 不一样时可升级 */
  installed_version?: string
  installed_at?: string
  pending_migrations: number
  depends: Record<string, string>
  optional_depends: Record<string, string>
  permissions: string[]
  /** 已确认过的权限 */
  permissions_confirmed: string[]
  /** 安装时不授予、要在插件自己的设置里单独申请的（trade:live） */
  permissions_separate?: string[]
  provides: Record<string, string[]>
  table_prefix: string
  jobs: number
}

const PERMISSION_TEXT: Record<string, { text: string; risk: Risk }> = {
  'fs:read:project': { text: '读项目根目录下的文件', risk: 'normal' },
  'fs:write:project': { text: '写项目根目录下的文件', risk: 'normal' },
  'fs:read:attachments': { text: '读数据目录下的附件', risk: 'normal' },
  'fs:write:attachments': { text: '写数据目录下的附件', risk: 'normal' },
  'fs:read:any': { text: '读本机任意路径', risk: 'high' },
  'fs:read:registered': { text: '只读你在插件里逐个登记的本机目录', risk: 'normal' },
  'network:localhost': { text: '访问 127.0.0.1 和本机域名', risk: 'normal' },
  'network:im': { text: '访问 IM 平台的接口', risk: 'normal' },
  'network:media-platforms': { text: '访问视频平台', risk: 'normal' },
  'network:market-data': { text: '访问行情源', risk: 'normal' },
  'network:exchanges': { text: '访问交易所的交易接口', risk: 'high' },
  'network:any': { text: '访问任意外网地址', risk: 'high' },
  'process:spawn': { text: '起子进程（原型、终端）', risk: 'high' },
  'trade:live': { text: '实盘下单', risk: 'highest' },
}
const permissionInfo = (p: string) => PERMISSION_TEXT[p] ?? { text: '内核不认识的权限', risk: 'high' as Risk }
const RISK_LABEL: Record<Risk, string> = { normal: '普通', high: '高风险', highest: '最高风险' }
const PROVIDES_LABEL: Record<string, string> = {
  modules: '功能模块', settings: '设置分节', object_types: '对象类型', connectors: '连接器', skills: '技能', agent_tools: 'Agent 工具',
  sop_nodes: 'SOP 节点', today_cards: '今日卡片', commands: '命令面板命令', search: '搜索', schedule_actions: '定时任务动作',
}
type PluginStatus = 'running' | 'stalled' | 'disabled' | 'available'
const pluginStatus = (p: PluginInfo): PluginStatus => (!p.installed ? 'available' : !p.enabled ? 'disabled' : p.running ? 'running' : 'stalled')
const STATUS_VIEW: Record<PluginStatus, { label: string; color: string }> = {
  running: { label: '已启用', color: 'var(--ok)' },
  stalled: { label: '已启用，没在运行', color: 'var(--warn)' },
  disabled: { label: '已停用', color: 'var(--faint)' },
  available: { label: '未安装', color: 'var(--faint)' },
}
const quoteNames = (xs: readonly string[]) => xs.map((n) => `「${n}」`).join('')
const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString()

const P = (id: string, name: string, version: string, description: string, perms: string[], provides: Record<string, string[]>, more: Partial<PluginInfo> = {}): PluginInfo => ({
  id, name, version, description, installed: true, enabled: true, running: true, installed_version: version, installed_at: daysAgo(20),
  pending_migrations: 0, depends: {}, optional_depends: {}, permissions: perms, permissions_confirmed: perms, provides, table_prefix: `${id}_`, jobs: 0, ...more,
})

/** 第一方插件（照已提交的 internal/plugins/<id>/plugin.json）；视频是可升级（已装 0.8.2）、宽基监控是已停用、语音合成没装的演示状态 */
export const seedPlugins: PluginInfo[] = [
  P('projects', '项目', '0.19.0', '项目目录、沟通渠道绑定、项目资料、原型启停、需求工作区、测试环境、发布', ['process:spawn'], { modules: ['projects'], settings: ['worktrees'], sop_nodes: ['projects_prepare_worktree', 'projects_run_test', 'projects_kb_sync'] }, { jobs: 2 }),
  P('im', 'IM 消息', '0.30.0', '收各 IM 渠道的消息，按 IM 身份认人、按会话归档，筛出与我相关的', ['network:im'], { modules: ['messages'], connectors: ['slack', 'telegram'], sop_nodes: ['im_send_message', 'im_to_task', 'im_notify'] }, { jobs: 1 }),
  P('sop', 'SOP 编排', '0.20.0', '标准工作流的编辑、节点和执行', ['network:any', 'fs:write:project', 'process:spawn'], { modules: ['sop'], settings: ['sop'], today_cards: ['sop_pending'] }, { optional_depends: { im: '>=0.7.0 <1.0.0' }, jobs: 2 }),
  P('terminal', '终端', '0.2.0', '本机真终端：pty 加 WebSocket，分屏，能跑项目原型命令', ['process:spawn'], { modules: ['terminal'], settings: ['terminal'] }, { depends: { projects: '>=0.5.0 <1.0.0' } }),
  P('browser', '内置浏览器', '0.2.0', '工作台里的多标签浏览器：标签页存后端、能嵌入的地址白名单，Google 账号用 Google Drive 连接器', [], { modules: ['browser'] }),
  P('domains', '内网域名', '0.2.0', '给本机跑的服务配好记的域名：检测 hosts、pf 转发和本地证书，生成配置和要自己执行的命令', ['fs:read:any', 'process:spawn', 'network:localhost'], { settings: ['domains'] }, { optional_depends: { projects: '>=0.6.0 <1.0.0' } }),
  P('video', '视频创作', '0.9.0', '视频制作流程、检查点、系列和多平台发布记录', ['fs:read:project', 'fs:write:project', 'network:media-platforms', 'process:spawn', 'fs:read:registered'],
    { modules: ['videos', 'video_clips', 'video_publish'], connectors: ['bilibili', 'youtube', 'douyin'], sop_nodes: ['video_wait_checkpoint', 'video_run_stage', 'video_publish'], today_cards: ['video_waiting', 'video_scheduled'], schedule_actions: ['video_publish'] },
    { depends: { projects: '>=0.5.0 <1.0.0' }, installed_version: '0.8.2', pending_migrations: 1, permissions_confirmed: ['fs:read:project', 'fs:write:project', 'network:media-platforms', 'process:spawn'] }),
  // 「可安装」的演示：语音合成没装（视频配音照常能手动配）
  P('tts', '语音合成', '0.1.0', '本机语音合成：自动检测 IndexTTS 和音色，视频配音不用再配置；连接器里可换音色和语速', ['process:spawn'], { connectors: ['voice'] },
    { installed: false, enabled: false, running: false, installed_version: undefined, installed_at: undefined, permissions_confirmed: [] }),
  P('recording', '录音转写', '0.4.0', '浏览器内录音，用本机 whisper.cpp 转写成带时间戳的文字；模型可一键下载或手动放置，音频与文本不出本机', ['fs:read:attachments', 'fs:write:attachments', 'process:spawn'], { modules: ['recording'], settings: ['recording'], sop_nodes: ['recording_minutes', 'recording_extract'], commands: ['recording.start'] }, { jobs: 1 }),
  P('trade', '交易套件', '0.7.0', '行情、盯盘、策略与回测、交易执行；默认只做行情、回测和模拟盘，实盘下单要过评审、单独申请', ['network:market-data', 'network:exchanges', 'trade:live'],
    { modules: ['markets', 'monitor', 'strategy', 'trading'], connectors: ['binance_market', 'okx_market'] }, { permissions_separate: ['trade:live'], permissions_confirmed: ['network:market-data', 'network:exchanges'], jobs: 3 }),
  P('etf', '宽基监控', '0.2.0', '监控 A 股宽基 ETF 的每日份额变动与交易大盘情况，算派生指标、按规则判定异动并发通知', ['network:market-data'], { modules: ['etf'] }, { enabled: false, running: false }),
  P('jobs', '后台任务', '0.1.0', '查看插件后台任务的运行状态、最近一小时执行统计及错误，每 10 秒刷新；统计仅存内存', [], { settings: ['jobs'] }),
]

const enabledDependents = (id: string, list: PluginInfo[]) => list.filter((x) => x.enabled && id in x.depends)
const installedDependents = (id: string, list: PluginInfo[]) => list.filter((x) => x.installed && id in x.depends)
const missingDeps = (p: PluginInfo, list: PluginInfo[]) => Object.keys(p.depends).filter((d) => !list.find((x) => x.id === d)?.enabled)
const nameOf = (id: string, list: PluginInfo[]) => list.find((p) => p.id === id)?.name ?? id
const when = (s?: string) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '')

type Dialog = { kind: 'install' | 'disable' | 'uninstall' | 'upgrade'; id: string }
type Notice = { tone: 'ok' | 'danger'; text: string }

export function PluginsPage() {
  const [list, setList] = useState(seedPlugins)
  const [openId, setOpenId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const patch = (ids: string[], f: (p: PluginInfo) => Partial<PluginInfo>) => setList((xs) => xs.map((p) => (ids.includes(p.id) ? { ...p, ...f(p) } : p)))
  const backup = () => `~/pm-workspace/data/backups/pm-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.db`

  const onInstall = (p: PluginInfo) => {
    patch([p.id], () => ({ installed: true, enabled: true, running: true, installed_version: p.version, installed_at: new Date().toISOString(), pending_migrations: 0, permissions_confirmed: p.permissions.filter((x) => !(p.permissions_separate ?? []).includes(x)) }))
    setDialog(null)
    setNotice({ tone: 'ok', text: `${p.pending_migrations ? `安装前已备份数据库：${backup()}。` : ''}已启用「${p.name}」，菜单里已出现` })
  }
  const onEnable = (p: PluginInfo) => { patch([p.id], () => ({ enabled: true, running: true })); setNotice({ tone: 'ok', text: `已启用「${p.name}」，菜单里已出现` }) }
  const onDisable = (p: PluginInfo) => {
    const deps = enabledDependents(p.id, list)
    patch([...deps.map((d) => d.id), p.id], () => ({ enabled: false, running: false }))
    setDialog(null)
    setNotice({ tone: 'ok', text: `已停用「${p.name}」${deps.length ? `，连同${quoteNames(deps.map((d) => d.name))}` : ''}，菜单里已去掉，数据都保留` })
  }
  const onUpgrade = (p: PluginInfo) => {
    const from = p.installed_version
    patch([p.id], () => ({ installed_version: p.version, pending_migrations: 0, permissions_confirmed: p.permissions.filter((x) => !(p.permissions_separate ?? []).includes(x)), running: p.enabled }))
    setDialog(null)
    setNotice({ tone: 'ok', text: `${p.pending_migrations ? `升级前已备份数据库：${backup()}。` : ''}已把「${p.name}」从 ${from} 升级到 ${p.version}` })
  }
  const onUninstall = (p: PluginInfo, del: boolean) => {
    patch([p.id], () => ({ installed: false, enabled: false, running: false, installed_version: undefined, installed_at: undefined }))
    setDialog(null)
    setOpenId(null)
    setNotice({ tone: 'ok', text: del ? `已卸载「${p.name}」并删除数据：删掉表名以 ${p.table_prefix} 开头的表。删除前已自动备份，快照在 ${backup()}` : `已卸载「${p.name}」，数据保留，重新安装后接着用` })
  }

  function actionsFor(p: PluginInfo, where: 'card' | 'drawer'): ReactNode {
    const st = pluginStatus(p)
    const missing = missingDeps(p, list)
    const needDeps = missing.length > 0 && <span className="plg-hint">要先启用{quoteNames(missing.map((d) => nameOf(d, list)))}</span>
    if (st === 'available') return <>{needDeps}<span className="spacer" /><button className={'act act-primary'} disabled={missing.length > 0} onClick={() => setDialog({ kind: 'install', id: p.id })}>安装</button></>
    const up = p.installed_version !== p.version && <button className={'act act-primary'} onClick={() => setDialog({ kind: 'upgrade', id: p.id })}>升级</button>
    if (st === 'disabled') {
      const blockers = installedDependents(p.id, list)
      return (
        <>
          {where === 'drawer' && <button className="act act-quiet btn-danger-ghost" disabled={blockers.length > 0} onClick={() => setDialog({ kind: 'uninstall', id: p.id })}>卸载</button>}
          {where === 'drawer' && blockers.length > 0 && <span className="plg-hint">先卸载{quoteNames(blockers.map((b) => b.name))}</span>}
          {needDeps}<span className="spacer" />{up}
          <button className={'act act-primary'} disabled={missing.length > 0} onClick={() => onEnable(p)}>启用</button>
        </>
      )
    }
    const deps = enabledDependents(p.id, list)
    return <>{deps.length > 0 && <span className="plg-hint">被{quoteNames(deps.map((d) => d.name))}依赖</span>}<span className="spacer" />{up}<button className="act" onClick={() => setDialog({ kind: 'disable', id: p.id })}>停用</button></>
  }

  const installed = list.filter((p) => p.installed)
  const available = list.filter((p) => !p.installed)
  const open = openId ? list.find((p) => p.id === openId) : undefined
  const target = dialog ? list.find((p) => p.id === dialog.id) : undefined
  const card = (p: PluginInfo) => {
    const st = STATUS_VIEW[pluginStatus(p)]
    return (
      <div key={p.id} className={cls('plg-card', pluginStatus(p) === 'stalled' && 'plg-card-bad')} data-plugin={p.id}>
        <button type="button" className="plg-card-top" aria-label={`查看「${p.name}」详情`} onClick={() => setOpenId(p.id)}>
          <span className="plg-logo" aria-hidden="true">{p.name.slice(0, 1)}</span>
          <span style={{ minWidth: 0 }}>
            <span className="plg-name">{p.name}<span className="plg-version">{p.version}</span></span>
            <span className="plg-desc">{p.description}</span>
          </span>
        </button>
        <div className="plg-foot">{p.installed && <Pill label={st.label} color={st.color} />}{actionsFor(p, 'card')}</div>
      </div>
    )
  }

  return (
    <div className="page setx-page" style={{ maxWidth: 1040 }}>
      <PageTitle parent="设置" count={`${installed.length} 个已安装`} desc="第一方插件随程序分发，在这里安装、启停和卸载">插件</PageTitle>
      {notice && <div className={cls('setx-notice', notice.tone === 'danger' && 'danger')} role="status"><span>{notice.text}</span><button className="act" onClick={() => setNotice(null)}>知道了</button></div>}
      <section className="setx-sec" aria-label="已安装">
        <div className="plg-section-head"><h2>已安装</h2><span className="muted setx-sm">{installed.length} 个</span></div>
        {installed.length ? <div className="plg-grid">{installed.map(card)}</div> : <div className="empty"><div className="empty-title">还没有安装插件</div></div>}
      </section>
      <section className="setx-sec" aria-label="可安装">
        <div className="plg-section-head"><h2>可安装</h2><span className="muted setx-sm">{available.length} 个</span></div>
        {available.length ? <div className="plg-grid">{available.map(card)}</div> : <div className="empty"><div className="empty-title">程序里带的插件都装上了</div></div>}
      </section>
      {open && <PluginDrawer plugin={open} list={list} actions={actionsFor(open, 'drawer')} onClose={() => setOpenId(null)} />}
      {dialog?.kind === 'install' && target && <PermDialog plugin={target} mode="install" onConfirm={() => onInstall(target)} onCancel={() => setDialog(null)} />}
      {dialog?.kind === 'upgrade' && target && <PermDialog plugin={target} mode="upgrade" onConfirm={() => onUpgrade(target)} onCancel={() => setDialog(null)} />}
      {dialog?.kind === 'disable' && target && (() => {
        const deps = enabledDependents(target.id, list)
        const optional = list.filter((x) => x.enabled && target.id in x.optional_depends)
        return (
          <Confirm title={`停用「${target.name}」`} label={deps.length ? '一起停用' : '停用'} onConfirm={() => onDisable(target)} onCancel={() => setDialog(null)}>
            {deps.length > 0
              ? <p>这些已启用的插件依赖它，不能单独停用：<strong>{quoteNames(deps.map((d) => d.name))}</strong>。停用「{target.name}」会同时停用它们。数据都会保留，重新启用即可恢复。</p>
              : <p>菜单里「{target.name}」提供的功能会去掉，后台任务暂停。数据都会保留，重新启用即可恢复。</p>}
            {optional.length > 0 && <><div className="section-label">可选依赖它的插件</div><ul>{optional.map((o) => <li key={o.id}>「{o.name}」里和「{target.name}」有关的功能会暂时不可用</li>)}</ul></>}
          </Confirm>
        )
      })()}
      {dialog?.kind === 'uninstall' && target && <UninstallDialog plugin={target} onConfirm={(del) => onUninstall(target, del)} onCancel={() => setDialog(null)} />}
    </div>
  )
}

function Confirm({ title, label, danger, disabled, onConfirm, onCancel, cancelLabel = '取消', children }: {
  title: string; label: string; danger?: boolean; disabled?: boolean; onConfirm: () => void; onCancel: () => void; cancelLabel?: string; children: ReactNode
}) {
  return (
    <div className="qs-mask" style={{ zIndex: 110 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="qs" role="alertdialog" aria-label={title}>
        <div className="qs-head"><b>{title}</b></div>
        {children}
        <div className="act-row"><span className="spacer" />
          <button className="act act-quiet" onClick={onCancel}>{cancelLabel}</button>
          <button className={cls('act', danger ? 'btn-danger' : 'act-primary')} disabled={disabled} onClick={onConfirm}>{label}</button>
        </div>
      </div>
    </div>
  )
}

/** 安装列全部权限、升级只列新增的；高风险的逐条勾选才能继续；单独申请的（trade:live）不在这里授予 */
function PermDialog({ plugin, mode, onConfirm, onCancel }: { plugin: PluginInfo; mode: 'install' | 'upgrade'; onConfirm: () => void; onCancel: () => void }) {
  const [granted, setGranted] = useState<Set<string>>(new Set())
  const separate = plugin.permissions_separate ?? []
  const perms = mode === 'install' ? plugin.permissions.filter((p) => !separate.includes(p)) : plugin.permissions.filter((p) => !plugin.permissions_confirmed.includes(p) && !separate.includes(p))
  const ready = perms.filter((p) => permissionInfo(p).risk !== 'normal').every((p) => granted.has(p))
  const toggle = (p: string, on: boolean) => setGranted((s) => { const n = new Set(s); if (on) n.add(p); else n.delete(p); return n })
  return (
    <Confirm title={`${mode === 'install' ? '安装' : '升级'}「${plugin.name}」`} label={mode === 'install' ? '确认并安装' : perms.length ? '确认并升级' : '升级'} disabled={!ready} onConfirm={onConfirm} onCancel={onCancel}>
      <p>{mode === 'install' ? `版本 ${plugin.version}。安装后直接启用` : `从 ${plugin.installed_version} 升级到 ${plugin.version}`}{plugin.pending_migrations > 0 ? `，${mode === 'install' ? '安装' : '升级'}前会先备份数据库，再跑 ${plugin.pending_migrations} 条迁移` : ''}。</p>
      {perms.length === 0 ? <p className="muted">{mode === 'install' ? '这个插件不需要额外权限。' : '新版本没有新增权限。'}</p> : (
        <div className="setx-sec" aria-label={mode === 'install' ? '要授予的权限' : '新增的权限'}>
          <div className="section-label">{mode === 'install' ? '要授予的权限' : '新增的权限'}</div>
          {mode === 'upgrade' && <p className="muted setx-sm">确认前，「{plugin.name}」里要用这些权限的功能会被拦下，其余功能照常。</p>}
          {perms.map((p) => {
            const info = permissionInfo(p)
            return (
              <div key={p} className="plg-perm" data-risk={info.risk}>
                <div className="plg-perm-main"><span>{info.text}</span><code>{p}</code>{info.risk !== 'normal' && <span className="plg-risk">{RISK_LABEL[info.risk]}</span>}</div>
                {info.risk !== 'normal' && <label className="setx-demo"><input type="checkbox" checked={granted.has(p)} onChange={(e) => toggle(p, e.target.checked)} /> 我了解风险，授予这项权限</label>}
              </div>
            )
          })}
          {!ready && <div className="muted setx-sm">高风险权限要逐条勾选后才能{mode === 'install' ? '安装' : '升级'}。</div>}
        </div>
      )}
      {separate.length > 0 && mode === 'install' && <p className="muted setx-sm">{separate.map((p) => `${permissionInfo(p).text}（${p}）`).join('、')}安装时不授予：要在插件自己的设置里过评审后单独申请。</p>}
    </Confirm>
  )
}

function UninstallDialog({ plugin, onConfirm, onCancel }: { plugin: PluginInfo; onConfirm: (del: boolean) => void; onCancel: () => void }) {
  const [del, setDel] = useState(false)
  const [step, setStep] = useState<'choose' | 'confirm'>('choose')
  const [typed, setTyped] = useState('')
  if (step === 'confirm') {
    const ok = typed.trim() === plugin.name || typed.trim() === plugin.id
    return (
      <Confirm title={`删除「${plugin.name}」的数据`} label="删除数据并卸载" danger disabled={!ok} cancelLabel="返回" onConfirm={() => onConfirm(true)} onCancel={() => { setStep('choose'); setTyped('') }}>
        <div className="section-label">会删除</div>
        <ul><li>表名以 {plugin.table_prefix} 开头的表（索引随表删）</li><li>本插件的迁移记录</li></ul>
        <p>删除前会自动备份一份数据库快照，完成后显示快照位置；要找回数据只能从快照恢复。</p>
        <label className="field"><span className="field-label">输入插件名「{plugin.name}」确认</span><input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={plugin.name} autoComplete="off" /></label>
      </Confirm>
    )
  }
  return (
    <Confirm title={`卸载「${plugin.name}」`} label={del ? '下一步' : '卸载'} danger={del} onConfirm={() => (del ? setStep('confirm') : onConfirm(false))} onCancel={onCancel}>
      <div role="radiogroup" aria-label="卸载时的数据" className="setx-sec">
        <label className="setx-demo"><input type="radio" name="plg-uninstall" checked={!del} onChange={() => setDel(false)} /> <strong>保留数据</strong><span className="muted setx-sm">表和迁移记录都在，重新安装后接着用</span></label>
        <label className="setx-demo"><input type="radio" name="plg-uninstall" checked={del} onChange={() => setDel(true)} /> <strong>删除数据</strong><span className="muted setx-sm">删掉本插件的表和迁移记录，删除前自动备份</span></label>
      </div>
    </Confirm>
  )
}

function PluginDrawer({ plugin, list, actions, onClose }: { plugin: PluginInfo; list: PluginInfo[]; actions: ReactNode; onClose: () => void }) {
  const st = STATUS_VIEW[pluginStatus(plugin)]
  const deps = Object.entries(plugin.depends)
  const optional = Object.entries(plugin.optional_depends)
  const dependents = list.filter((x) => plugin.id in x.depends)
  const separate = new Set(plugin.permissions_separate ?? [])
  const depState = (id: string) => { const p = list.find((x) => x.id === id); return p ? STATUS_VIEW[pluginStatus(p)].label : '二进制里没有' }
  const groups = Object.keys(PROVIDES_LABEL).map((k) => ({ k, label: PROVIDES_LABEL[k], items: plugin.provides[k] ?? [] })).filter((g) => g.items.length)
  return (
    <div className="setx-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <aside className="drawer setx-drawer" aria-label={`插件「${plugin.name}」`}>
        <div className="drawer-head">
          <span className="drawer-kicker">插件详情</span>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} title="关闭 (Esc)"><svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button>
        </div>
        <div className="drawer-body">
          <div className="profile">
            <span className="plg-logo" style={{ width: 48, height: 48, fontSize: 20 }} aria-hidden="true">{plugin.name.slice(0, 1)}</span>
            <div className="profile-text"><h2>{plugin.name}</h2><div className="muted">{plugin.description}</div></div>
          </div>
          <section className="setx-sec"><h3>状态与版本</h3>
            <dl className="setx-kv">
              <dt>状态</dt><dd><Pill label={st.label} color={st.color} /></dd>
              <dt>插件 id</dt><dd><code>{plugin.id}</code></dd>
              <dt>版本</dt><dd>{plugin.version}{plugin.installed && plugin.installed_version && plugin.installed_version !== plugin.version && `（已装 ${plugin.installed_version}）`}{plugin.installed && plugin.installed_version !== plugin.version && <span className="plg-risk"> 可升级</span>}</dd>
              {plugin.installed && plugin.installed_at && <><dt>安装时间</dt><dd>{when(plugin.installed_at)}</dd></>}
              {plugin.jobs > 0 && <><dt>后台任务</dt><dd>{plugin.jobs} 个</dd></>}
            </dl>
          </section>
          <section className="setx-sec"><h3>依赖</h3>
            {!deps.length && !optional.length && !dependents.length && <div className="muted setx-sm">不依赖别的插件，也没有插件依赖它</div>}
            <dl className="setx-kv">
              {deps.map(([id, r]) => <Fragment key={id}><dt>依赖</dt><dd>「{nameOf(id, list)}」{r} · {depState(id)}</dd></Fragment>)}
              {optional.map(([id, r]) => <Fragment key={id}><dt>可选依赖</dt><dd>「{nameOf(id, list)}」{r} · {depState(id)}</dd></Fragment>)}
              {dependents.length > 0 && <><dt>被依赖</dt><dd>{quoteNames(dependents.map((d) => d.name))}，停用、卸载前要先处理它们</dd></>}
            </dl>
          </section>
          <section className="setx-sec"><h3>权限</h3>
            {!plugin.permissions.length ? <div className="muted setx-sm">不需要额外权限</div> : (
              <dl className="setx-kv">
                {plugin.permissions.map((p) => { const info = permissionInfo(p); return <Fragment key={p}><dt>{RISK_LABEL[info.risk]}</dt><dd>{info.text} <code>{p}</code>{' '}
                  {plugin.permissions_confirmed.includes(p) ? <span className="muted">已确认</span> : plugin.installed && (separate.has(p) ? <span className="muted">安装、升级时不授予，在插件自己的设置里单独申请</span> : <span className="plg-risk">还没确认，升级时确认</span>)}</dd></Fragment> })}
              </dl>
            )}
          </section>
          <section className="setx-sec"><h3>提供的扩展点</h3>
            {!groups.length ? <div className="muted setx-sm">没有声明扩展点</div> : <dl className="setx-kv">{groups.map((g) => <Fragment key={g.k}><dt>{g.label}</dt><dd className="plg-chips">{g.items.map((x) => <code key={x} className="plg-chip">{x}</code>)}</dd></Fragment>)}</dl>}
          </section>
        </div>
        <div className="drawer-foot">{actions}</div>
      </aside>
    </div>
  )
}
