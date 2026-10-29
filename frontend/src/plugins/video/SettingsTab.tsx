// 视频详情的设置（SPEC-videos-13）：标题、所属项目、系列和集数、章节数、视频目录边输边存（停手 600 毫秒存一次，失焦立刻存），
// 画面比例只读，删除视频要确认。输入框用本地草稿，存回来不覆盖正在输的内容
import { useEffect, useRef, useState } from 'react'
import { errorText, projectView, useDeleteVideo, usePatchVideo, type Video, type VideoInput, type VideoSeries } from '../../core/data'
import { Button, ConfirmDialog, Field, Input, SearchSelect, Select } from '../../core/ui'
import { orientLocked } from './model'
import { OrientTag } from './parts'

const SAVE_MS = 600

type Draft = { title: string; root: string; chapters: string; episode: string }
const draftOf = (v: Video): Draft => ({ title: v.title, root: v.root, chapters: String(v.chapters), episode: v.episode ? String(v.episode) : '' })

export function SettingsTab({ v, series, projects, onDeleted }: {
  v: Video
  series: VideoSeries[]
  projects: ReturnType<typeof projectView>[]
  onDeleted: () => void
}) {
  const patch = usePatchVideo()
  const del = useDeleteVideo()
  const [draft, setDraft] = useState<Draft>(() => draftOf(v))
  const [confirmDel, setConfirmDel] = useState(false)
  const locked = orientLocked(v)
  // 最新的视频和草稿，给定时器和失焦用
  const latest = useRef({ v, draft })
  useEffect(() => { latest.current = { v, draft } })

  const save = (p: VideoInput) => { if (Object.keys(p).length) patch.mutate({ id: v.id, patch: p }) }

  /** 草稿里和视频不一样、而且合法的文字字段 */
  const textChanges = (): VideoInput => {
    const { v: cur, draft: d } = latest.current
    const out: VideoInput = {}
    if (d.title.trim() !== cur.title) out.title = d.title.trim()
    if (d.root.trim() !== cur.root) out.root = d.root.trim()
    const ch = Math.floor(Number(d.chapters))
    if (d.chapters.trim() && ch >= 1 && ch <= 999 && ch !== cur.chapters) out.chapters = ch
    const ep = Math.floor(Number(d.episode))
    if (cur.series_id && d.episode.trim() && ep >= 1 && ep <= 9999 && ep !== cur.episode) out.episode = ep
    return out
  }
  const flush = () => save(textChanges())

  // 停手一会儿就存
  useEffect(() => {
    const t = setTimeout(() => save(textChanges()), SAVE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  const set = (x: Partial<Draft>) => setDraft((d) => ({ ...d, ...x }))
  const chaptersBad = !(Math.floor(Number(draft.chapters)) >= 1 && Math.floor(Number(draft.chapters)) <= 999)
  const episodeBad = !!v.series_id && !(Math.floor(Number(draft.episode)) >= 1 && Math.floor(Number(draft.episode)) <= 9999)

  const onSeries = (id: string) => {
    if (id === (v.series_id ?? '')) return
    // 选了系列：集数默认原来的或 1；选单集清掉集数
    const ep = id ? v.episode ?? 1 : null
    set({ episode: ep ? String(ep) : '' })
    save({ series_id: id || null, episode: ep })
  }

  return (
    <div className="vd-settings">
      {patch.isError && <div className="vd-err" role="alert">没保存上：{errorText(patch.error)}</div>}
      <section className="vd-sec">
        <div className="vd-sec-title">基本信息</div>
        <Field label="标题">
          <Input value={draft.title} placeholder="比如：第 4 集：知识库怎么喂" onChange={(e) => set({ title: e.target.value })} onBlur={flush} />
        </Field>
        <div className="vd-field-row">
          <Field label="所属项目" wrap={false}>
            <SearchSelect variant="field" value={v.project_id ?? ''} noneLabel="不属于项目" placeholder="不属于项目" searchPlaceholder="搜项目" aria-label="所属项目"
              missingLabel={() => '已删除的项目'} options={projects.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(x) => { if (x !== (v.project_id ?? '')) save({ project_id: x || null }) }} />
          </Field>
          <Field label="章节数" error={chaptersBad ? '章节数要是 1 到 999' : undefined}>
            <Input type="number" min={1} max={999} value={draft.chapters} invalid={chaptersBad} onChange={(e) => set({ chapters: e.target.value })} onBlur={flush} />
          </Field>
        </div>
        <div className="vd-field-row">
          <Field label="系列" hint="同系列共用开场、收尾和模板">
            <Select value={v.series_id ?? ''} onValueChange={onSeries}
              options={[{ value: '', label: '单集（不属于系列）' }, ...series.map((s) => ({ value: s.id, label: s.name }))]} />
          </Field>
          <Field label="第几集" error={episodeBad ? '集数至少是 1' : undefined}>
            <Input type="number" min={1} disabled={!v.series_id} value={draft.episode} invalid={episodeBad}
              onChange={(e) => set({ episode: e.target.value })} onBlur={flush} />
          </Field>
        </div>
      </section>
      <section className="vd-sec">
        <div className="vd-sec-title">视频目录<span className="vd-hint">文稿、演示工程、音频、成片、封面的路径都相对它</span></div>
        <Input className="vd-mono" aria-label="视频目录" value={draft.root} placeholder="videos/ep04-kb" onChange={(e) => set({ root: e.target.value })} onBlur={flush} />
      </section>
      <section className="vd-sec">
        <div className="vd-sec-title">画面比例{locked && <span className="vd-hint">已锁定</span>}</div>
        <div className="vd-orients">
          {v.orientations.length ? v.orientations.map((o) => <OrientTag key={o} o={o} large />) : <span className="faint">还没定</span>}
        </div>
        <div className="vd-step-desc">{locked ? '比例定了不能改，要换比例得新开工程' : '在「制作流程」的规划检查里选，通过后锁定'}</div>
      </section>
      <section className="vd-sec vd-danger-zone">
        <div className="vd-sec-title">删除视频</div>
        <div className="vd-act-row">
          <span className="vd-muted">只删记录，本地文件不会被删</span>
          <Button variant="danger-ghost" onClick={() => setConfirmDel(true)}>删除视频</Button>
        </div>
        {del.isError && <div className="vd-err" role="alert">没删掉：{errorText(del.error)}</div>}
      </section>
      <ConfirmDialog open={confirmDel} danger title={`删除「${v.title || '未命名视频'}」？`} confirmLabel="删除" busy={del.isPending}
        impacts={['这一集的检查点和发布记录一起删掉', '视频目录里的文件不动']}
        onCancel={() => setConfirmDel(false)}
        onConfirm={() => { void del.mutateAsync(v.id).then(onDeleted, () => setConfirmDel(false)) }} />
    </div>
  )
}
