import { describe, expect, it } from 'vitest'
import { PROFILE_COMMANDS, PROFILE_COMMAND_GROUPS, type ProjectProfile } from '../../core/data'
import { commandsOf, formOfProfile, platformsOf, profileDiff, profileGaps, readyError, splitTags, timeoutError, timeoutOf } from './profileModel'

const base: ProjectProfile = {
  project_id: 'obj_p', intro: '', keywords: [], platforms: [], code_dir: '', proto_dir: '', prd_dir: '',
  commands: {}, owner_ids: [], acceptor_ids: [], root: '/src/p', created_at: null, updated_at: null,
}

describe('档案表单', () => {
  it('关键词按中英文逗号、顿号、换行拆，去空去重（不分大小写）', () => {
    expect(splitTags(' 工作台，需求、 PRD,prd\n\n原型 ')).toEqual(['工作台', '需求', 'PRD', '原型'])
    expect(splitTags('')).toEqual([])
  })

  it('平台：常用项点选，其余放进「其他」；合起来去重', () => {
    const f = formOfProfile({ ...base, platforms: ['web', '鸿蒙', '桌面'] })
    expect(f.platforms).toEqual(['web', '桌面'])
    expect(f.otherPlatforms).toEqual('鸿蒙')
    expect(platformsOf({ ...f, otherPlatforms: '鸿蒙，WEB' })).toEqual(['web', '桌面', '鸿蒙'])
  })

  it('超时：空是默认值，非整数、超过一天报错', () => {
    expect(timeoutOf('')).toBe(0)
    expect(timeoutOf(' 600 ')).toBe(600)
    expect(timeoutOf('1.5')).toBe(0)
    expect(timeoutError('')).toBe('')
    expect(timeoutError('abc')).toBe('超时填整数秒')
    expect(timeoutError('90000')).toMatch('一天')
  })

  it('命令：空命令不发，其余去首尾空白', () => {
    const f = formOfProfile({ ...base, commands: { build: { command: 'make', dir: 'web', timeout_sec: 60 } } })
    expect(f.commands.build).toEqual({ command: 'make', dir: 'web', timeout: '60', ready: '' })
    expect(f.commands.test).toEqual({ command: '', dir: '', timeout: '', ready: '' })
    f.commands.test = { command: ' go test ./... ', dir: ' ', timeout: '', ready: '' }
    expect(commandsOf(f)).toEqual({ build: { command: 'make', dir: 'web', timeout_sec: 60 }, test: { command: 'go test ./...', dir: '', timeout_sec: 0 } })
  })

  it('改动：目录单独列出，其余合成一次；没改的不发；超时有毛病时命令先不存', () => {
    const saved = formOfProfile(base)
    expect(profileDiff(saved, saved)).toEqual({ patch: {}, dirs: {} })
    const f = { ...saved, intro: ' 简介 ', keywords: 'a，b', code_dir: ' /x ', owner_ids: ['sh_1'] }
    expect(profileDiff(f, saved)).toEqual({ patch: { intro: '简介', keywords: ['a', 'b'], owner_ids: ['sh_1'] }, dirs: { code_dir: '/x' } })
    // 只改了关键词的写法（加了空格），拆出来一样就不发
    expect(profileDiff({ ...saved, keywords: 'a， b' }, { ...saved, keywords: 'a，b' }).patch).toEqual({})
    const bad = { ...saved, commands: { ...saved.commands, build: { command: 'make', dir: '', timeout: 'x', ready: '' } } }
    expect(profileDiff(bad, saved).patch).toEqual({})
    const ok = { ...saved, commands: { ...saved.commands, build: { command: 'make', dir: '', timeout: '', ready: '' } } }
    expect(profileDiff(ok, saved).patch).toEqual({ commands: { build: { command: 'make', dir: '', timeout_sec: 0 } } })
  })

  it('就绪检查：只有起测试环境发，空的不发；要 / 开头或本机地址，有毛病时命令先不存', () => {
    const f = formOfProfile({ ...base, commands: { test_env: { command: 'npm run dev', dir: '', timeout_sec: 0, ready: '/health' } } })
    expect(f.commands.test_env.ready).toBe('/health')
    expect(commandsOf(f)).toEqual({ test_env: { command: 'npm run dev', dir: '', timeout_sec: 0, ready: '/health' } })
    f.commands.test_env.ready = ' '
    expect(commandsOf(f)).toEqual({ test_env: { command: 'npm run dev', dir: '', timeout_sec: 0 } })
    expect(readyError('')).toBe('')
    expect(readyError('/healthz')).toBe('')
    expect(readyError('http://127.0.0.1:{{PORT}}/api/health')).toBe('')
    expect(readyError('http://localhost:3000')).toBe('')
    expect(readyError('https://example.com/health')).toMatch('本机')
    expect(readyError('health')).toMatch('/ 开头')
    expect(readyError('/a b')).toMatch('空格')
    const saved = formOfProfile(base)
    const bad = { ...saved, commands: { ...saved.commands, test_env: { command: 'x', dir: '', timeout: '', ready: 'nope' } } }
    expect(profileDiff(bad, saved).patch).toEqual({})
  })

  it('命令分两组（AUTO-10）：测试环境四条、发布六条；旧数据的 smoke 仍是测试环境冒烟，发布那组的命令照常来回', () => {
    expect(PROFILE_COMMAND_GROUPS.map((g) => g.key)).toEqual(['test', 'release'])
    expect(PROFILE_COMMANDS.filter((c) => c.group === 'test').map((c) => c.key)).toEqual(['build', 'test', 'test_env', 'smoke'])
    expect(PROFILE_COMMANDS.filter((c) => c.group === 'release').map((c) => c.key)).toEqual(['version', 'package', 'preflight', 'release', 'prod_smoke', 'rollback'])
    expect(PROFILE_COMMANDS.find((c) => c.key === 'smoke')?.label).toBe('冒烟（测试环境）')
    for (const k of ['preflight', 'release', 'prod_smoke', 'rollback'] as const) {
      expect(PROFILE_COMMANDS.find((c) => c.key === k)?.hint).toMatch('上线审批后才跑')
    }
    const cmds = {
      smoke: { command: 'curl :$PORT', dir: '', timeout_sec: 0 },
      version: { command: 'make version', dir: '', timeout_sec: 0 },
      prod_smoke: { command: 'curl https://x', dir: 'ops', timeout_sec: 60 },
    }
    expect(commandsOf(formOfProfile({ ...base, commands: cmds }))).toEqual(cmds)
  })

  it('档案缺什么：代码库没设但有项目目录不算缺', () => {
    expect(profileGaps(base)).toEqual(['简介', '关键词', '原型库目录', 'PRD 目录'])
    expect(profileGaps({ ...base, root: '' })).toContain('代码库目录')
  })
})
