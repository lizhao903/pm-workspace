// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 详情页「说话人」区（M5）：每个说话人一行——彩色圆点 + 显示名 + 联系人/相似度徽标 + 段落数/总时长，
// 行内改名、绑定/改绑联系人（Drawer，登记声纹、已有声纹提示覆盖）；识别中显示进度，失败显示原因并可重试。
// 说话人数据随详情一起轮询（数据层在 diarize 任务 pending/running 时保持 2 秒刷新），这里不单独取。
import { useState } from 'react'
import {
  errorText, useBindSpeaker, useContacts, useDeleteVoiceprint, useDiarize, useRenameSpeaker, useVoiceprints,
  type Recording, type RecordingSpeaker,
} from '../../core/data'
import { Button, ConfirmDialog, Drawer, Field, Input, SearchSelect, Tag } from '../../core/ui'
import { IconPencil } from './Rename'
import {
  clampPct, fmtDuration, jobText, speakerColor, speakerDisplayName, speakerSimilarityPct,
} from './model'

const MAX_NAME = 40

export function SpeakersSection({ r }: { r: Recording }) {
  const diarize = useDiarize()
  const [error, setError] = useState('')
  const [confirmRerun, setConfirmRerun] = useState(false)
  const speakers = Array.isArray(r.speakers) ? r.speakers : []
  const diarizeJob = r.job?.kind === 'diarize' ? r.job : null
  const running = !!diarizeJob && (diarizeJob.status === 'pending' || diarizeJob.status === 'running')
  const failed = diarizeJob?.status === 'failed'
  const canRun = r.has_audio && r.segments.length > 0

  const run = () => {
    setConfirmRerun(false)
    setError('')
    diarize.mutate(r.id, { onError: (e) => setError(`说话人识别没跑起来：${errorText(e)}`) })
  }

  return (
    <section className="rec-section">
      <div className="rec-section-title">
        <span>说话人</span>
        <span className="rec-faint">识别后可改名、绑定到联系人；绑定会把声纹登记到该联系人</span>
        <span className="rec-section-actions">
          <Button size="sm" variant={speakers.length ? 'outline' : 'primary'} disabled={!canRun || running || diarize.isPending}
            title={!canRun ? '需要先转写出段落才能识别说话人' : undefined}
            onClick={() => (speakers.length ? setConfirmRerun(true) : run())}>
            {diarize.isPending ? '提交中…' : running ? '识别中…' : speakers.length ? '重新识别' : '识别说话人'}
          </Button>
        </span>
      </div>

      {error && <div className="rec-err" role="alert">{error}</div>}

      {running && diarizeJob && (
        <div className="rec-job">
          <span className="rec-job-text">{jobText(diarizeJob)}</span>
          <span className="rec-progress" role="progressbar" aria-label="说话人识别进度" aria-valuenow={clampPct(diarizeJob.progress)}
            aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${clampPct(diarizeJob.progress)}%` }} />
          </span>
        </div>
      )}

      {failed && !running && (
        <div className="rec-err" role="alert">
          <b>说话人识别失败</b>{diarizeJob?.last_error ? `：${diarizeJob.last_error}` : ''}。不影响转写和纪要，可以点「重新识别」再试。
        </div>
      )}

      {speakers.length === 0 ? (
        <p className="rec-faint">
          {r.has_audio ? '还没有识别说话人。点「识别说话人」用本机 Python 跑一次。' : '这条录音没有音频文件，做不了说话人识别。'}
        </p>
      ) : (
        <ul className="rec-speakers" aria-label="说话人列表">
          {speakers.map((spk) => <SpeakerRow key={spk.label} r={r} spk={spk} />)}
        </ul>
      )}

      <p className="rec-section-hint">
        需要本机 Python 装好 funasr（首次识别会下载约 33MB 模型）；没装时识别会失败，转写和纪要不受影响。
      </p>

      <ConfirmDialog open={confirmRerun} title="重新识别说话人？" confirmLabel="重新识别" busy={diarize.isPending}
        onCancel={() => setConfirmRerun(false)} onConfirm={run}>
        会重新跑一遍本机 Python 说话人分离，按首次出现顺序重排 <code>spk_1</code>、<code>spk_2</code>；
        已经改过的名字和联系人绑定可能丢失（自动匹配会保留）。
      </ConfirmDialog>
    </section>
  )
}

function SpeakerRow({ r, spk }: { r: Recording; spk: RecordingSpeaker }) {
  const rename = useRenameSpeaker()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [bindOpen, setBindOpen] = useState(false)
  const name = speakerDisplayName(spk)
  const color = speakerColor(spk.label)

  const start = () => {
    setDraft(spk.name.trim() || name)
    setError('')
    setEditing(true)
  }

  const save = () => {
    const text = draft.trim()
    if (!text) { setError('名字不能为空'); return }
    if (text.length > MAX_NAME) { setError(`名字最多 ${MAX_NAME} 字`); return }
    if (text === name) { setEditing(false); return }
    setError('')
    rename.mutate({ id: r.id, label: spk.label, name: text }, {
      onSuccess: () => setEditing(false),
      onError: (e) => setError(`改名失败：${errorText(e)}`),
    })
  }

  return (
    <li className="rec-speaker">
      <div className="rec-speaker-head">
        <span className="rec-speaker-dot" style={{ background: color }} aria-hidden="true" />
        {editing ? (
          <span className="rec-speaker-edit">
            <Input className="rec-speaker-input" aria-label="说话人显示名" autoFocus maxLength={MAX_NAME + 10} value={draft}
              invalid={!!error}
              onChange={(e) => { setDraft(e.target.value); setError('') }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); save() } else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setError('') }
              }} />
            <Button size="sm" variant="primary" disabled={rename.isPending} onClick={save}>{rename.isPending ? '保存中…' : '保存'}</Button>
            <Button size="sm" onClick={() => { setEditing(false); setError('') }}>取消</Button>
          </span>
        ) : (
          <span className="rec-speaker-name">
            {name}
            <button type="button" className="rec-rename-btn" aria-label={`改名 ${name}`} title="改显示名" onClick={start}>
              <IconPencil />
            </button>
          </span>
        )}
        <span className="rec-speaker-tags">
          {spk.contact_id ? <Tag>{spk.contact_name || '联系人已删除'}</Tag> : <Tag>未绑定</Tag>}
          {spk.similarity > 0 ? (
            <Tag>{spk.detected ? '自动匹配' : '已绑定'} {speakerSimilarityPct(spk.similarity)}%</Tag>
          ) : null}
        </span>
        <span className="rec-speaker-meta">{spk.segments} 段 · {fmtDuration(spk.duration_ms)}</span>
        <span className="rec-speaker-actions">
          <Button size="sm" variant={spk.contact_id ? 'ghost' : 'outline'} onClick={() => setBindOpen(true)}>
            {spk.contact_id ? '改绑联系人' : '绑定联系人'}
          </Button>
        </span>
      </div>
      {error && <span className="rec-rename-err" role="alert">{error}</span>}
      {bindOpen && <BindDrawer r={r} spk={spk} onClose={() => setBindOpen(false)} />}
    </li>
  )
}

/** 绑定联系人抽屉：选联系人（按名字搜）→ 登记声纹；已有声纹时提示会覆盖并显示来源录音 */
function BindDrawer({ r, spk, onClose }: { r: Recording; spk: RecordingSpeaker; onClose: () => void }) {
  const contacts = useContacts()
  const voiceprints = useVoiceprints()
  const bind = useBindSpeaker()
  const removeVoiceprint = useDeleteVoiceprint()
  const [contactId, setContactId] = useState(spk.contact_id)
  const [error, setError] = useState('')
  const [confirmDeletePrint, setConfirmDeletePrint] = useState(false)
  const list = contacts.data ?? []
  const options = list.filter((c) => !c.archived_at).map((c) => ({
    value: c.id, label: c.name, hint: [c.company, c.title].filter(Boolean).join(' · '),
  }))
  const chosen = list.find((c) => c.id === contactId)
  const existing = (voiceprints.data ?? []).find((v) => v.contact_id === contactId)
  const switching = !!spk.contact_id && contactId !== spk.contact_id
  const bad = !contactId
  const busy = bind.isPending

  const submit = () => {
    if (bad || busy) return
    setError('')
    bind.mutate({ id: r.id, label: spk.label, contactId }, {
      onSuccess: onClose,
      onError: (e) => setError(`绑定失败：${errorText(e)}`),
    })
  }

  return (
    <Drawer open onClose={onClose} kicker="绑定说话人" aria-label={`绑定 ${speakerDisplayName(spk)}`} footer={
      <>
        <Button variant="primary" disabled={bad || busy} onClick={submit}>
          {busy ? '绑定中…' : existing ? '绑定并覆盖' : '绑定'}
        </Button>
        <Button onClick={onClose}>取消</Button>
      </>
    }>
      <div className="rec-bind">
        <p className="rec-bind-hint">
          把「{speakerDisplayName(spk)}」的声纹登记到联系人，以后录音会自动认出同一个人。
          同一条录音重复绑定不同联系人就是改绑。
        </p>
        <Field label="联系人" required hint="按名字搜；只有联系人能绑定声纹" error={bad ? '选一个联系人' : undefined}>
          <SearchSelect variant="field" aria-label="选择绑定联系人" value={contactId} placeholder="选联系人"
            searchPlaceholder="搜联系人名字" emptyText={contacts.isPending ? '正在加载联系人…' : '还没有联系人'}
            options={options} missingLabel={() => spk.contact_name || '联系人已删除'}
            onChange={(v) => { setContactId(v); setError('') }} />
        </Field>

        <div className="rec-bind-meta">
          <span>当前相似度：{spk.similarity > 0 ? `${speakerSimilarityPct(spk.similarity)}%（${spk.detected ? '自动匹配' : '已绑定'}）` : '未匹配'}</span>
          {chosen ? <span>联系人：{chosen.name}{chosen.company ? ` · ${chosen.company}` : ''}</span> : null}
        </div>

        {existing && (
          <div className="rec-bind-warn" role="alert">
            <b>这个联系人已有声纹</b>，绑定会被这次覆盖。
            {existing.source_recording_id ? <> 现在的声纹来自录音 <code>{existing.source_recording_id}</code>。</> : null}
            <div className="rec-bind-print-actions">
              <Button size="sm" variant="danger-ghost" disabled={removeVoiceprint.isPending}
                onClick={() => setConfirmDeletePrint(true)}>删除这个声纹</Button>
            </div>
          </div>
        )}
        {switching && !existing && (
          <div className="rec-bind-warn">
            这条说话人现在绑在「{spk.contact_name || '其他联系人'}」，绑定后会改到新联系人。
          </div>
        )}

        {error && <div className="rec-err" role="alert">{error}</div>}
      </div>

      <ConfirmDialog open={confirmDeletePrint} danger title="删除这个联系人的声纹？" confirmLabel="删除声纹"
        busy={removeVoiceprint.isPending} onCancel={() => setConfirmDeletePrint(false)}
        onConfirm={() => {
          setConfirmDeletePrint(false)
          removeVoiceprint.mutate(contactId, {
            onSuccess: () => setError(''),
            onError: (e) => setError(`删除声纹失败：${errorText(e)}`),
          })
        }}>
        删掉后，后续录音不会再自动认出这个人；已经标好的说话人不受影响。
      </ConfirmDialog>
    </Drawer>
  )
}
