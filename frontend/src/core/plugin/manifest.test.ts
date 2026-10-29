import { describe, expect, it } from 'vitest'
import {
  EXTENSION_POINTS,
  MANIFEST_FIELDS,
  PERMISSIONS,
  PLUGIN_API_VERSION,
  checkManifest,
  formatIssue,
  parseManifest,
  parseManifestText,
  validateManifest,
  type ManifestResult,
  type PluginManifest,
} from './manifest'
import { parseRange, satisfies } from './semver'

// 样例集和后端 internal/plugin/manifest_test.go 共用，读原文，和后端一样从文本解析
const dir = '../../../../docs/plugin-manifest-examples/'
const raw = import.meta.glob<string>('../../../../docs/plugin-manifest-examples/**/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const specRaw = import.meta.glob<string>('../../../../docs/plugin-api/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const schemaRaw = import.meta.glob<string>('../../../../docs/plugin-manifest.schema.json', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function file(rel: string): string {
  const s = raw[dir + rel]
  if (s === undefined) throw new Error(`找不到样例 ${rel}`)
  return s
}

type Expected = {
  env: { api_version: string; plugins: string[] }
  cases: Record<string, string[]>
}
const expected = JSON.parse(file('expected.json')) as Expected
const ranges = JSON.parse(file('ranges.json')) as { match: [string, string, boolean][]; invalid: string[] }

function strings(r: ManifestResult): string[] {
  return r.ok ? [] : r.issues.map(formatIssue)
}

function mustParse(v: unknown): PluginManifest {
  const r = parseManifest(v)
  if (!r.ok) throw new Error(strings(r).join('；'))
  return r.manifest
}

const env = {
  apiVersion: expected.env.api_version,
  plugins: expected.env.plugins.map((f) => mustParse(JSON.parse(file(f)))),
}

describe('共用样例', () => {
  const files = Object.keys(raw)
    .map((k) => k.slice(dir.length))
    .filter((k) => k.startsWith('valid/') || k.startsWith('invalid/'))
    .sort()

  it('样例文件和 expected.json 一一对应，3 个合法、5 个非法', () => {
    expect(Object.keys(expected.cases).sort()).toEqual(files)
    expect(files.filter((f) => f.startsWith('valid/'))).toHaveLength(3)
    expect(files.filter((f) => f.startsWith('invalid/'))).toHaveLength(5)
    for (const f of files) expect(expected.cases[f].length === 0).toBe(f.startsWith('valid/'))
  })

  it.each(files)('%s', (f) => {
    const r = parseManifestText(file(f))
    const got = r.ok ? strings(validateManifest(r.manifest, env)) : strings(r)
    expect(got).toEqual(expected.cases[f])
  })

  it('docs/plugin-api 的两份样例和合法样例集里的副本一致', () => {
    for (const name of ['projects.json', 'im.json']) {
      expect(file(`valid/${name}`)).toBe(specRaw[`../../../../docs/plugin-api/${name}`])
    }
  })
})

describe('版本范围', () => {
  it.each(ranges.match)('%s 对 %s 是 %s', (rng, ver, want) => {
    expect(parseRange(rng)).not.toBeNull()
    expect(satisfies(ver, rng)).toBe(want)
  })

  it.each(ranges.invalid)('%j 不合法', (rng) => {
    expect(parseRange(rng)).toBeNull()
  })
})

describe('schema 和代码不漂移', () => {
  const schema = JSON.parse(Object.values(schemaRaw)[0]) as {
    required: string[]
    properties: Record<string, { properties?: Record<string, unknown>; items?: { anyOf: { enum?: string[] }[] } }>
    $defs: Record<string, { pattern: string }>
  }

  it('顶层字段、必填、扩展点、权限一致', () => {
    expect(Object.keys(schema.properties).sort()).toEqual([...MANIFEST_FIELDS].sort())
    expect([...schema.required].sort()).toEqual(['core', 'id', 'name', 'permissions', 'provides', 'version'])
    expect(Object.keys(schema.properties.provides.properties ?? {}).sort()).toEqual([...EXTENSION_POINTS].sort())
    expect(schema.properties.permissions.items?.anyOf[0].enum).toEqual(PERMISSIONS)
  })

  it('范围正则和 parseRange 判断一致', () => {
    const re = new RegExp(schema.$defs.range.pattern)
    for (const rng of [...ranges.match.map((c) => c[0]), ...ranges.invalid]) {
      expect([rng, re.test(rng)]).toEqual([rng, parseRange(rng) !== null])
    }
    expect(new RegExp(schema.$defs.version.pattern).test(PLUGIN_API_VERSION)).toBe(true)
  })
})

const base = { id: 'alpha', name: 'A', version: '1.0.0', core: '^1.0.0', provides: {}, permissions: [] }

describe('环境检查', () => {
  it('core 不含当前版本、强依赖成环', () => {
    const a = mustParse({ ...base, core: '>=2.0.0', depends: { beta: '^1.0.0' } })
    const b = mustParse({ ...base, id: 'beta', depends: { gamma: '^1.0.0' } })
    const g = mustParse({ ...base, id: 'gamma', depends: { alpha: '^1.0.0' } })
    expect(checkManifest(a, { plugins: [b, g] }).map(formatIssue)).toEqual([
      'core 不包含当前插件 API 版本 1.0.0：>=2.0.0',
      'depends 形成循环依赖：alpha -> beta -> gamma -> alpha',
    ])
  })

  it('弱依赖成环允许，没装也不报', () => {
    const p = mustParse({ ...base, optional_depends: { beta: '^1.0.0', missing: '^1.0.0' } })
    const q = mustParse({ ...base, id: 'beta', optional_depends: { alpha: '^1.0.0' } })
    expect(checkManifest(p, { plugins: [q] })).toEqual([])
  })

  it('连接器 id 冲突', () => {
    const a = mustParse({ ...base, provides: { connectors: ['slack'] } })
    const b = mustParse({ ...base, id: 'beta', provides: { connectors: ['lark', 'slack'] } })
    expect(checkManifest(a, { plugins: [a, b] }).map(formatIssue)).toEqual(['provides.connectors[0] 已被插件 beta 声明：slack'])
  })
})

// 和后端 TestParseStructure 同一批用例
describe('结构校验', () => {
  const cases: [unknown, string[]][] = [
    [[], ['清单 必须是 JSON 对象']],
    [{}, ['id 必填', 'name 必填', 'version 必填', 'core 必填', 'provides 必填', 'permissions 必填']],
    [{ ...base, id: 'tasks' }, ['id 是内核保留字：tasks']],
    [
      { ...base, id: 'Bad-Id', name: ' ', provides: { agent_tools: ['x'] } },
      ['id 不合法：必须匹配 ^[a-z][a-z0-9_]{1,23}$：Bad-Id', 'name 不能为空'],
    ],
    [
      { ...base, depends: { alpha: '^1.0.0', Beta: '^1.0.0', gamma: 1 }, optional_depends: { gamma: '^1.0.0' } },
      ['depends.Beta 不是合法的插件 id', 'depends.alpha 不能依赖自己', 'depends.gamma 必须是字符串'],
    ],
    [{ ...base, depends: { beta: '^1.0.0' }, optional_depends: { beta: '^1.0.0' } }, ['optional_depends.beta 已在 depends 里声明']],
    [
      {
        ...base,
        provides: { object_types: ['beta'], skills: ['plan'], commands: ['alpha.go', 'beta.go'], modules: ['a', 'a', 3], sop_nodes: 'x' },
      },
      [
        'provides.modules[2] 必须是字符串',
        'provides.object_types[0] 必须等于 alpha 或以 alpha_ 开头：beta',
        'provides.skills[0] 必须以 sk_ 开头：plan',
        'provides.sop_nodes 必须是字符串数组',
        'provides.commands[1] 必须是 alpha.<动作>：beta.go',
      ],
    ],
    [{ ...base, provides: { modules: ['a', 'a'] } }, ['provides.modules[1] 重复：a']],
    [{ ...base, emits: ['alpha.done', 'nodot'], subscribes: ['alpha.done', 'object.created'] }, ['emits[1] 不是合法的事件类型：nodot']],
    [
      { ...base, adopts: { object_types: ['project'], routes: ['/x'], extra: [] } },
      ['adopts.extra 是未知字段', 'adopts.routes[0] 必须以 /api/ 开头：/x'],
    ],
    [{ ...base, permissions: ['secrets:im', 'secrets:im'] }, ['permissions[1] 重复：secrets:im']],
    [
      { ...base, migrations: '../x', table_prefix: 'beta_' },
      ['migrations 必须是插件目录内的相对路径：../x', 'table_prefix 必须是 alpha_：beta_'],
    ],
    [{ ...base, icon: 3 }, ['icon 必须是字符串']],
    [{ ...base, icon: 'my-icon' }, ['icon 不合法：只能用小写字母、数字、下划线：my-icon']],
  ]

  it.each(cases)('%j', (input, want) => {
    expect(strings(parseManifest(input))).toEqual(want)
  })

  it('解析结果保留字段，permissions 为空数组', () => {
    expect(mustParse(base).permissions).toEqual([])
    expect(mustParse({ ...base, icon: 'folder' }).icon).toBe('folder')
    const im = mustParse(JSON.parse(file('valid/im.json')))
    expect(im.optional_depends).toEqual({ projects: '>=0.1.0 <1.0.0' })
    expect(im.table_prefix).toBe('im_')
    expect(im.provides.connectors).toHaveLength(4)
  })
})
