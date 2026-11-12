// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置 > 插件 > 录音转写（M1 + M4a + M5）：本机 whisper.cpp / ffmpeg 状态、模型下载与删除、默认模型/语言/线程数、
// 模型目录、默认项目、音频保留策略、纪要（自动生成/SOP/置信度阈值）、声纹（自动识别/Python/模型目录/人数/匹配阈值）。
// 整页一次性 PUT 全量设置，校验错误原样显示后端的 400。音频和文本全程本机，联网点是下载模型和首次拉声纹模型。
import { useState } from 'react'
import {
  errorText, useDeleteModel, useDownloadModel, useProjects, useRecordingMeta, useRecordingSettings, useSaveSettings,
  type ModelInfo, type RecordingMeta, type RecordingSettings, type RecordingSettingsInput, type ToolInfo,
} from '../../core/data'
import { Button, ErrorState, Field, Input, LoadingState, Select, Switch, cls } from '../../core/ui'
import { LANGUAGE_OPTIONS, MODEL_OPTIONS, MODEL_STATUS_TEXT, RETENTION_OPTIONS, clampPct, fmtMB } from './model'
import './recording.css'

export default function RecordingSettingsPage() {
  const meta = useRecordingMeta()
  const settings = useRecordingSettings()
  if (meta.isPending || settings.isPending) return <LoadingState />
  if (meta.isError || settings.isError) {
    return (
      <ErrorState title="录音设置没加载出来" error={errorText(meta.error ?? settings.error)}
        onRetry={() => { void meta.refetch(); void settings.refetch() }} />
    )
  }
  return <Body meta={meta.data} settings={settings.data} />
}

/** 设置表单只发这几项（updated_at 由后端写） */
function settingsInput(s: RecordingSettings): RecordingSettingsInput {
  return {
    default_engine: s.default_engine,
    model: s.model,
    model_dir: s.model_dir,
    whisper_path: s.whisper_path,
    ffmpeg_path: s.ffmpeg_path,
    language: s.language,
    threads: s.threads,
    default_project_id: s.default_project_id,
    minutes_provider: s.minutes_provider,
    minutes_model: s.minutes_model,
    minutes_flow: s.minutes_flow,
    minutes_threshold: s.minutes_threshold,
    auto_diarize: s.auto_diarize,
    python_path: s.python_path,
    voiceprint_model_dir: s.voiceprint_model_dir,
    max_speakers: s.max_speakers,
    match_threshold: s.match_threshold,
    auto_summarize: s.auto_summarize,
    retention_mode: s.retention_mode,
  }
}

type Note = { ok: boolean; text: string }

