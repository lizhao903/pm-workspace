// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 登记 / 编辑一件产物。
//
// 表单最要紧的一条：本地路径和链接**可以同时填**，那是同一份交付物的两个位置。
// 界面上必须说出来，否则用户会先登记一条本地的、再登记一条云端的，
// 产物总数凭空翻倍，而两条记录看上去都没错。
import { useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import type { Artifact, ArtifactInput, WorkObject } from '../../lib/types'
import { Button, Field, Modal, Select, TextArea, TextInput } from '../ui'
import { detectPlatform, usePlatforms } from './platforms'

interface Props {
  open: boolean
  /** 有值 = 编辑，无值 = 新建 */
  editing?: Artifact | null
  /** 新建时预设归属对象（从某个对象的详情页点进来时） */
  presetObject?: WorkObject | null
  onClose: () => void
  onSaved: (a: Artifact) => void
}

export default function ArtifactDialog({ open, editing, presetObject, onClose, onSaved }: Props) {
  const platforms = usePlatforms()

  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [path, setPath] = useState('')
  const [platform, setPlatform] = useState('')
  const [note, setNote] = useState('')
  // 用户手动选过平台之后就不再自动改。不记这个标志的话，他选了「飞书」、
  // 接着去改一个字的链接，选择就被自动识别覆盖回去了——看上去像下拉框自己跳。
  const [platformTouched, setPlatformTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setTitle(editing?.title ?? '')
    setUrl(editing?.url ?? '')
    setPath(editing?.path ?? '')
    setPlatform(editing?.platform ?? '')
    setNote(editing?.note ?? '')
    setPlatformTouched(Boolean(editing?.platform))
    setError('')
  }, [open, editing])

  // 粘链接自动认平台。用户没手动选过才认。
  useEffect(() => {
    if (platformTouched || !url.trim()) return
    setPlatform(detectPlatform(url, platforms))
  }, [url, platforms, platformTouched])

  const canSave = useMemo(() => url.trim() !== '' || path.trim() !== '', [url, path])

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const body: ArtifactInput = {
        title: title.trim(),
        url: url.trim(),
        path: path.trim(),
        platform: platform.trim(),
        note: note.trim(),
      }
      let saved: Artifact
      if (editing) {
        saved = await api.updateArtifact(editing.id, body)
      } else {
        // 新建时才带归属：编辑走的是 PATCH，那里的 object_id 是三态，
        // 顺手传一个 undefined 会被 JSON.stringify 丢掉（正是我们要的「不改」），
        // 但把 presetObject 传进去会在用户编辑一条别处的产物时把它搬过来。
        if (presetObject) body.object_id = presetObject.id
        saved = await api.createArtifact(body)
      }
      onSaved(saved)
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title={editing ? '编辑产物' : '登记产物'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>取消</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !canSave}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="ar-form">
        {presetObject && !editing && (
          <div className="ar-form-scope faint">
            归属：{presetObject.ref} {presetObject.title}
          </div>
        )}

        <Field label="标题" hint="留空时用文件名或链接兜底">
          <TextInput value={title} onValueChange={setTitle} placeholder="例如：角色权限矩阵 v2" />
        </Field>

        <Field
          label="链接"
          hint="发到 Confluence / 飞书 / 云盘之后，把那个页面地址贴这里"
        >
          <TextInput value={url} onValueChange={setUrl} placeholder="https://…" />
        </Field>

        <Field
          label="本地路径"
          hint="绝对路径。和链接可以同时填——同一份东西既在本地也发出去了，登记成一条"
        >
          <TextInput value={path} onValueChange={setPath} placeholder="/Users/…/方案.md" />
        </Field>

        {!canSave && (
          <div className="faint ar-form-req">链接和本地路径至少要填一个，否则这条记录指不到任何东西。</div>
        )}

        <Field label="平台">
          <Select
            value={platform}
            onValueChange={(v) => { setPlatformTouched(true); setPlatform(v) }}
            options={[
              { value: '', label: '（按链接自动判断）' },
              ...platforms.map((p) => ({ value: p.key, label: p.label })),
            ]}
          />
        </Field>

        <Field label="备注">
          <TextArea value={note} onValueChange={setNote} rows={2} placeholder="例如：v2，已评审" />
        </Field>

        {error && <div className="form-error">{error}</div>}
      </div>
    </Modal>
  )
}
