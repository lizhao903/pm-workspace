// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 详情页「文件」区：录音目录里随转写/纪要生成的文件（transcript.md、minutes.md、minutes.json、diagrams/*.mmd），
// 点下载直接走 GET /files/{name}（白名单里的固定文件名）。没文件时说明什么时候会出现。
import {
  errorText, recordingFileUrl, useRecordingFiles,
} from '../../core/data'
import { ErrorState, LoadingState, Tag } from '../../core/ui'
import { fileKindText, fmtBytes, fmtCreatedAt } from './model'

export function FilesSection({ id, active, revision }: { id: string; active: boolean; revision: string }) {
  const files = useRecordingFiles(id, active, revision)
  return (
    <section className="rec-section">
      <div className="rec-section-title">
        文件
        <span className="rec-faint">随转写/纪要生成，点击下载</span>
      </div>
      {files.isPending ? <LoadingState text="正在读文件清单…" /> : files.isError ? (
        <ErrorState compact title="文件清单没读出来" error={errorText(files.error)} onRetry={() => void files.refetch()} />
      ) : files.data.length === 0 ? (
        <p className="rec-faint">
          还没有生成文件。转写成功后会出现 transcript.md；生成纪要后还会有 minutes.md、minutes.json 和图表源码。
        </p>
      ) : (
        <ul className="rec-files" aria-label="录音文件">
          {files.data.map((f) => (
            <li key={f.name} className="rec-file">
              <div className="rec-file-main">
                <b className="rec-file-name">{f.name}</b>
                <span className="rec-file-meta">
                  <Tag>{fileKindText(f.kind)}</Tag>
                  {f.name.includes('/') ? ' · 图表源码' : ''}
                </span>
              </div>
              <span className="rec-file-size">{fmtBytes(f.bytes)}</span>
              <span className="rec-file-time">{fmtCreatedAt(f.updated_at) || '—'}</span>
              <a className="rec-file-dl" href={recordingFileUrl(id, f.name)} download={f.name.split('/').pop()}>
                下载
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
