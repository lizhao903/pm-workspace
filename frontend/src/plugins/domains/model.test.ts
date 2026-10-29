import { describe, expect, it } from 'vitest'
import type { DomainRoute, DomainSettings, TerminalPrototype } from '../../core/data'
import {
  aliasError, awaitingAuto, conflicts, groupAuto, hostError, matchRoute, parseAliases, protoAccess, protoDown, targetLabel, timeAgo, validHost,
  validIPv4, validSuffix, visibleRoutes,
} from './model'

const S: DomainSettings = {
  enabled: true, suffix: 'bro.vip', resolve: 'hosts', proxy: 'builtin', https: true, ca_installed: false, lan: false, lan_ip: '',
  auto_proto: true, aliases: ['broleez.vip'], http_port: 7777, https_port: 7443, updated_at: '',
}

const route = (x: Partial<DomainRoute> & { id: string; host: string }): DomainRoute => ({
  fqdn: x.host ? `${x.host}.bro.vip` : 'bro.vip', target: { kind: 'url', url: 'http://127.0.0.1:1' }, enabled: true, auto: false, note: '',
  check: null, created_at: '', updated_at: '', ...x,
})

const proto = (id: string, name: string, project: string, status: TerminalPrototype['status'] = 'running'): TerminalPrototype => ({
  id, project_id: 'p', name, dir: '/x', command: '', argv: [], port: 5170, url: '', status, error: '', pid: 0, started_at: null,
  last_crash: null, created_at: '', updated_at: '', project_title: project,
})

describe('校验', () => {
  it('后缀同后端：不能是 local，也不能以 .local 结尾', () => {
    expect(validSuffix('bro.vip')).toBe(true)
    expect(validSuffix('pmw.lan')).toBe(true)
    expect(validSuffix('local')).toBe(false)
    expect(validSuffix('a.local')).toBe(false)
    expect(validSuffix('Bro.vip')).toBe(false)
    expect(validSuffix('a..b')).toBe(false)
  })
  it('子域名：不以连字符开头结尾，63 个以内', () => {
    expect(validHost('app')).toBe(true)
    expect(validHost('-a')).toBe(false)
    expect(validHost('a-')).toBe(false)
    expect(validHost('a'.repeat(63))).toBe(true)
    expect(validHost('a'.repeat(64))).toBe(false)
  })
  it('子域名提示：不合法、重名', () => {
    const all = [route({ id: 'dm_1', host: 'video' })]
    expect(hostError('', all)).toBe('')
    expect(hostError('a_b', all)).toBe('只能用小写字母、数字和连字符')
    expect(hostError('video', all)).toBe('已经有这个域名了')
    expect(hostError('pm', all)).toBe('')
  })
  it('别名：带点、不等于后缀', () => {
    expect(parseAliases('Broleez.vip, a.b  a.b')).toEqual(['broleez.vip', 'a.b'])
    expect(aliasError(['broleez.vip'], 'bro.vip')).toBe('')
    expect(aliasError(['broleez'], 'bro.vip')).toMatch('不合法')
    expect(aliasError(['bro.vip'], 'bro.vip')).toBe('别名不能和后缀相同')
  })
  it('IPv4', () => {
    expect(validIPv4('192.168.1.23')).toBe(true)
    expect(validIPv4('256.1.1.1')).toBe(false)
    expect(validIPv4('')).toBe(false)
  })
})

