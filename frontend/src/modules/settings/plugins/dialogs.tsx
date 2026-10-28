// 插件管理的三个确认弹窗：安装（列权限、高风险单独勾选）、停用（被依赖时列出要一起停的）、卸载（保留或删除数据，删除要二次确认）
import { useState } from 'react'
import type { PluginInfo } from '../../../core/data'
import { Checkbox, ConfirmDialog, Field, Input } from '../../../core/ui'
import { permissionInfo, quoteNames, RISK_LABEL } from './labels'

export function InstallDialog({ plugin, busy, onConfirm, onCancel }: {
  plugin: PluginInfo
  busy?: boolean
  onConfirm: (permissions: string[]) => void
  onCancel: () => void
}) {
  const [granted, setGranted] = useState<ReadonlySet<string>>(new Set())
  const perms = plugin.permissions ?? []
  const risky = perms.filter((p) => permissionInfo(p).risk !== 'normal')
  const ready = risky.every((p) => granted.has(p))
  const before = new Set(plugin.permissions_confirmed ?? [])
  const toggle = (p: string, on: boolean) => {
    const next = new Set(granted)
    if (on) next.add(p)
    else next.delete(p)
    setGranted(next)
  }
  return (
    <ConfirmDialog open title={`安装「${plugin.name}」`} confirmLabel={busy ? '正在安装' : '确认并安装'} busy={busy || !ready}
      onConfirm={() => onConfirm(perms)} onCancel={onCancel}>
      <p className="plg-dialog-p">版本 {plugin.version}。安装后直接启用{plugin.pending_migrations > 0 ? `，安装前会先备份数据库，再跑 ${plugin.pending_migrations} 条迁移` : ''}。</p>
      {perms.length === 0 ? (
        <p className="plg-dialog-p plg-muted">这个插件不需要额外权限。</p>
      ) : (
        <div className="plg-perms" aria-label="要授予的权限">
          <div className="plg-perms-title">要授予的权限</div>
          {perms.map((p) => {
            const info = permissionInfo(p)
            return (
              <div key={p} className="plg-perm" data-risk={info.risk}>
                <div className="plg-perm-main">
                  <span>{info.text}</span>
                  <code className="plg-code">{p}</code>
                  {info.risk !== 'normal' && <span className="plg-risk">{RISK_LABEL[info.risk]}</span>}
                  {before.has(p) && <span className="plg-muted">上次确认过</span>}
                </div>
                {info.risk !== 'normal' && (
                  <Checkbox checked={granted.has(p)} onCheckedChange={(v) => toggle(p, v)}>我了解风险，授予这项权限</Checkbox>
                )}
              </div>
            )
          })}
          {!ready && <div className="plg-muted">高风险权限要逐条勾选后才能安装。</div>}
        </div>
      )}
    </ConfirmDialog>
  )
}

/** deps 是要一起停用的已启用插件（由远到近）；optional 是可选依赖它、会暂时少功能的 */
export function DisableDialog({ plugin, deps, optional, busy, onConfirm, onCancel }: {
  plugin: PluginInfo
  deps: PluginInfo[]
  optional: PluginInfo[]
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <ConfirmDialog open title={`停用「${plugin.name}」`} confirmLabel={deps.length ? '一起停用' : '停用'} busy={busy}
      impactsTitle="可选依赖它的插件" impacts={optional.map((o) => `「${o.name}」里和「${plugin.name}」有关的功能会暂时不可用`)}
      onConfirm={onConfirm} onCancel={onCancel}>
      {deps.length > 0 ? (
        <p className="plg-dialog-p">
          这些已启用的插件依赖它，不能单独停用：<strong>{quoteNames(deps.map((d) => d.name))}</strong>。
          停用「{plugin.name}」会同时停用它们。数据都会保留，重新启用即可恢复。
        </p>
      ) : (
        <p className="plg-dialog-p">菜单里「{plugin.name}」提供的功能会去掉，后台任务暂停。数据都会保留，重新启用即可恢复。</p>
      )}
    </ConfirmDialog>
  )
}

export function UninstallDialog({ plugin, tablePrefix, busy, onConfirm, onCancel }: {
  plugin: PluginInfo
  /** 清单里的表前缀，删数据时删掉以它开头的表 */
  tablePrefix?: string
  busy?: boolean
  onConfirm: (deleteData: boolean) => void
  onCancel: () => void
}) {
  const [del, setDel] = useState(false)
  const [step, setStep] = useState<'choose' | 'confirm'>('choose')
  const [typed, setTyped] = useState('')
  const matched = typed.trim() === plugin.name || typed.trim() === plugin.id

  if (step === 'confirm') {
    return (
      <ConfirmDialog open danger title={`删除「${plugin.name}」的数据`} cancelLabel="返回" busy={busy || !matched}
        confirmLabel={busy ? '正在删除' : '删除数据并卸载'}
        impactsTitle="会删除"
        impacts={[
          tablePrefix ? `表名以 ${tablePrefix} 开头的表（索引随表删）` : '本插件的表（按清单里的表前缀）',
          '本插件的迁移记录',
        ]}
        onConfirm={() => onConfirm(true)} onCancel={() => { setStep('choose'); setTyped('') }}>
        <p className="plg-dialog-p">删除前会自动备份一份数据库快照，完成后显示快照位置；要找回数据只能从快照恢复。</p>
        <Field label={`输入插件名「${plugin.name}」确认`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={plugin.name} autoComplete="off" />
        </Field>
      </ConfirmDialog>
    )
  }
  return (
    <ConfirmDialog open title={`卸载「${plugin.name}」`} danger={del} busy={busy}
      confirmLabel={del ? '下一步' : busy ? '正在卸载' : '卸载'}
      onConfirm={() => { if (del) setStep('confirm'); else onConfirm(false) }} onCancel={onCancel}>
      <div className="plg-choices" role="radiogroup" aria-label="卸载时的数据">
        <label className="plg-choice">
          <input type="radio" name="plg-uninstall" checked={!del} onChange={() => setDel(false)} />
          <span><strong>保留数据</strong><span className="plg-muted">表和迁移记录都在，重新安装后接着用</span></span>
        </label>
        <label className="plg-choice">
          <input type="radio" name="plg-uninstall" checked={del} onChange={() => setDel(true)} />
          <span><strong>删除数据</strong><span className="plg-muted">删掉本插件的表和迁移记录，删除前自动备份</span></span>
        </label>
      </div>
    </ConfirmDialog>
  )
}