function Body({ meta, settings }: { meta: RecordingMeta; settings: RecordingSettings }) {
  const save = useSaveSettings()
  const download = useDownloadModel()
  const removeModel = useDeleteModel()
  const projects = useProjects()
  const [draft, setDraft] = useState<RecordingSettingsInput>(() => settingsInput(settings))
  const [threadsText, setThreadsText] = useState(() => String(settings.threads))
  const [thresholdText, setThresholdText] = useState(() => String(settings.minutes_threshold))
  const [maxSpeakersText, setMaxSpeakersText] = useState(() => String(settings.max_speakers))
  const [matchText, setMatchText] = useState(() => String(settings.match_threshold))
  const [note, setNote] = useState<Note | null>(null)

  const set = (p: Partial<RecordingSettingsInput>) => { setDraft((d) => ({ ...d, ...p })); setNote(null) }
  const threads = Number(threadsText)
  const threadsBad = !/^\d+$/.test(threadsText.trim()) || !Number.isInteger(threads) || threads < 0 || threads > 64
  const threshold = Number(thresholdText)
  const thresholdBad = !/^\d+(\.\d+)?$/.test(thresholdText.trim()) || !Number.isFinite(threshold) || threshold < 0 || threshold > 1
  const maxSpeakers = Number(maxSpeakersText)
  const maxSpeakersBad = !/^\d+$/.test(maxSpeakersText.trim()) || !Number.isInteger(maxSpeakers) || maxSpeakers < 1 || maxSpeakers > 16
  const match = Number(matchText)
  const matchBad = !/^\d+(\.\d+)?$/.test(matchText.trim()) || !Number.isFinite(match) || match < 0 || match > 1
  const current: RecordingSettingsInput = {
    ...draft,
    threads: threadsBad ? draft.threads : threads,
    minutes_threshold: thresholdBad ? draft.minutes_threshold : threshold,
    max_speakers: maxSpeakersBad ? draft.max_speakers : maxSpeakers,
    match_threshold: matchBad ? draft.match_threshold : match,
  }
  const dirty = JSON.stringify(current) !== JSON.stringify(settingsInput(settings))
  const busy = save.isPending

  const submit = () => {
    if (busy || threadsBad || thresholdBad || maxSpeakersBad || matchBad) return
    save.mutate(current, {
      onSuccess: (s) => {
        setDraft(settingsInput(s)); setThreadsText(String(s.threads)); setThresholdText(String(s.minutes_threshold))
        setMaxSpeakersText(String(s.max_speakers)); setMatchText(String(s.match_threshold))
        setNote({ ok: true, text: '已保存' })
      },
      onError: (e) => setNote({ ok: false, text: `没保存：${errorText(e)}` }),
    })
  }

  const tool = (label: string, t: ToolInfo) => (
    <div className={cls('rec-tool', !t.ok && 'bad')}>
      <span className="rec-tool-name">{label}</span>
      <span className={cls('rec-tool-state', t.ok ? 'ok' : 'bad')}>{t.ok ? `可用${t.version ? ` · ${t.version}` : ''}` : '不可用'}</span>
      <span className="rec-tool-path">{t.path || '没找到'}</span>
      {!t.ok && t.error ? <span className="rec-tool-err">{t.error}</span> : null}
    </div>
  )

  const onDownload = (m: ModelInfo) => {
    setNote(null)
    download.mutate(m.name, { onError: (e) => setNote({ ok: false, text: `下载没开始：${errorText(e)}` }) })
  }
  const onDeleteModel = (m: ModelInfo) => {
    setNote(null)
    removeModel.mutate(m.name, { onError: (e) => setNote({ ok: false, text: `删除模型失败：${errorText(e)}` }) })
  }

  const projectOptions = [{ value: '', label: '不指定' }]
  for (const o of projects.data?.data ?? []) projectOptions.push({ value: o.id, label: o.title })
  if (draft.default_project_id && !projectOptions.some((o) => o.value === draft.default_project_id)) {
    projectOptions.push({ value: draft.default_project_id, label: '（项目已删除）' })
  }

  const toolsBad = !meta.tools.whisper.ok || !meta.tools.ffmpeg.ok

  return (
    <div className="rec-settings" aria-label="录音转写设置">
      <div className="rec-sec-title">工具状态</div>
      <div className="rec-tools">
        {tool('whisper-cli', meta.tools.whisper)}
        {tool('ffmpeg', meta.tools.ffmpeg)}
      </div>
      {toolsBad && (
        <div className="rec-tools-hint" role="alert">
          缺工具时录音能保存，但转写跑不了。在终端执行 <code>brew install whisper.cpp ffmpeg</code> 装好，
          或者把可执行文件的绝对路径填在下面（GUI 启动的进程 PATH 可能找不到 Homebrew）。
        </div>
      )}
      <div className="rec-form-row">
        <Field label="whisper-cli 路径" hint="空 = 自动探测（PATH 和 Homebrew 常见路径）">
          <Input value={draft.whisper_path} placeholder={meta.tools.whisper.path || '自动探测'}
            onChange={(e) => set({ whisper_path: e.target.value })} />
        </Field>
        <Field label="ffmpeg 路径" hint="空 = 自动探测">
          <Input value={draft.ffmpeg_path} placeholder={meta.tools.ffmpeg.path || '自动探测'}
            onChange={(e) => set({ ffmpeg_path: e.target.value })} />
        </Field>
      </div>

      <div className="rec-sec-title">模型</div>
      <p className="rec-sec-desc">
        模型文件放本机，不入备份。可以在这下载，也可以把 <code>ggml-&lt;模型&gt;.bin</code> 手动放进模型目录后刷新。
      </p>
      <ul className="rec-models" aria-label="模型列表">
        {meta.models.map((m) => (
          <li key={m.name} className="rec-model">
            <span className="rec-model-name">{m.name}</span>
            <span className="rec-model-size">{fmtMB(m.size)}</span>
            <span className={cls('rec-model-state', m.status === 'ready' && 'ok', m.status === 'error' && 'bad')}>
              {MODEL_STATUS_TEXT[m.status] ?? m.status}
            </span>
            {m.status === 'downloading' ? (
              <span className="rec-progress" role="progressbar" aria-label={`${m.name} 下载进度`} aria-valuenow={clampPct(m.progress)}
                aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${clampPct(m.progress)}%` }} />
              </span>
            ) : <span className="rec-model-gap" aria-hidden="true" />}
            {m.status === 'ready'
              ? <Button size="sm" disabled={removeModel.isPending} onClick={() => onDeleteModel(m)}>删除</Button>
              : m.status === 'downloading'
                ? <Button size="sm" disabled>下载中</Button>
                : <Button size="sm" variant="outline" disabled={download.isPending} onClick={() => onDownload(m)}>下载</Button>}
            {m.status === 'error' && m.error ? <span className="rec-model-err">{m.error}</span> : null}
          </li>
        ))}
      </ul>
      <Field label="模型目录" hint={`空 = 默认：${meta.model_dir}`}>
        <Input value={draft.model_dir} placeholder={meta.model_dir} onChange={(e) => set({ model_dir: e.target.value })} />
      </Field>

      <div className="rec-sec-title">转写默认值</div>
      <div className="rec-form-row">
        <Field label="默认模型" hint="先用 small 跑通；想更准可换 medium 或 large-v3-turbo">
          <Select aria-label="默认模型" options={MODEL_OPTIONS} value={draft.model} onValueChange={(v) => set({ model: v })} />
        </Field>
        <Field label="语言" hint="auto 让 whisper 自行识别；粤语选 yue">
          <Select aria-label="语言" options={LANGUAGE_OPTIONS} value={draft.language} onValueChange={(v) => set({ language: v })} />
        </Field>
        <Field label="线程数" hint="0 = 自动（min(8, CPU 核数)）" error={threadsBad ? '填 0 到 64 的整数' : undefined}>
          <Input type="number" inputMode="numeric" min={0} max={64} step={1} aria-label="线程数" value={threadsText} invalid={threadsBad}
            onChange={(e) => { setThreadsText(e.target.value); setNote(null) }} />
        </Field>
      </div>

      <div className="rec-sec-title">纪要</div>
      <p className="rec-sec-desc">
        转写完成后可自动让本机 Agent 读全文，生成摘要、结论、待办建议和流程图/树形图。SOP 流程为空时插件内直连 Agent。
      </p>
      <Switch checked={draft.auto_summarize} onCheckedChange={(v) => set({ auto_summarize: v })}>
        转写完成后自动生成纪要
      </Switch>
      <Field label="纪要 SOP 流程" hint="填 SOP 流程 id 或名称；留空 = 插件内直连 Agent（不经过 SOP 编排）">
        <Input value={draft.minutes_flow} placeholder="留空 = 插件内直连 Agent"
          onChange={(e) => set({ minutes_flow: e.target.value })} />
      </Field>
      <div className="rec-form-row">
        <Field label="纪要服务商" hint="留空 = 默认服务商（本机 Ollama）">
          <Input value={draft.minutes_provider} placeholder="留空 = 默认服务商"
            onChange={(e) => set({ minutes_provider: e.target.value })} />
        </Field>
        <Field label="纪要模型" hint="留空 = 服务商默认模型；长会议建议 4B 以上（如 qwen3.5:4b）">
          <Input value={draft.minutes_model} placeholder="留空 = 服务商默认模型"
            onChange={(e) => set({ minutes_model: e.target.value })} />
        </Field>
      </div>
      <Field label="高置信度阈值" hint="置信度 ≥ 阈值的候选会推送提醒，低于阈值的进详情页「需要你补充」"
        error={thresholdBad ? '填 0 到 1 之间的小数（如 0.7）' : undefined}>
        <div className="rec-threshold">
          <input type="range" min={0} max={1} step={0.05} aria-label="置信度阈值滑杆"
            value={thresholdBad ? draft.minutes_threshold : threshold}
            onChange={(e) => { setThresholdText(e.target.value); setNote(null) }} />
          <Input type="number" className="rec-threshold-num" inputMode="decimal" min={0} max={1} step={0.05}
            aria-label="置信度阈值" value={thresholdText} invalid={thresholdBad}
            onChange={(e) => { setThresholdText(e.target.value); setNote(null) }} />
        </div>
      </Field>

      <div className="rec-sec-title">声纹</div>
      <p className="rec-sec-desc">
        转写后可用本机 Python 离线做说话人分离（VAD + CAM++），给段落标 spk_1、spk_2；绑定联系人后，后续录音自动认人。
        需要 <code>pip install funasr</code>，首次识别会联网下载约 33MB 模型，之后离线。识别失败不影响转写和纪要。
      </p>
      <Switch checked={draft.auto_diarize} onCheckedChange={(v) => set({ auto_diarize: v })}>
        转写完成后自动识别说话人
      </Switch>
      <div className="rec-form-row">
        <Field label="Python 路径" hint="空 = 自动找 python3（conda 环境填绝对路径）">
          <Input value={draft.python_path} placeholder="自动找 python3"
            onChange={(e) => set({ python_path: e.target.value })} />
        </Field>
        <Field label="声纹模型目录" hint="空 = ModelScope 默认缓存；也可手动放模型后指定目录">
          <Input value={draft.voiceprint_model_dir} placeholder="默认缓存"
            onChange={(e) => set({ voiceprint_model_dir: e.target.value })} />
        </Field>
        <Field label="最多人数" hint="1–16，超过上限会合并最近质心" error={maxSpeakersBad ? '填 1 到 16 的整数' : undefined}>
          <Input type="number" inputMode="numeric" min={1} max={16} step={1} aria-label="最多人数"
            value={maxSpeakersText} invalid={maxSpeakersBad}
            onChange={(e) => { setMaxSpeakersText(e.target.value); setNote(null) }} />
        </Field>
      </div>
      <Field label="声纹匹配阈值" hint="余弦相似度 ≥ 阈值算同一个人；0 = 全部当同一个人"
        error={matchBad ? '填 0 到 1 之间的小数（如 0.65）' : undefined}>
        <div className="rec-threshold">
          <input type="range" min={0} max={1} step={0.05} aria-label="声纹匹配阈值滑杆"
            value={matchBad ? draft.match_threshold : match}
            onChange={(e) => { setMatchText(e.target.value); setNote(null) }} />
          <Input type="number" className="rec-threshold-num" inputMode="decimal" min={0} max={1} step={0.05}
            aria-label="声纹匹配阈值" value={matchText} invalid={matchBad}
            onChange={(e) => { setMatchText(e.target.value); setNote(null) }} />
        </div>
      </Field>

      <div className="rec-sec-title">其他</div>
      <div className="rec-form-row">
        <Field label="默认项目" hint="录音默认关联的项目，可空">
          <Select aria-label="默认项目" options={projectOptions} value={draft.default_project_id}
            onValueChange={(v) => set({ default_project_id: v })} />
        </Field>
        <Field label="音频保留" hint="删除音频只删原始文件，转写文本保留（M3 才按此清理）">
          <Select aria-label="音频保留" options={RETENTION_OPTIONS} value={draft.retention_mode}
            onValueChange={(v) => set({ retention_mode: v as RecordingSettingsInput['retention_mode'] })} />
        </Field>
      </div>

      <p className="rec-settings-foot">
        引擎：本地 whisper.cpp（{draft.default_engine || 'whisper_local'}）。本地转写，音频和文本不出本机，唯一联网点是下载模型。
      </p>
      <div className="rec-settings-actions">
        <Button variant="primary" disabled={!dirty || busy || threadsBad || thresholdBad || maxSpeakersBad || matchBad}
          onClick={submit}>{busy ? '保存中…' : '保存'}</Button>
        {note && <span className={cls('rec-note', note.ok ? 'ok' : 'bad')} role={note.ok ? 'status' : 'alert'}>{note.text}</span>}
      </div>
    </div>
  )
}
