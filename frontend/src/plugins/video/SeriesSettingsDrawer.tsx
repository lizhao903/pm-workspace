// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 系列设置抽屉（SPEC-videos-5.5 到 5.10、6.11 到 6.15、6.19）：名称、说明、共用开场收尾模板。series 为 null 是新建。
// 改了共用部分且系列里有集时，保存前弹「影响范围」，默认全勾，勾上的集标为待同步、没勾的从待同步里去掉；
// 原型没有删除系列，正式版补在底部，删除后各集变回单集
import { useState } from 'react'
import { errorText, useCreateSeries, useDeleteSeries, usePatchSeries, type Video, type VideoSeries } from '../../core/data'
import { Button, Checkbox, ConfirmDialog, Drawer, Field, Input, Textarea, cls } from '../../core/ui'
import { SHARED, changedShared, cleanSeries, episodesOf, seriesDraftOf, staleAfter, type SeriesDraft } from './artifactModel'
import { videoState } from './model'

export function SeriesSettingsDrawer({ series, videos, onClose, onCreated, onDeleted }: {
  series: VideoSeries | null
  videos: Video[]
  onClose: () => void
  /** 新建成功，打开它的系列详情 */
  onCreated?: (s: VideoSeries) => void
  onDeleted?: () => void
}) {
  const creating = !series
  const create = useCreateSeries()
  const patch = usePatchSeries()
  const del = useDeleteSeries()
  const [d, setD] = useState<SeriesDraft>(() => seriesDraftOf(series))
  const [tried, setTried] = useState(false)
  // 影响范围确认：勾上的集
  const [confirm, setConfirm] = useState<string[] | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)

  const eps = series ? episodesOf(series, videos) : []
  const changed = series ? changedShared(series, d) : []
  const dirty = JSON.stringify(cleanSeries(d)) !== JSON.stringify(cleanSeries(seriesDraftOf(series)))
  const busy = create.isPending || patch.isPending || del.isPending
  const failed = create.error ?? patch.error ?? del.error
  const nameBad = tried && !d.name.trim()

  const save = () => {
    setTried(true)
    if (!d.name.trim() || busy) return
    create.reset()
    patch.reset()
    if (!series) {
      create.mutate(cleanSeries(d), { onSuccess: (s) => { onClose(); onCreated?.(s) } })
      return
    }
    if (changed.length && eps.length) {
      setConfirm(eps.map((v) => v.id))
      return
    }
    patch.mutate({ id: series.id, patch: cleanSeries(d) }, { onSuccess: onClose })
  }
  const confirmSave = () => {
    if (!series || !confirm || busy) return
    const stale = staleAfter(series.stale, eps.map((v) => v.id), confirm)
    patch.mutate({ id: series.id, patch: { ...cleanSeries(d), stale } }, { onSuccess: () => { setConfirm(null); onClose() }, onError: () => setConfirm(null) })
  }
  const onDelete = () => {
    if (!series || busy) return
    del.mutate(series.id, { onSuccess: () => { setConfirmDel(false); onClose(); onDeleted?.() }, onError: () => setConfirmDel(false) })
  }

  return (
    <Drawer open onClose={onClose} kicker={creating ? '新建系列' : '系列设置'} aria-label={creating ? '新建系列' : '系列设置'} className="vd-drawer"
      dirty={dirty} dirtyMessage="关闭后，这次改的系列设置不会保存。"
      footer={(requestClose) => (
        <>
          {!creating && <Button size="sm" variant="danger-ghost" disabled={busy} onClick={() => setConfirmDel(true)}>删除系列</Button>}
          <span className="spacer" />
          {nameBad && <span className="field-err">名称必填</span>}
          <Button onClick={requestClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={save}>{creating ? '创建' : '保存'}</Button>
        </>
      )}>
      <form className="vd-form" onSubmit={(e) => { e.preventDefault(); save() }}>
        {failed && <div className="vd-err" role="alert">{errorText(failed)}</div>}
        <Field label="名称" required error={nameBad ? '名称必填' : undefined}>
          <Input value={d.name} autoFocus={creating} invalid={nameBad} placeholder="比如：一人之下 10 分钟上手"
            onChange={(e) => setD({ ...d, name: e.target.value })} />
        </Field>
        <Field label="说明">
          <Textarea rows={2} value={d.desc} placeholder="这个系列讲什么、出哪几个比例、发哪些平台" onChange={(e) => setD({ ...d, desc: e.target.value })} />
        </Field>
        <section className="vd-sec-plain">
          <div className="vd-sec-title">共用部分
            <span className="vd-hint">{creating ? '各集录屏时套用' : `改了任一项，保存时会让你确认这 ${eps.length} 集里哪几集要重新录屏渲染`}</span>
          </div>
          {SHARED.map((f) => (
            <Field key={f.key} label={<>{f.label}{series && d[f.key].trim() !== series[f.key].trim() && <span className="vd-changed">已改</span>}</>}>
              <Input className="vd-mono" value={d[f.key]} placeholder={f.ph} onChange={(e) => setD({ ...d, [f.key]: e.target.value })} />
            </Field>
          ))}
        </section>
        {creating && <div className="vd-col-empty">建好后在系列详情里新建一集，或者把已有的视频加进来</div>}
        <button type="submit" hidden />
      </form>

      <ConfirmDialog open={!!confirm} title="影响范围" busy={busy}
        confirmLabel={confirm?.length ? `保存并标记 ${confirm.length} 集` : '只保存'} cancelLabel="返回修改"
        onCancel={() => setConfirm(null)} onConfirm={confirmSave}>
        {confirm && (
          <div className="vd-impact">
            <div>改了{changed.map((f) => f.label).join('、')}。下面这些集需要重新录屏渲染，勾上的会标为「待同步」。</div>
            <div className="vd-impact-list">
              {eps.map((v) => (
                <Checkbox key={v.id} className="vd-impact-row" checked={confirm.includes(v.id)}
                  onCheckedChange={(on) => setConfirm(on ? [...confirm, v.id] : confirm.filter((x) => x !== v.id))}>
                  <span className="vd-ep">{v.episode ?? '-'}</span>
                  <span className="ellipsis">{v.title || '未命名视频'}</span>
                  <span className={cls('vd-impact-state', videoState(v).tone === 'warn' && 'warn')}>{videoState(v).label}</span>
                </Checkbox>
              ))}
            </div>
            <button type="button" className="vd-link" onClick={() => setConfirm(confirm.length === eps.length ? [] : eps.map((v) => v.id))}>
              {confirm.length === eps.length ? '全不选' : '全选'}
            </button>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog open={confirmDel} danger title={`删除系列「${series?.name ?? ''}」？`} confirmLabel="删除" busy={busy}
        impacts={[eps.length ? `${eps.length} 集变回单集，集数和待同步标记清掉` : '系列里没有集', '视频和产出物都不动']}
        onCancel={() => setConfirmDel(false)} onConfirm={onDelete} />
    </Drawer>
  )
}
