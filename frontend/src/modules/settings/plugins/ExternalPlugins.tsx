// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置 → 插件页里的「外部插件（P1-a）」：安装（GitHub / 本地目录 / tar.gz）、预览权限和风险、启用/停用/卸载。
// 数据走 core/data/externalPlugins；装好、启用后调 core/plugin 的 activatePlugin 把前端入口加载进来。
// 详见 docs/plugin-spec-v2.md 和 brief §6。
import { useState, type ReactNode } from 'react'
import {
  activatePlugin, deactivatePlugin, discoverPlugins, externalSources, type ExternalManifestV2, type ExternalMarketEntry,
  type ExternalMarketVersion, type ExternalPermissionInfo, type ExternalPreview, type ExternalRow, type ExternalSource,
} from '../../../core/plugin'
import {
  externalPluginsApi, errorText, useExternalAction, useExternalPlugins, useFetchExternalMarket, useGrantExternalPermission, useInstallExternalPlugin,
  useReloadExternalDev, useResolveExternalPlugin, useRevokeExternalPermission, useRollbackExternalPlugin, useUpgradeExternalPlugin,
} from '../../../core/data'
import { Button, Checkbox, cls, ConfirmDialog, EmptyState, Field, Input, Pill, Select } from '../../../core/ui'
import './externalPlugins.css'

type SourceKind = 'github' | 'dir' | 'archive' | 'dev'
type Notice = { tone: 'ok' | 'danger'; text: ReactNode }

const SOURCE_OPTIONS = [
  { value: 'github', label: 'GitHub 仓库 / Release / 资产直链' },
  { value: 'dir', label: '本地插件目录' },
  { value: 'archive', label: '本地 tar.gz 安装包' },
  { value: 'dev', label: '本地开发目录（链接，开发者模式）' },
]

const SOURCE_PLACEHOLDER: Record<SourceKind, string> = {
  github: 'https://github.com/owner/pmw-plugin-hello 或 Release 资产直链',
  dir: '~/src/pmw-plugin-hello（含 plugin.json 的目录）',
  archive: '~/Downloads/hello_world-0.1.0-darwin-arm64.tar.gz',
  dev: '~/src/pmw-plugin-hello（--plugin-dev-dir 下的源码目录；先 make build 出 bin/web）',
}

// 整页重新加载后还要看到的提示，放 sessionStorage；和第一方插件页用同一个键
const NOTICE_KEY = 'pmw-plugin-notice'
function saveNotice(text: string) {
  try { sessionStorage.setItem(NOTICE_KEY, text) } catch { /* 重新加载后不提示 */ }
}

const RISK_LABEL: Record<string, string> = { normal: '普通', high: '高风险', separate: '需单独申请' }

// 安装时不能授予、需要在已安装卡片上单独申请的高风险权限（spec 5.3）
const HIGH_RISK_PERMISSIONS = new Set(['fs:write:any', 'network:any', 'process:spawn'])

function highRiskDeclared(row: ExternalRow): string[] {
  return (row.permissions ?? []).filter((p) => HIGH_RISK_PERMISSIONS.has(p))
}

function isRowGranted(row: ExternalRow, permission: string): boolean {
  return (row.granted ?? []).includes(permission)
}

const V2_PERMISSION_TEXT: Record<string, string> = {
  'objects:read': '读对象（任务、项目等）',
  'objects:write': '写对象（任务、项目等）',
  'events:subscribe': '订阅宿主事件',
  'agent:run': '调用宿主 Agent 能力',
  'notify': '发系统通知',
  'schedule': '注册定时任务',
  'artifacts:write': '登记产出物',
  'audit:write': '写审计记录',
  'fs:read:any': '读本机任意路径',
  'fs:write:any': '写本机任意路径',
  'process:spawn': '起子进程',
  'network:any': '访问任意外网地址',
  'network:github': '访问 GitHub',
  'trade:live': '实盘下单',
}

function permissionText(name: string): string {
  const known = V2_PERMISSION_TEXT[name]
  if (known) return known
  if (name.startsWith('secrets:')) return `取凭证保险箱里「${name.slice('secrets:'.length)}」范围的凭证`
  return name
}

