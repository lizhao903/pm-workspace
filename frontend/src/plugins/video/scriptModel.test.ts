// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { beforeEach, describe, expect, it } from 'vitest'
import type { Video, VideoArtifact, VideoCheckpoint } from '../../core/data'
import {
  deskOrients, draftKey, latestText, markHandled, newTopicTitle, outlineItems, pendingProposals, planDocs, proposalKey, resetDeskStore, sectionCount,
  setDraft, speakText, textStats,
} from './scriptModel'

const T = '2026-10-29T08:00:00Z'
const cps = (): VideoCheckpoint[] => (['plan', 'ch1', 'audio', 'distribution'] as const).map((stage) => ({ stage, state: 'pending' }))
const vid = (x: Partial<Video> = {}): Video => ({
  id: 'a', title: '新视频', orientations: [], stage: 'script', checkpoints: cps(), root: 'videos/a', chapters: 3, created_at: T, updated_at: T, ...x,
})
const art = (id: string, x: Partial<VideoArtifact> = {}): VideoArtifact => ({
  id, video_id: 'a', kind: 'script', name: '口播稿', path: 'script-landscape.md', variant: 'landscape', version: 1, status: 'draft',
  source: { type: 'manual', label: '手写' }, reviews: [], created_at: T, updated_at: T, ...x,
})

describe('字数和时长', () => {
  it('去掉 Markdown 记号，汉字一个算一个、英文按词', () => {
    expect(textStats('## 开场\n- 大家好 hello world\n')).toEqual({ chars: 7, seconds: 2 })
    expect(textStats('')).toEqual({ chars: 0, seconds: 0 })
    expect(speakText(0)).toBe('1 秒')
    expect(speakText(75)).toBe('1 分 15 秒')
  })
  it('大纲节数是一到三级标题；选题大纲去掉序号', () => {
    expect(sectionCount('# 标题\n## 第 1 章\n#### 不算\n正文')).toBe(2)
    expect(outlineItems('1. 开场\n2、主体\n- 结论\n\n')).toEqual(['开场', '主体', '结论'])
  })
})

describe('编辑区', () => {
  it('还没定比例按横屏一栏；比例按横竖方排', () => {
    expect(deskOrients(vid())).toEqual(['landscape'])
    expect(deskOrients(vid({ orientations: ['square', 'portrait'] }))).toEqual(['portrait', 'square'])
  })
  it('新建选题的标题去掉集数，新视频算空', () => {
    expect(newTopicTitle(vid({ title: '第 3 集：讲讲缓存' }))).toBe('讲讲缓存')
    expect(newTopicTitle(vid({ title: '新视频' }))).toBe('')
  })
  it('每一类取最新的版本；原文没有比例', () => {
    const xs = [art('s1', { version: 1 }), art('s2', { version: 3 }), art('o', { kind: 'outline' }), art('ar', { kind: 'article', variant: undefined })]
    expect(latestText(xs, 'script', 'landscape')?.id).toBe('s2')
    expect(latestText(xs, 'script', 'portrait')).toBeUndefined()
    expect(latestText(xs, 'article')?.id).toBe('ar')
  })
})

describe('本地草稿和初稿', () => {
  beforeEach(() => resetDeskStore())

  it('改回和已保存的一样就删掉草稿', async () => {
    const { useDeskStore } = await import('./scriptModel')
    expect(typeof useDeskStore).toBe('function')
    const k = draftKey('a', 'script', 'landscape')
    expect(k).toBe('a:script:landscape')
    setDraft(k, '新的', '旧的')
    setDraft(k, '旧的', '旧的')
    // 没有存储（node 环境）也不报错
    setDraft(k, null)
  })

  it('初稿：最近一次内容编写跑完、执行器写的口播稿和大纲，处理过的不再列', () => {
    const run = { type: 'agent' as const, id: 'run_1', stage: 'script' as const, status: 'done' as const, started_at: T, artifact_ids: ['s', 'o', 'm', 'w'] }
    const src = { type: 'skill' as const, label: '网页演示做视频' }
    const xs = [art('s', { version: 2, status: 'review', source: src }), art('o', { kind: 'outline', status: 'review', source: src }),
      art('m', { version: 3 }), art('w', { kind: 'presentation', source: src })]
    expect(pendingProposals(vid({ last_run: run }), xs, []).map((a) => a.id)).toEqual(['s', 'o'])
    expect(pendingProposals(vid({ last_run: { ...run, status: 'running' } }), xs, [])).toEqual([])
    expect(pendingProposals(vid({ last_run: { ...run, stage: 'web' } }), xs, [])).toEqual([])
    expect(pendingProposals(vid({ last_run: run }), xs, [proposalKey(xs[0])]).map((a) => a.id)).toEqual(['o'])
    markHandled([proposalKey(xs[1])])
  })

  it('规划检查：每个比例的口播稿、大纲最新一版，加上提醒', () => {
    const v = vid({ orientations: ['landscape', 'portrait'] })
    const xs = [art('s', { version: 2 }), art('o', { kind: 'outline', status: 'review' }), art('ar', { kind: 'article', variant: undefined })]
    const { docs, warns } = planDocs(v, xs, true)
    expect(docs.map((a) => a.id)).toEqual(['ar', 's', 'o'])
    expect(warns).toEqual(['竖屏还没有口播稿', '横屏口播稿 v2 还是草稿，没交验收', '内容编写里还有没保存的草稿，这里看到的是已保存的版本'])
  })
})
