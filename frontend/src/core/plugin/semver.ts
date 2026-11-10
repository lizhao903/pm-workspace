// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 版本号和版本范围，规则见 docs/plugin-api.md 1.2；后端 internal/plugin/semver.go 是同一套。

export type Version = readonly [number, number, number]

type Op = '>=' | '>' | '<=' | '<' | '='
type Comparator = { op: Op; v: Version }
export type Range = readonly Comparator[]

// 每段最多 9 位，Number 不会丢精度
const num = '(0|[1-9][0-9]{0,8})'
const versionRe = new RegExp(`^${num}\\.${num}\\.${num}$`)
const comparatorRe = new RegExp(`^(>=|<=|>|<|=|\\^|~)?${num}(?:\\.${num})?(?:\\.${num})?$`)

export function parseVersion(s: string): Version | null {
  const m = versionRe.exec(s)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function formatVersion(v: Version): string {
  return v.join('.')
}

function cmp(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

// 省略写法（>=1.2）只允许跟比较运算符，按补零处理；^、~ 和精确版本必须写全三段。
// 不支持 ||、*、x 和预发布标签。
export function parseRange(s: string): Range | null {
  const t = s.trim()
  if (!t) return null
  const out: Comparator[] = []
  for (const p of t.split(/\s+/)) {
    const m = comparatorRe.exec(p)
    if (!m) return null
    const op = m[1] ?? ''
    const full = m[3] !== undefined && m[4] !== undefined
    if (!full && (op === '' || op === '=' || op === '^' || op === '~')) return null
    const v: Version = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)]
    if (op === '^') {
      const hi: Version = v[0] > 0 ? [v[0] + 1, 0, 0] : v[1] > 0 ? [0, v[1] + 1, 0] : [0, 0, v[2] + 1]
      out.push({ op: '>=', v }, { op: '<', v: hi })
    } else if (op === '~') {
      out.push({ op: '>=', v }, { op: '<', v: [v[0], v[1] + 1, 0] })
    } else {
      out.push({ op: op === '' ? '=' : (op as Op), v })
    }
  }
  return out
}

export function matchRange(r: Range, v: Version): boolean {
  return r.every(({ op, v: c }) => {
    const d = cmp(v, c)
    switch (op) {
      case '>=':
        return d >= 0
      case '>':
        return d > 0
      case '<=':
        return d <= 0
      case '<':
        return d < 0
      default:
        return d === 0
    }
  })
}

// 任一边不合法都返回 false
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  const r = parseRange(range)
  return v !== null && r !== null && matchRange(r, v)
}
