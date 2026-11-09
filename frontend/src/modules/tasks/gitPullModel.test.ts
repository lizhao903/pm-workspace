import { describe, expect, it } from 'vitest'
import { actionOf, actionText, draftErrors, emptyAction, emptyRule, gitPullError, isPluginAction } from './scheduleModel'

const now = new Date(2026, 9, 29, 8, 0)

describe('动作「拉取代码」', () => {
  it('是内核动作，提交体只带仓库、远端、分支，去首尾空白', () => {
    expect(isPluginAction('git_pull')).toBe(false)
    const a = { ...emptyAction('git_pull', 'P2'), repo: ' /code/app ', remote: ' origin ', branch: ' main ', title: '不该带' }
    expect(actionOf(a)).toEqual({ kind: 'git_pull', repo: '/code/app', remote: 'origin', branch: 'main' })
  })

  it('列表文字写成 git pull 命令', () => {
    expect(actionText({ kind: 'git_pull', repo: '/code/app', remote: '', branch: '' })).toBe('git pull /code/app')
    expect(actionText({ kind: 'git_pull', repo: '/code/app', remote: 'origin', branch: 'dev' })).toBe('git pull /code/app origin dev')
    expect(actionText({ kind: 'git_pull', repo: '', remote: '', branch: '' })).toBe('git pull 未填仓库')
  })

  it('前端先挡：仓库必填且是绝对路径，填了分支要填远端', () => {
    expect(gitPullError('', '', '')).toBe('填仓库路径')
    expect(gitPullError('code/app', '', '')).toBe('仓库路径要写绝对路径')
    expect(gitPullError('/code/app', '', 'dev')).toBe('填了分支也要填远端')
    expect(gitPullError('/code/app', 'origin', 'dev')).toBe('')
    expect(gitPullError('/code/app', '', '')).toBe('')
    const d = { name: '拉代码', enabled: true, rule: { ...emptyRule(now), freq: 'daily' as const, time: '09:00' }, action: emptyAction('git_pull', 'P2') }
    expect(draftErrors(d, now)).toEqual(['填仓库路径'])
  })
})
