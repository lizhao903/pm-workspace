// 设置里的「知识库」分节（AG-01b7），照原型 web-next/src/kbskills.tsx 的 KnowledgePage、KbDrawer（SPEC-settings-10 到 14）。
// 打开的知识库和标签记在地址的 ?kb=&tab= 上，刷新、后退都回得来；抽屉（新建、改名称和分类）在这一层，列表和详情共用。
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { QueryState, useKnowledgeBases } from '../../../core/data'
import { KbDetail, type KbTab } from './KbDetail'
import { KbDrawer } from './KbDrawer'
import { KbList } from './KbList'
import './kb.css'

type Open = { mode: 'new'; slot: number } | { mode: 'edit'; id: string; slot?: number }

const TABS: KbTab[] = ['docs', 'search', 'settings']

export function KbSection() {
  const q = useKnowledgeBases()
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState<Open | null>(null)
  const [slot, setSlot] = useState(0)
  const kbId = params.get('kb') ?? ''
  const tabParam = params.get('tab') as KbTab | null
  const tab: KbTab = tabParam && TABS.includes(tabParam) ? tabParam : 'docs'

  const go = (id: string | null, t?: KbTab) => {
    const next = new URLSearchParams()
    if (id) next.set('kb', id)
    if (id && t && t !== 'docs') next.set('tab', t)
    setParams(next)
  }
  const openNew = () => { setSlot(slot + 1); setOpen({ mode: 'new', slot: slot + 1 }) }

  return (
    <QueryState query={q}>
      {(kbs) => {
        const kb = kbId ? kbs.find((k) => k.id === kbId) : undefined
        const editing = open?.mode === 'edit' ? kbs.find((k) => k.id === open.id) : undefined
        return (
          <>
            {kb ? (
              <KbDetail key={kb.id} kb={kb} tab={tab} onTab={(t) => go(kb.id, t)} onBack={() => go(null)}
                editing={editing?.id === kb.id} onEdit={() => setOpen({ mode: 'edit', id: kb.id })} />
            ) : (
              <KbList kbs={kbs} selected={editing?.id ?? null} missing={!!kbId} onOpen={(id) => go(id)} onNew={openNew} />
            )}
            {open?.mode === 'new' && (
              <KbDrawer key={`new-${open.slot}`} onClose={() => setOpen(null)}
                onCreated={(k) => setOpen({ mode: 'edit', id: k.id, slot: open.slot })} />
            )}
            {open?.mode === 'edit' && editing && (
              <KbDrawer key={open.slot !== undefined ? `new-${open.slot}` : editing.id} kb={editing} onClose={() => setOpen(null)}
                onCreated={() => undefined}
                onDeleted={() => { setOpen(null); if (kbId === editing.id) go(null) }} />
            )}
          </>
        )
      }}
    </QueryState>
  )
}
