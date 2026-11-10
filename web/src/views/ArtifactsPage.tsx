// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 输出产物页：「这些事一共产出了什么」的唯一汇总处。
//
// 统计和列表走同一套过滤参数（api.artifactStats 与 api.artifacts 共用 ArtifactFilter），
// 所以顶部那几个数永远描述的是下面这个列表。各自拼一套条件的话，
// 会出现「共 9 件」但列表只有 7 行，两个数字都不报错。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { Artifact, ArtifactFilter, ArtifactSource, ArtifactStats } from '../lib/types'
import { ARTIFACT_SOURCE_LABELS } from '../lib/types'
import ArtifactDialog from '../components/artifacts/ArtifactDialog'
import ArtifactList, { formatSize } from '../components/artifacts/ArtifactList'
import { platformLabel, usePlatforms } from '../components/artifacts/platforms'
import { Button, TextInput } from '../components/ui'
import '../artifacts.css'

const cls = (...xs: Array<string | false | undefined>) => xs.filter(Boolean).join(' ')

/** 位置筛选的三档。用一个字符串枚举而不是两个布尔：
 *  两个布尔能表达出「本地=true 且 云端=false 且 …」这类组合，
 *  而界面上只有三个互斥的按钮，多出来的状态永远到不了，却要在每处判断里考虑。 */
type Where = 'all' | 'local-only' | 'published'

const WHERE_FILTER: Record<Where, Pick<ArtifactFilter, 'has_url' | 'has_path'>> = {
  all: {},
  // 「只在本地，还没发出去」——这是用户真会问的一个问题：哪些东西做完了但没同步出去。
  'local-only': { has_url: false },
  published: { has_url: true },
}