describe('显示', () => {
  const protos = [proto('pt_1', '状态看板', '视频工程', 'stopped')]
  it('目标：工作台写明文口，原型写项目和端口，已删的原型写明', () => {
    expect(targetLabel(route({ id: 'dm_app', host: '', target: { kind: 'app' } }), S, protos)).toBe('一人之下（:7777）')
    expect(targetLabel(route({ id: 'a', host: 'a', target: { kind: 'proto', proto_id: 'pt_1' } }), S, protos)).toBe('视频工程 / 状态看板（:5170）')
    expect(targetLabel(route({ id: 'b', host: 'b', target: { kind: 'proto', proto_id: 'pt_x' } }), S, protos)).toBe('已删除的原型')
    expect(protoDown(route({ id: 'a', host: 'a', target: { kind: 'proto', proto_id: 'pt_1' } }), protos)).toBe(true)
  })
  it('同名只算启用的，和别名撞也算', () => {
    const rs = [
      route({ id: '1', host: 'a', fqdn: 'a.bro.vip' }), route({ id: '2', host: 'b', fqdn: 'a.bro.vip' }),
      route({ id: '3', host: 'c', fqdn: 'c.bro.vip', enabled: false }), route({ id: '4', host: 'd', fqdn: 'broleez.vip' }),
    ]
    expect([...conflicts(rs, ['broleez.vip'])].sort()).toEqual(['a.bro.vip', 'broleez.vip'])
  })
  it('搜索域名、目标和备注', () => {
    const r = route({ id: '1', host: 'video', note: '视频预览' })
    expect(matchRoute(r, 'VIDEO', 'x')).toBe(true)
    expect(matchRoute(r, '7801', 'http://127.0.0.1:7801')).toBe(true)
    expect(matchRoute(r, '预览', '')).toBe(true)
    expect(matchRoute(r, 'zzz', '')).toBe(false)
  })
  it('自动分配按项目分组，记启用数和问题数', () => {
    const protos2 = [proto('pt_1', '看板', '甲'), proto('pt_2', '后台', '乙')]
    const rs = [
      route({ id: '1', host: 'a', auto: true, target: { kind: 'proto', proto_id: 'pt_1' } }),
      route({ id: '2', host: 'b', auto: true, enabled: false, target: { kind: 'proto', proto_id: 'pt_2' } }),
      route({ id: '3', host: 'c', auto: true, target: { kind: 'proto', proto_id: 'pt_1' }, check: { ok: false, at: '', message: 'x' } }),
      route({ id: '4', host: 'd', auto: true, target: { kind: 'proto', proto_id: 'pt_gone' } }),
    ]
    expect(groupAuto(rs, protos2, new Set()).map((g) => [g.name, g.xs.length, g.on, g.bad])).toEqual([
      ['甲', 2, 2, 1], ['乙', 1, 0, 0], ['已删除的项目', 1, 1, 0],
    ])
  })
  it('相对时间', () => {
    const now = Date.parse('2026-10-29T10:00:00Z')
    expect(timeAgo('2026-10-29T09:59:30Z', now)).toBe('刚刚')
    expect(timeAgo('2026-10-29T09:30:00Z', now)).toBe('30 分钟前')
    expect(timeAgo('2026-10-29T07:00:00Z', now)).toBe('3 小时前')
    expect(timeAgo('2026-10-27T10:00:00Z', now)).toBe('2 天前')
    expect(timeAgo('bad', now)).toBe('')
  })
})

describe('自动分配的原型域名（DOM-02b）', () => {
  const auto = route({ id: 'a', host: 'demo', auto: true, target: { kind: 'proto', proto_id: 'p1' } })
  const app = route({ id: 'app', host: '', target: { kind: 'app' } })

  it('跟着原型状态写能不能访问', () => {
    expect(protoAccess(auto, [proto('p1', 'Demo', '官网')])).toBe('up')
    expect(protoAccess(auto, [proto('p1', 'Demo', '官网', 'starting')])).toBe('starting')
    expect(protoAccess(auto, [proto('p1', 'Demo', '官网', 'crashed')])).toBe('down')
    expect(protoAccess(auto, [])).toBe('gone')
    expect(protoAccess(app, [])).toBeNull()
    expect(protoDown(auto, [])).toBe(false)
  })

  it('关掉自动分配后自动行不显示', () => {
    expect(visibleRoutes([app, auto], S).map((r) => r.id)).toEqual(['app', 'a'])
    expect(visibleRoutes([app, auto], { ...S, auto_proto: false }).map((r) => r.id)).toEqual(['app'])
  })

  it('在跑却还没域名的原型才等；关掉自动分配、路由没取到时不等', () => {
    const protos = [proto('p1', 'Demo', '官网'), proto('p2', 'B', '官网'), proto('p3', 'C', '官网', 'stopped')]
    expect(awaitingAuto([app, auto], protos, S)).toBe('p2')
    expect(awaitingAuto([app], protos, S)).toBe('p1,p2')
    expect(awaitingAuto([app], protos, { ...S, auto_proto: false })).toBe('')
    expect(awaitingAuto(undefined, protos, S)).toBe('')
  })
})
