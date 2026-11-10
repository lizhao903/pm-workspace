// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 工具与权限标签（AG-02b，SPEC-settings-9.15 到 9.20、9.35 到 9.37），照原型 web-next/src/agents.tsx 的 tools 标签。
// 授权是草稿的一部分，和别的字段一起「保存」；连接器工具的档位不超过连接器那边的上限。
import { useState } from 'react'
import type { AgentGrantMode } from '../../../core/data'
import { Button, cls, ConnectorLogo, Tag } from '../../../core/ui'
import { MountPicker } from './MountPicker'
import { ABILITIES, BULK_LABEL, BULK_LEVELS, MODE_LABEL, bulkGrants, bulkLevelOf, hasAll, modeOptions, shownMode, type BulkLevel, type Grants, type MountableConn } from './model'
import { MiniSearch, Unmount } from './parts'

/** 工具多于这个数时，展开的工具列表上面有搜索框 */
const MANY_TOOLS = 10
const GROUPS = [...new Set(ABILITIES.map((a) => a.group))]

function ModeSeg({ label, opts, value, write, onChange }: {
  label: string
  opts: AgentGrantMode[]
  value: AgentGrantMode
  write: boolean
  onChange: (m: AgentGrantMode) => void
}) {
  return (
    <div className="ag-seg" role="radiogroup" aria-label={label}>
      {opts.map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v}
          className={cls(value === v && 'on', value === v && v === 'auto' && write && 'risky')} onClick={() => onChange(v)}>
          {MODE_LABEL[v]}
        </button>
      ))}
    </div>
  )
}