/** 外部插件的权限：普通权限随安装授予；high / separate 本批只展示、不授予 */
function isGrantedByInstall(p: ExternalPermissionInfo): boolean {
  return (p.risk ?? 'normal') === 'normal'
}

function manifestOf(preview: ExternalPreview | null): ExternalManifestV2 | undefined {
  return preview?.manifest
}

function sourceLabel(source?: ExternalSource): string {
  if (!source) return '来源未知'
  if (source.type === 'github') return `GitHub：${source.url ?? '（未填）'}`
  if (source.type === 'dir') return `本地目录：${source.path ?? '（未填）'}`
  if (source.type === 'archive') return `安装包：${source.path ?? '（未填）'}`
  if (source.type === 'dev') return `开发目录（链接）：${source.path ?? '（未填）'}`
  return String(source.type)
}

function buildSource(kind: SourceKind, value: string, sha256: string): ExternalSource | null {
  const v = value.trim()
  if (!v) return null
  const hash = sha256.trim()
  const base = hash ? { sha256: hash } : {}
  if (kind === 'github') return { type: 'github', url: v, ...base }
  return { type: kind, path: v, ...base }
}

export function ExternalPlugins({ reload = () => window.location.reload() }: {
  /** 启用了启动时没路由的外部模块后整页重新加载；测试里换掉 */
  reload?: () => void
}) {
  const q = useExternalPlugins()
  const resolve = useResolveExternalPlugin()
  const install = useInstallExternalPlugin()
  const action = useExternalAction()
  const grant = useGrantExternalPermission()
  const revoke = useRevokeExternalPermission()
  const upgrade = useUpgradeExternalPlugin()
  const rollback = useRollbackExternalPlugin()
  const [granting, setGranting] = useState<{ row: ExternalRow; permission: string } | null>(null)
  const [rollingBack, setRollingBack] = useState<ExternalRow | null>(null)
  const [kind, setKind] = useState<SourceKind>('github')
  const [value, setValue] = useState('')
  const [sha256, setSha256] = useState('')
  const [preview, setPreview] = useState<ExternalPreview | null>(null)
  // 安装/升级用的来源：从表单解析或从市场条目来；不在预览时重新读表单，避免装错包
  const [previewSource, setPreviewSource] = useState<ExternalSource | null>(null)
  const marketQuery = useFetchExternalMarket()
  const reloadDev = useReloadExternalDev()
  const [marketUrl, setMarketUrl] = useState('')
  const [market, setMarket] = useState<Awaited<ReturnType<typeof externalPluginsApi.market>> | null>(null)
  const [marketSearch, setMarketSearch] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [uninstalling, setUninstalling] = useState<ExternalRow | null>(null)
  const [deleteData, setDeleteData] = useState(false)
  const busy = resolve.isPending || install.isPending || action.isPending || grant.isPending || revoke.isPending || upgrade.isPending || rollback.isPending || reloadDev.isPending

  const list = q.data ?? []
  const fail = (what: string, e: unknown) => setNotice({ tone: 'danger', text: `${what}失败：${errorText(e)}` })

  // 后端启用成功后加载前端入口。第一次启用外部模块要整页重新加载才会进菜单/路由
  async function afterEnabled(row: ExternalRow) {
    const source = { ...row, enabled: true }
    const sources = externalSources([source], { enabledOnly: false })
    const r = await activatePlugin(row.id, [...discoverPlugins(), ...sources])
    if (!r.ok) {
      setNotice({ tone: 'danger', text: `后端已启用「${row.name}」，前端没能加载：${r.reasons.join('；')}` })
      return
    }
    const text = `已启用「${row.name}」，菜单里已出现`
    if (r.reload) {
      saveNotice(text)
      reload()
      return
    }
    setNotice({ tone: 'ok', text })
  }

  function onResolve() {
    const source = buildSource(kind, value, sha256)
    if (!source) {
      setNotice({ tone: 'danger', text: '先填安装来源：GitHub 链接、本地目录或 tar.gz 路径' })
      return
    }
    resolve.mutate(source, {
      onSuccess: (p) => {
        setPreview(p)
        setPreviewSource(source)
        if (!p.compatible) setNotice({ tone: 'danger', text: '这个包和当前宿主不兼容，不能安装' })
        else setNotice(null)
      },
      onError: (e) => { setPreview(null); fail('解析', e) },
    })
  }

  function onInstall() {
    const source = previewSource ?? buildSource(kind, value, sha256)
    if (!source || !preview) return
    const confirm = (preview.permissions ?? []).filter(isGrantedByInstall).map((p) => p.name)
    install.mutate({ source, confirmPermissions: confirm, enable: true }, {
      onSuccess: (r) => {
        setPreview(null)
        setPreviewSource(null)
        setValue('')
        setSha256('')
        const warnings = r.warnings?.length ? `（${r.warnings.join('；')}）` : ''
        if (!r.enabled) {
          setNotice({ tone: 'ok', text: `已安装「${r.plugin.name}」，未启用${warnings}` })
          return
        }
        // 启用成功的由 afterEnabled 提示；warnings 先放进错误提示更醒目
        if (warnings) setNotice({ tone: 'danger', text: `已安装并启用「${r.plugin.name}」${warnings}` })
        void afterEnabled(r.plugin)
      },
      onError: (e) => fail('安装', e),
    })
  }

  function onEnable(row: ExternalRow) {
    action.mutate({ id: row.id, action: 'enable' }, {
      onSuccess: (updated) => { void afterEnabled({ ...updated, enabled: true }) },
      onError: (e) => fail(`启用「${row.name}」`, e),
    })
  }

  function onDisable(row: ExternalRow) {
    action.mutate({ id: row.id, action: 'disable' }, {
      onSuccess: () => {
        deactivatePlugin(row.id)
        setNotice({ tone: 'ok', text: `已停用「${row.name}」，菜单里已去掉，数据都保留` })
      },
      onError: (e) => fail(`停用「${row.name}」`, e),
    })
  }

  function onUpgrade() {
    const source = previewSource ?? buildSource(kind, value, sha256)
    if (!source || !preview?.existing) return
    const confirm = (preview.permissions ?? []).filter(isGrantedByInstall).map((p) => p.name)
    upgrade.mutate({ id: preview.existing.id, source, confirmPermissions: confirm }, {
      onSuccess: (row) => {
        setPreview(null)
        setPreviewSource(null)
        setValue('')
        setSha256('')
        saveNotice(`已升级「${row.name}」到 ${row.version}，页面将刷新以加载新前端`)
        reload()
      },
      onError: (e) => fail('升级', e),
    })
  }

  function onMarketInstall(entry: ExternalMarketEntry, version: ExternalMarketVersion) {
    const source: ExternalSource = { type: 'github', url: version.install.url, sha256: version.install.sha256 }
    resolve.mutate(source, {
      onSuccess: (p) => {
        setPreview(p)
        setPreviewSource(source)
        setValue('')
        setSha256('')
        setNotice({ tone: 'ok', text: `已载入「${entry.title || entry.id}」${version.version} 的预览，确认权限后安装` })
      },
      onError: (e) => fail('解析市场条目', e),
    })
  }

  function onRollback() {
    const row = rollingBack
    if (!row) return
    rollback.mutate(row.id, {
      onSuccess: (next) => {
        setRollingBack(null)
        saveNotice(`已回滚「${next.name}」到 ${next.version}，页面将刷新`)
        reload()
      },
      onError: (e) => { setRollingBack(null); fail('回滚', e) },
    })
  }

  async function onUninstall() {
    const row = uninstalling
    if (!row) return
    try {
      if (row.enabled) {
        await action.mutateAsync({ id: row.id, action: 'disable' })
        // 停用成功后先把前端注册撤掉，卸载失败也不会留下半截槽位
        deactivatePlugin(row.id)
      }
      await action.mutateAsync({ id: row.id, action: 'uninstall', deleteData })
      deactivatePlugin(row.id)
      setUninstalling(null)
      setDeleteData(false)
      setNotice({ tone: 'ok', text: `已卸载「${row.name}」${deleteData ? '，插件数据已删除' : '，数据保留'}` })
    } catch (e) {
      setUninstalling(null)
      fail(`卸载「${row.name}」`, e)
    }
  }

  const marketEntries = (market?.entries ?? []).filter((e) => {
    const q = marketSearch.trim().toLowerCase()
    if (!q) return true
    return [e.id, e.title, e.description, e.author, e.repository, ...(e.categories ?? []), ...(e.labels ?? [])]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
  })
  const previewManifest = manifestOf(preview)
  const normalPerms = (preview?.permissions ?? []).filter(isGrantedByInstall)
  const riskyPerms = (preview?.permissions ?? []).filter((p) => !isGrantedByInstall(p))

  return (
    <section className="plg-section xpl" aria-label="外部插件（P1-a）">
      <div className="plg-section-head">
        <h2>外部插件（P1-a）</h2>
        <span className="plg-muted">第三方插件包：GitHub、本地目录或 tar.gz，装完默认启用</span>
      </div>

      {notice && (
        <div className={cls('plg-notice', notice.tone === 'danger' && 'plg-notice-danger')} role="status">
          <span className="plg-notice-text">{notice.text}</span>
          <Button size="sm" onClick={() => setNotice(null)}>知道了</Button>
        </div>
      )}

      <div className="xpl-block">
        <div className="plg-section-head">
          <h3>已安装</h3>
          <span className="plg-muted">{list.length} 个</span>
          <div className="spacer" />
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => reloadDev.mutate(undefined, {
              onSuccess: (rows) => setNotice({ tone: 'ok', text: `已重新加载开发目录：${rows.length} 个 dev 插件` }),
              onError: (e) => fail('重新加载开发目录', e),
            })}>
            {reloadDev.isPending ? '加载中' : '重新加载开发目录'}
          </Button>
        </div>
        {list.length === 0 ? (
          <EmptyState compact title="还没有安装外部插件" desc="在下面填安装来源，先「解析」看权限和风险，再安装。" />
        ) : (
          <div className="plg-grid">
            {list.map((row) => (
              <div key={row.id} className={cls('plg-card', row.error && 'plg-card-bad')} data-external-plugin={row.id}>
                <div className="plg-card-text">
                  <div className="plg-name">
                    {row.name || row.id}
                    <span className="plg-version">{row.version}</span>
                    <Pill
                      label={row.enabled ? (row.running ? '已启用' : '已启用，没在运行') : '已停用'}
                      color={row.enabled ? (row.running ? 'var(--ok)' : 'var(--warn)') : 'var(--faint)'}
                    />
                    <Pill
                      label={row.tier === 'verified' ? '已验签' : '社区'}
                      color={row.tier === 'verified' ? 'var(--ok)' : 'var(--faint)'}
                    />
                  </div>
                  <div className="plg-desc">{row.description || row.id}</div>
                  <div className="xpl-meta">
                    <code className="plg-code">{row.id}</code>
                    <span className="plg-muted">{sourceLabel(row.source)}</span>
                  </div>
                  {highRiskDeclared(row).length > 0 ? (
                    <div className="xpl-perms" aria-label="高风险权限">
                      {highRiskDeclared(row).map((perm) => {
                        const granted = isRowGranted(row, perm)
                        return (
                          <div key={perm} className="xpl-perm-row" data-granted={granted}>
                            <span className="xpl-perm-name">{permissionText(perm)}</span>
                            <code className="plg-code">{perm}</code>
                            <Pill label={granted ? '已授予' : '未授予'} color={granted ? 'var(--ok)' : 'var(--warn)'} />
                            {granted ? (
                              <Button size="sm" variant="outline" disabled={busy}
                                onClick={() => revoke.mutate({ id: row.id, permission: perm }, { onError: (e) => fail(`收回「${perm}」`, e) })}>收回</Button>
                            ) : (
                              <Button size="sm" variant="primary" disabled={busy}
                                onClick={() => setGranting({ row, permission: perm })}>单独授予</Button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                  {row.error ? <div className="xpl-error" role="alert">运行出错：{row.error}</div> : null}
                </div>
                <div className="plg-card-foot">
                  <div className="spacer" />
                  {row.enabled ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => onDisable(row)}>停用</Button>
                  ) : (
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => onEnable(row)}>启用</Button>
                  )}
                  {row.previous_version ? (
                    <Button size="sm" variant="outline" disabled={busy}
                      onClick={() => setRollingBack(row)}>回滚到 {row.previous_version}</Button>
                  ) : null}
                  <Button size="sm" variant="danger-ghost" disabled={busy}
                    onClick={() => { setUninstalling(row); setDeleteData(false) }}>卸载</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="xpl-block" aria-label="安装外部插件">
        <div className="plg-section-head"><h3>安装</h3><span className="plg-muted">先解析预览，确认权限后安装</span></div>
        <div className="xpl-form">
          <Field label="来源类型">
            <Select
              options={SOURCE_OPTIONS}
              value={kind}
              onValueChange={(v) => { setKind(v as SourceKind); setPreview(null) }}
            />
          </Field>
          <Field label={kind === 'github' ? 'GitHub 地址' : kind === 'dir' ? '本地目录' : '安装包路径'}>
            <Input value={value} placeholder={SOURCE_PLACEHOLDER[kind]} autoComplete="off"
              onChange={(e) => { setValue(e.target.value); setPreview(null) }} />
          </Field>
          <Field label="SHA-256（可选）" hint="填了就校验下载/读取到的包的哈希">
            <Input value={sha256} placeholder="64 位十六进制" autoComplete="off"
              onChange={(e) => { setSha256(e.target.value); setPreview(null) }} />
          </Field>
          <div className="xpl-form-actions">
            <Button variant="primary" disabled={busy} onClick={onResolve}>
              {resolve.isPending ? '解析中' : '解析'}
            </Button>
          </div>
        </div>

        {preview && (
          <div className="xpl-preview" aria-label="安装预览" data-compatible={preview.compatible ? 'yes' : 'no'}>
            <div className="xpl-preview-head">
              <div>
                <div className="plg-name">
                  {previewManifest?.name || '（清单没有名字）'}
                  <span className="plg-version">{previewManifest?.version || ''}</span>
                  <code className="plg-code">{previewManifest?.id || ''}</code>
                </div>
                <div className="plg-desc">{previewManifest?.description}</div>
              </div>
              <div className="xpl-badges">
                <Pill label={preview.compatible ? '兼容' : '不兼容'} color={preview.compatible ? 'var(--ok)' : 'var(--danger)'} />
                <Pill label={preview.tier === 'verified' ? '已验签' : '社区'} color={preview.tier === 'verified' ? 'var(--ok)' : 'var(--faint)'} />
              </div>
            </div>
            <div className="xpl-preview-rows">
              <div className="xpl-preview-row"><span className="plg-muted">来源</span><span>{sourceLabel(preview.source)}</span></div>
              {preview.platform ? <div className="xpl-preview-row"><span className="plg-muted">目标平台</span><span>{preview.platform}</span></div> : null}
              {preview.web_entry ? <div className="xpl-preview-row"><span className="plg-muted">前端入口</span><code className="plg-code">{preview.web_entry}</code></div> : null}
              {preview.package_sha256 ? (
                <div className="xpl-preview-row"><span className="plg-muted">包 SHA-256</span><code className="plg-code plg-path">{preview.package_sha256}</code></div>
              ) : null}
              {preview.existing ? (
                <div className="xpl-preview-row">
                  <span className="plg-muted">已安装</span>
                  <span>「{preview.existing.name}」{preview.existing.version}，装完会覆盖安装目录（启用状态保持）</span>
                </div>
              ) : null}
            </div>

            {preview.checks?.length ? (
              <ul className="xpl-checks" aria-label="检查项">
                {preview.checks.map((c) => (
                  <li key={c.name} data-ok={c.ok}>
                    <span className={cls('xpl-check-mark', c.ok ? 'xpl-ok' : 'xpl-bad')}>{c.ok ? '✓' : '✗'}</span>
                    <span>{c.name}</span>
                    {c.detail ? <span className="plg-muted">{c.detail}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {(normalPerms.length > 0 || riskyPerms.length > 0) ? (
              <div className="plg-perms" aria-label="要授予的权限">
                <div className="plg-perms-title">权限</div>
                {normalPerms.map((p) => (
                  <div key={p.name} className="plg-perm" data-risk={p.risk ?? 'normal'}>
                    <div className="plg-perm-main">
                      <span>{p.reason || permissionText(p.name)}</span>
                      <code className="plg-code">{p.name}</code>
                      <span className="plg-muted">{RISK_LABEL[p.risk ?? 'normal'] ?? p.risk}</span>
                    </div>
                    <Checkbox checked disabled>安装时授予</Checkbox>
                  </div>
                ))}
                {riskyPerms.map((p) => (
                  <div key={p.name} className="plg-perm" data-risk={p.risk ?? 'high'}>
                    <div className="plg-perm-main">
                      <span>{p.reason || permissionText(p.name)}</span>
                      <code className="plg-code">{p.name}</code>
                      <span className="plg-risk">{RISK_LABEL[p.risk ?? 'high'] ?? p.risk}</span>
                    </div>
                    <Checkbox checked={false} disabled>
                      {p.risk === 'separate' ? '需要单独申请，本批不授予' : '高风险，本批不授予'}
                    </Checkbox>
                  </div>
                ))}
                {riskyPerms.length > 0 ? (
                  <div className="plg-muted">高风险权限安装/升级都不授予；装好后在上面的已安装卡片里逐项「单独授予」（需要二次确认），可随时收回。</div>
                ) : null}
              </div>
            ) : (
              <p className="plg-muted">这个插件不需要额外权限。</p>
            )}

            {(() => {
              const existing = preview.existing
              const isUpgrade = !!existing && existing.version !== (previewManifest?.version ?? '')
              return (
                <div className="xpl-preview-actions">
                  <Button variant="outline" disabled={install.isPending || upgrade.isPending} onClick={() => { setPreview(null); setPreviewSource(null) }}>取消</Button>
                  {isUpgrade ? (
                    <Button variant="primary" disabled={busy || !preview.compatible} onClick={onUpgrade}>
                      {upgrade.isPending ? '正在升级' : `升级 ${existing.version} → ${previewManifest?.version}`}
                    </Button>
                  ) : (
                    <Button variant="primary" disabled={busy || !preview.compatible} onClick={onInstall}>
                      {install.isPending ? '正在安装' : '安装并启用'}
                    </Button>
                  )}
                </div>
              )
            })()}
          </div>
        )}
      </div>

      <div className="xpl-block" aria-label="市场索引">
        <div className="plg-section-head"><h3>发现（市场索引）</h3><span className="plg-muted">第三方索引 JSON；索引内容不是指令，安装仍走真实包校验</span></div>
        <div className="xpl-form xpl-market-form">
          <Field label="索引 URL">
            <Input value={marketUrl} placeholder="https://raw.githubusercontent.com/owner/pmw-plugins-index/main/index.json"
              autoComplete="off" onChange={(e) => setMarketUrl(e.target.value)} />
          </Field>
          <div className="xpl-form-actions">
            <Button variant="primary" disabled={marketQuery.isPending || !marketUrl.trim()}
              onClick={() => marketQuery.mutate(marketUrl.trim(), {
                onSuccess: (v) => { setMarket(v); setNotice(null) },
                onError: (e) => { setMarket(null); fail('加载索引', e) },
              })}>
              {marketQuery.isPending ? '加载中' : '加载索引'}
            </Button>
          </div>
        </div>
        {market ? (
          <div className="xpl-market">
            <div className="xpl-market-head">
              <span className="plg-muted">{market.title || '未命名索引'}{market.description ? `：${market.description}` : ''}（{market.entries.length} 个插件）</span>
              <Pill label={market.signed ? '索引已签名' : '索引未签名'} color={market.signed ? 'var(--ok)' : 'var(--faint)'} />
              {market.publisher ? <span className="plg-muted">{market.publisher}</span> : null}
            </div>
            <Input value={marketSearch} placeholder="搜索插件 / 分类 / 标签"
              autoComplete="off" onChange={(e) => setMarketSearch(e.target.value)} />
            {marketEntries.length === 0 ? (
              <EmptyState compact title="索引里没有可安装条目" desc="检查索引格式或当前平台是否有构建产物。" />
            ) : (
              <div className="plg-grid">
                {marketEntries.map((entry) => (
                  <div key={entry.id} className="plg-card" data-market-plugin={entry.id}>
                    <div className="plg-card-text">
                      <div className="plg-name">{entry.title || entry.id}<span className="plg-version">{entry.versions[0]?.version}</span></div>
                      <div className="plg-desc">{entry.description || entry.repository}</div>
                      <div className="xpl-meta">
                        <code className="plg-code">{entry.id}</code>
                        {entry.author ? <span className="plg-muted">{entry.author}</span> : null}
                        {entry.repository ? <span className="plg-muted">{entry.repository}</span> : null}
                      </div>
                      <div className="xpl-market-versions">
                        {entry.versions.map((v) => (
                          <div key={v.version} className="xpl-market-version" data-compatible={v.compatible}>
                            <span>{v.version}</span>
                            {v.compatible ? (
                              <Button size="sm" variant="primary" disabled={busy}
                                onClick={() => onMarketInstall(entry, v)}>安装</Button>
                            ) : (
                              <Pill label="不兼容" color="var(--danger)" />
                            )}
                            {v.reason ? <span className="plg-muted">{v.reason}</span> : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {rollingBack && (
        <ConfirmDialog
          open
          danger
          title={`回滚「${rollingBack.name}」到 ${rollingBack.previous_version}`}
          confirmLabel={rollback.isPending ? '正在回滚' : `回滚到 ${rollingBack.previous_version}`}
          busy={rollback.isPending}
          onConfirm={onRollback}
          onCancel={() => setRollingBack(null)}
        >
          <p className="plg-dialog-p">
            只回滚插件代码与清单；插件私有库的数据库迁移不会回退，旧版本若依赖旧表结构可能报错。
            需要更稳妥时先备份插件数据。
          </p>
        </ConfirmDialog>
      )}

      {granting && (
        <ConfirmDialog
          open
          danger
          title={`授予「${granting.row.name}」高风险权限`}
          confirmLabel={grant.isPending ? '正在授予' : `授予 ${granting.permission}`}
          busy={grant.isPending}
          onConfirm={() => {
            grant.mutate(
              { id: granting.row.id, permission: granting.permission, confirm: granting.row.name },
              {
                onSuccess: () => { setGranting(null); setNotice({ tone: 'ok', text: `已授予「${granting.row.name}」的 ${granting.permission}` }) },
                onError: (e) => { setGranting(null); fail(`授予「${granting.permission}」`, e) },
              },
            )
          }}
          onCancel={() => setGranting(null)}
        >
          <p className="plg-dialog-p">
            插件「{granting.row.name}」声明了 <code className="plg-code">{granting.permission}</code>（{permissionText(granting.permission)}）。
            授予后它就能使用这项高风险能力；确认这是你信任的插件，再继续。
          </p>
          <p className="plg-muted">授予可在卡片上随时收回；插件进程会收到权限变更通知。trade:live 在 v0.1 外部插件里一律不授予。</p>
        </ConfirmDialog>
      )}

      {uninstalling && (
        <ConfirmDialog
          open
          danger
          title={`卸载「${uninstalling.name}」`}
          confirmLabel={action.isPending ? '正在卸载' : '卸载'}
          busy={action.isPending}
          onConfirm={() => { void onUninstall() }}
          onCancel={() => { setUninstalling(null); setDeleteData(false) }}
        >
          <p className="plg-dialog-p">卸载后菜单里的模块和它注册的槽位会去掉。</p>
          <div className="plg-choices" role="radiogroup" aria-label="卸载时的数据">
            <label className="plg-choice">
              <input type="radio" name="xpl-uninstall" checked={!deleteData} onChange={() => setDeleteData(false)} />
              <span><strong>保留数据</strong><span className="plg-muted">插件的私有库和缓存都留着，重新安装后接着用</span></span>
            </label>
            <label className="plg-choice">
              <input type="radio" name="xpl-uninstall" checked={deleteData} onChange={() => setDeleteData(true)} />
              <span><strong>删除数据</strong><span className="plg-muted">删掉插件的私有库、数据和缓存</span></span>
            </label>
          </div>
        </ConfirmDialog>
      )}
    </section>
  )
}
