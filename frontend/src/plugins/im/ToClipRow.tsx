// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 消息抽屉里的「收进素材箱」（VID-08b）：把这条消息收进视频插件的素材箱（kind im，带 message_id），做选题时回看。
// 不 import 视频插件，经 core/data 的素材接口写；video 插件没在跑时整节不显示。同一条消息后端只收一份。
import { errorText, useCreateClip, usePlugins, useVideoClips, type ImMessage } from '../../core/data'

const VIDEO_PLUGIN = 'video'

/** 素材正文最多 5000 字（契约「选题和素材箱」），按字截 */
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join('')

export function ToClipRow({ msg, source, who }: { msg: ImMessage; source: string; who: string }) {
  const plugins = usePlugins()
  if (!plugins.data?.find((p) => p.id === VIDEO_PLUGIN)?.running) return null
  return <ClipBody msg={msg} source={source} who={who} />
}

function ClipBody({ msg, source, who }: { msg: ImMessage; source: string; who: string }) {
  const clips = useVideoClips()
  const add = useCreateClip()
  const clip = clips.data?.find((c) => c.kind === 'im' && c.message_id === msg.id)
  const save = () => {
    const text = cut(msg.text.trim(), 5000)
    // message_id 是来源出处，后端认（契约 POST /api/video/clips），core/data 的 VideoClipInput 没列，这里单独带上
    const body = { kind: 'im' as const, title: text ? undefined : cut(`${who} 的消息`, 200), content: text, source: cut(source, 200), message_id: msg.id }
    add.mutate(body)
  }
  return (
    <>
      <div className="im-section">素材箱</div>
      {clip ? (
        <div className="im-act-row"><span className="im-muted">已收进素材箱{clip.topic_ids.length > 0 ? `，归到了 ${clip.topic_ids.length} 个选题` : ''}</span></div>
      ) : (
        <div className="im-act-row">
          <button type="button" className="im-act" disabled={add.isPending || clips.isLoading} onClick={save}>
            {add.isPending ? '收进中…' : '收进素材箱'}
          </button>
          <span className="im-muted">做视频选题时在素材箱里能看到</span>
        </div>
      )}
      {add.isError && <div className="im-err" role="alert">没收进去：{errorText(add.error)}</div>}
    </>
  )
}