export default function ArtifactsPage() {
  const platforms = usePlatforms()

  const [q, setQ] = useState('')
  const [platform, setPlatform] = useState('')
  const [source, setSource] = useState<ArtifactSource | ''>('')
  const [where, setWhere] = useState<Where>('all')
  const [unscoped, setUnscoped] = useState(false)

  const [items, setItems] = useState<Artifact[]>([])
  const [stats, setStats] = useState<ArtifactStats | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Artifact | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const filter = useMemo<ArtifactFilter>(() => ({
    q: q.trim() || undefined,
    platform: platform || undefined,
    source: source || undefined,
    unscoped: unscoped || undefined,
    ...WHERE_FILTER[where],
  }), [q, platform, source, where, unscoped])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // 两个请求并发，但**用的是同一个 filter 对象**——这是「统计和列表对得上」
      // 的实现依据，拆成两处各自构造条件就会分叉。
      const [list, st] = await Promise.all([
        api.artifacts(filter),
        api.artifactStats(filter),
      ])
      setItems(list.items)
      setTotal(list.total)
      setStats(st)
    } catch {
      // 接口不可用时按空态处理，不弹横幅——挡住页面对用户没有帮助。
      setItems([])
      setTotal(0)
      setStats(null)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    // 搜索框防抖：每敲一个字打两个请求（列表 + 统计），中文输入法下更密。
    const t = setTimeout(() => { void load() }, 200)
    return () => clearTimeout(t)
  }, [load])

  const openNew = () => { setEditing(null); setDialogOpen(true) }
  const openEdit = (a: Artifact) => { setEditing(a); setDialogOpen(true) }

  return (
    <div className="ar-page">
      <div className="ar-head">
        <span className="ar-page-title">输出产物</span>
        <span className="faint ar-page-sub">本地文件与发到各平台的东西都在这里汇总</span>
        <div className="ar-head-actions">
          <TextInput
            className="input ar-search"
            value={q}
            onValueChange={setQ}
            placeholder="搜标题、路径、链接、备注"
            aria-label="搜索产物"
          />
          <Button variant="primary" onClick={openNew}>登记产物</Button>
        </div>
      </div>

      <div className="ar-stats">
        <Stat label="共计" value={stats?.total ?? 0} />
        {/* 本地 + 已发布可能大于共计：一份既在本地又发了云端的产物两边都算。
            标题下面那行小字就是为了说明这件事，不然用户会以为数字算错了。 */}
        <Stat label="本地有文件" value={stats?.local ?? 0} />
        <Stat label="已发到平台" value={stats?.remote ?? 0} />
        <Stat label="未归属" value={stats?.unscoped ?? 0} />
        <Stat label="本地占用" value={formatSize(stats?.total_size ?? 0, true)} />
      </div>
      <div className="faint ar-stats-note">
        一份东西既在本地又发了云端时，「本地有文件」和「已发到平台」都会算它一次，
        所以两者相加可能大于共计。
      </div>

      <div className="ar-filters">
        <div className="seg">
          {(['all', 'local-only', 'published'] as Where[]).map((w) => (
            <button
              key={w}
              type="button"
              className={cls('seg-item', where === w && 'seg-item-active')}
              onClick={() => setWhere(w)}
            >
              {w === 'all' ? '全部' : w === 'local-only' ? '还没发出去' : '已发到平台'}
            </button>
          ))}
        </div>

        <div className="ar-chips">
          <button
            type="button"
            className={cls('chip', !platform && 'chip-active')}
            onClick={() => setPlatform('')}
          >
            全部平台
          </button>
          {platforms.map((p) => {
            const n = stats?.by_platform?.[p.key] ?? 0
            return (
              <button
                key={p.key}
                type="button"
                className={cls('chip', platform === p.key && 'chip-active')}
                onClick={() => setPlatform(platform === p.key ? '' : p.key)}
              >
                <span className="chip-dot" style={{ background: p.color || '#868e96' }} />
                {p.label}
                {/* 数字来自当前筛选下的统计。选中某个平台后其余平台会显示 0，
                    那是诚实的：它说的是「在当前条件下」，不是「一共」。 */}
                <span className="chip-n">{n}</span>
              </button>
            )
          })}
        </div>

        <div className="ar-chips">
          <button
            type="button"
            className={cls('chip', !source && 'chip-active')}
            onClick={() => setSource('')}
          >
            全部来源
          </button>
          {(Object.keys(ARTIFACT_SOURCE_LABELS) as ArtifactSource[]).map((s) => (
            <button
              key={s}
              type="button"
              className={cls('chip', source === s && 'chip-active')}
              onClick={() => setSource(source === s ? '' : s)}
            >
              {ARTIFACT_SOURCE_LABELS[s]}
              <span className="chip-n">{stats?.by_source?.[s] ?? 0}</span>
            </button>
          ))}
          <button
            type="button"
            className={cls('chip', unscoped && 'chip-active')}
            title="工作对象被彻底删除后，它的产物会落到这里"
            onClick={() => setUnscoped(!unscoped)}
          >
            仅未归属
          </button>
        </div>
      </div>

      <div className="ar-body">
        {loading && items.length === 0
          ? <div className="faint ar-empty">加载中…</div>
          : (
            <>
              {total > items.length && (
                <div className="faint ar-more">
                  共 {total} 件，当前显示前 {items.length} 件。缩小筛选范围可以看到其余的。
                </div>
              )}
              <ArtifactList
                items={items}
                onEdit={openEdit}
                onChanged={() => void load()}
                emptyHint={
                  q || platform || source || unscoped || where !== 'all'
                    ? '当前筛选下没有产物。'
                    : '还没有登记任何产物。AI 助手写盘、任务执行改动文件会自动记进来；发到 Confluence、飞书这类平台的，点右上角「登记产物」把链接贴进来。'
                }
              />
            </>
          )}
      </div>

      <ArtifactDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={() => void load()}
      />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="ar-stat">
      <div className="ar-stat-v">{value}</div>
      <div className="faint ar-stat-l">{label}</div>
    </div>
  )
}

/** 平台标签在别处也要用，从这里透出去省得各自 import 两个模块。 */
export { platformLabel }