/** 一键全量设置：整组工具统一设成一档；现在对不上任何一档时都不亮（自定义） */
function BulkSeg({ label, items, grants, onModes }: {
  label: string
  items: { key: string; write: boolean; cap?: AgentGrantMode }[]
  grants: Grants
  onModes: (patch: Grants) => void
}) {
  const cur = bulkLevelOf(items, grants)
  const hasWrite = items.some((t) => t.write)
  // 没有写工具时读写两档和「只读」效果一样，不列出来
  const levels: BulkLevel[] = hasWrite ? BULK_LEVELS : ['off', 'read']
  return (
    <div className="ag-bulk">
      <span className="ag-sub">{cur ? '全部工具' : '全部工具（现在是自定义）'}</span>
      <div className="ag-seg" role="radiogroup" aria-label={label}>
        {levels.map((lv) => (
          <button key={lv} type="button" role="radio" aria-checked={cur === lv}
            className={cls(cur === lv && 'on', cur === lv && lv === 'rw_auto' && 'risky')} onClick={() => onModes(bulkGrants(items, lv))}>
            {lv === 'read' && !hasWrite ? '全部开启' : BULK_LABEL[lv]}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ToolsTab({ grants, mounted, candidates, open, onOpen, onMode, onModes, onMount, onUnmount, onGoConnectors }: {
  grants: Grants
  /** 挂着的连接器（mcps 里有、还存在的） */
  mounted: MountableConn[]
  /** 还能挂的 */
  candidates: MountableConn[]
  /** 展开着工具权限的连接器 */
  open: string | null
  onOpen: (id: string | null) => void
  onMode: (key: string, m: AgentGrantMode) => void
  /** 一次改多个工具的档位（一键全量设置） */
  onModes: (patch: Grants) => void
  onMount: (id: string) => void
  onUnmount: (id: string) => void
  onGoConnectors: () => void
}) {
  const [q, setQ] = useState('')
  const autoWrites = ABILITIES.filter((a) => a.write && grants[a.key] === 'auto')
  const toggle = (id: string) => { onOpen(open === id ? null : id); setQ('') }
  return (
    <>
      <section className="ag-sec">
        <div className="ag-sec-title">内置工具与权限<span className="ag-hint">写操作建议「需确认」：Agent 只提出要做什么，你点确认才执行</span></div>
        <BulkSeg label="内置工具全部设成" items={ABILITIES} grants={grants} onModes={onModes} />
        <div className="ag-ability-table">
          {GROUPS.map((g) => (
            <div key={g} className="ag-ability-group" role="group" aria-label={g}>
              <div className="ag-ability-group-name">{g}</div>
              {ABILITIES.filter((a) => a.group === g).map((a) => (
                <div key={a.key} className="ag-ability-row" data-ability={a.key}>
                  <span className="ag-ability-text">
                    <span>{a.label}{a.write && <span className="ag-write-tag">写</span>}</span>
                    {a.desc && <span className="ag-sub">{a.desc}</span>}
                  </span>
                  <ModeSeg label={a.label} opts={modeOptions(a.write)} value={shownMode(grants[a.key], modeOptions(a.write))} write={a.write}
                    onChange={(m) => onMode(a.key, m)} />
                </div>
              ))}
            </div>
          ))}
        </div>
        {autoWrites.length > 0 && (
          <div className="ag-banner ag-banner-warn" role="status">{autoWrites.map((a) => `「${a.label}」`).join('')}设为自动：Agent 会直接执行，不再等你确认。</div>
        )}
      </section>

      <section className="ag-sec">
        <div className="ag-mount-head">
          <div className="ag-sec-title">MCP / 连接器工具<span className="ag-hint">挂上后可以用它的工具；权限不能比连接器那边更松</span></div>
          <MountPicker label="挂载" items={candidates} empty="没有更多可挂的。去「设置 / 连接器」接入并获取工具清单"
            text={(c) => `${c.name} ${c.kind}`} group={(c) => c.kind} onPick={onMount}
            render={(c) => (
              <span className="ag-pick-conn">
                {c.look && <ConnectorLogo {...c.look} size={22} />}
                <span className="ag-mount-text">
                  <b>{c.name}</b>
                  <span className={cls('ag-sub', !c.ok && 'danger-text')}>{c.kind} · {c.tools.length} 个可用工具{!c.ok && ' · 连接异常'}</span>
                </span>
              </span>
            )} />
        </div>
        {mounted.length ? (
          <div className="ag-mount-list">
            {mounted.map((c) => {
              const on = c.tools.filter((t) => (grants[t.key] ?? 'off') !== 'off').length
              const isOpen = open === c.id
              const tools = c.tools.length > MANY_TOOLS ? c.tools.filter((t) => hasAll(`${t.name} ${t.desc}`, q)) : c.tools
              return (
                <div key={c.id} className={cls('ag-mount-card ag-conn', isOpen && 'open')} data-conn={c.id}>
                  <div className="ag-conn-head">
                    {c.look ? <ConnectorLogo {...c.look} size={26} /> : (
                      <span className="ag-mount-icon ag-icon-conn" aria-hidden="true">
                        <svg viewBox="0 0 16 16" width="13" height="13"><path d="M6 3v3M10 3v3M4.5 6h7v2.5a3.5 3.5 0 0 1-7 0ZM8 12v2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                      </span>
                    )}
                    <button type="button" className="ag-mount-text ag-conn-toggle" aria-expanded={isOpen} onClick={() => toggle(c.id)}>
                      <span><b>{c.name}</b><Tag>{c.kind}</Tag></span>
                      <span className={cls('ag-sub', !c.ok && 'danger-text')}>{c.ok ? `开了 ${on} / ${c.tools.length} 个工具` : '连接异常，调用会失败'}</span>
                    </button>
                    <Button size="sm" variant="ghost" onClick={() => toggle(c.id)}>{isOpen ? '收起' : '工具权限'}</Button>
                    <Unmount name={c.name} onClick={() => onUnmount(c.id)} />
                  </div>
                  {isOpen && c.tools.length > 0 && (
                    <div className="ag-conn-bulk"><BulkSeg label={`${c.name} 的工具全部设成`} items={c.tools} grants={grants} onModes={onModes} /></div>
                  )}
                  {isOpen && c.tools.length > MANY_TOOLS && (
                    <div className="ag-conn-search"><MiniSearch value={q} onChange={setQ} placeholder={`搜工具，共 ${c.tools.length} 个`} full /></div>
                  )}
                  {isOpen && (
                    <div className="ag-ability-table ag-conn-tools">
                      {tools.map((t) => {
                        const opts = modeOptions(t.write, t.cap)
                        return (
                          <div key={t.key} className="ag-ability-row" data-tool={t.name}>
                            <span className="ag-ability-text">
                              <span><code className="ag-tool-fn">{t.name}</code>{t.write && <span className="ag-write-tag">写</span>}</span>
                              <span className="ag-sub">{t.desc}{t.write && t.cap === 'confirm' && ' · 连接器要求确认'}</span>
                            </span>
                            <ModeSeg label={t.name} opts={opts} value={shownMode(grants[t.key], opts)} write={t.write} onChange={(m) => onMode(t.key, m)} />
                          </div>
                        )
                      })}
                      {!tools.length && <div className="ag-menu-empty">{c.tools.length ? '没有匹配的工具' : '连接器那边的工具都关了'}</div>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="ag-mount-empty">还没挂 MCP 或连接器。<button type="button" className="ag-link" onClick={onGoConnectors}>去接入</button></div>
        )}
      </section>
    </>
  )
}
