// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { Video, VideoArtifact } from '../../core/data'
import {
  coverRatioOf, coverRatios, defaultPath, dupEpisodes, freeOption, newDraft, parseDuration, patchDraft, previewUrl, sourceLink, staleAfter,
} from './artifactModel'

const T = '2026-10-29T08:00:00Z'
const v: Video = {
  id: 'vd_1', title: '第 1 集', orientations: ['landscape', 'portrait'], stage: 'distribution', checkpoints: [], root: 'videos/ep01-intro', chapters: 3,
  created_at: T, updated_at: T,
}
const art = (x: Partial<VideoArtifact>): VideoArtifact => ({
  id: 'a', video_id: 'vd_1', kind: 'cover', name: '', path: 'p', version: 1, status: 'draft', source: { type: 'manual', label: '手动登记' }, reviews: [],
  created_at: T, updated_at: T, ...x,
})

describe('产出物的纯函数', () => {
  it('默认路径照 SPEC-videos-11.9', () => {
    expect(defaultPath('presentation', v, 'portrait')).toBe('presentation-portrait')
    expect(defaultPath('audio', v)).toBe('audio/')
    expect(defaultPath('video', v, 'portrait')).toBe('out/ep01-intro-9x16.mp4')
    expect(defaultPath('subtitle', v, 'landscape')).toBe('subtitle/ep01-intro-16x9.srt')
    expect(defaultPath('cover', v, 'portrait', 2, '3x4')).toBe('cover/3x4-2.png')
    expect(defaultPath('script', v, 'portrait')).toBe('script-portrait.md')
    expect(defaultPath('article', v)).toBe('article.md')
  })

  it('封面比例：没记的按方向默认；分组是默认的加上登记过的', () => {
    expect(coverRatioOf({ variant: 'portrait' })).toBe('9x16')
    expect(coverRatioOf({ variant: 'portrait', ratio: '3x4' })).toBe('3x4')
    expect(coverRatios('landscape', [art({ variant: 'landscape', ratio: '1x1' })])).toEqual(['16x9', '4x3', '1x1'])
  })

  it('版本找同组第一个空位，满了给 5', () => {
    const xs = [1, 2, 4].map((o) => art({ id: `c${o}`, variant: 'portrait', ratio: '3x4', option: o }))
    expect(freeOption(xs, 'portrait', '3x4')).toBe(3)
    expect(freeOption(xs, 'portrait', '9x16')).toBe(1)
    const full = [1, 2, 3, 4, 5].map((o) => art({ id: `f${o}`, variant: 'landscape', option: o }))
    expect(freeOption(full, 'landscape')).toBe(5)
  })

  it('时长认 mm:ss 和秒数，不对的不存', () => {
    expect(parseDuration('10:02')).toBe(602)
    expect(parseDuration(' 95 ')).toBe(95)
    expect(parseDuration('1:75')).toBeUndefined()
    expect(parseDuration('abc')).toBeUndefined()
  })

  it('登记草稿：改方向时封面比例回到默认、版本跳空位；手动改过路径不覆盖', () => {
    const xs = [art({ variant: 'portrait', ratio: '3x4', option: 1 })]
    let d = newDraft(v, xs, 'cover', 'portrait', undefined, '3x4')
    expect(d).toMatchObject({ ratio: '3x4', option: 2, name: '封面 2', path: 'cover/3x4-2.png' })
    d = patchDraft(d, { variant: 'landscape' }, v, xs)
    expect(d).toMatchObject({ variant: 'landscape', ratio: '16x9', option: 1, path: 'cover/16x9-1.png' })
    d = patchDraft({ ...d, path: 'my/cover.png', touched: true }, { ratio: '4x3' }, v, xs)
    expect(d).toMatchObject({ ratio: '4x3', path: 'my/cover.png', name: '封面 1' })
    d = patchDraft(d, { kind: 'audio' }, v, xs)
    expect(d).toMatchObject({ kind: 'audio', variant: undefined, ratio: undefined, option: undefined, name: '音频' })
  })

  it('预览地址带视频目录，来源跳转按类型', () => {
    expect(previewUrl(v, art({ kind: 'video', path: 'out/a b.mp4' }))).toBe('http://127.0.0.1:7801/videos/ep01-intro/out/a%20b.mp4')
    expect(sourceLink({ type: 'agent', label: 'x', run_id: 'ar_1' })?.to).toBe('/conversations/runs?run=ar_1')
    expect(sourceLink({ type: 'agent', label: 'x', session_id: 'se_1' })?.to).toBe('/conversations?s=se_1')
    expect(sourceLink({ type: 'sop', label: 'x', run_id: 'run_1' })?.to).toBe('/sop/runs/run_1')
    expect(sourceLink({ type: 'manual', label: '手动登记' })).toBeNull()
    expect(sourceLink({ type: 'skill', label: 'web-video-presentation' })).toBeNull()
  })

  it('影响范围：勾上的加进待同步，没勾的去掉', () => {
    expect(staleAfter(['e2', 'e3'], ['e1', 'e2', 'e3'], ['e1', 'e3'])).toEqual(['e1', 'e3'])
    expect(staleAfter(['e2'], ['e1', 'e2'], [])).toEqual([])
  })

  it('编排时找重复集数', () => {
    expect([...dupEpisodes([{ ...v, episode: 1 }, { ...v, episode: 2 }, { ...v, episode: 1 }, { ...v }])]).toEqual([1])
  })
})
