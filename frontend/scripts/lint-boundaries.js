// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// oxlint 的 JS 插件（CORE-03b）：守住插件和模块之间的边界，no-restricted-imports 只看字面路径，表达不了「同目录可以、别的插件不行」。
// - plugins/<a> 只能 import core/* 和自己目录（测试另外可以读 plugins/enabled.ts）
// - modules/<x> 不 import 插件；别的模块只能 import 它的 index.ts
// 只检查相对路径；npm 包不管。规则在 .oxlintrc.json 里以 pmw/boundaries 启用。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src')

// 相对 src 的路径，用 / 分隔；不在 src 里返回 null
function inSrc(abs) {
  const rel = path.relative(SRC, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

// plugins/<a>/... 或 modules/<x>/... 拆成 [区, 名字, 剩下]；顶层文件名字为空
function zoneOf(rel) {
  const parts = rel.split('/')
  if (parts[0] !== 'plugins' && parts[0] !== 'modules') return null
  // 引用目录（../tasks）等于引它的 index.ts
  if (parts.length === 2 && !isDir(path.join(SRC, rel))) return { zone: parts[0], name: '', rest: parts[1] }
  return { zone: parts[0], name: parts[1], rest: parts.slice(2).join('/') }
}

function isDir(abs) {
  try {
    return fs.statSync(abs).isDirectory()
  } catch {
    return false
  }
}

const stripExt = (p) => p.replace(/\.(tsx?|jsx?)$/, '')
const isTest = (rel) => /\.test\.[jt]sx?$/.test(rel)

// 返回违规说明，合规返回 null
function check(fromRel, toRel) {
  const from = zoneOf(fromRel)
  if (!from) return null
  const to = zoneOf(toRel)
  if (from.zone === 'plugins' && from.name) {
    if (toRel.startsWith('core/')) return null
    if (to && to.zone === 'plugins' && to.name === from.name) return null
    if (isTest(fromRel) && stripExt(toRel) === 'plugins/enabled') return null
    if (to && to.zone === 'plugins' && to.name) return `插件之间互不 import：plugins/${from.name} 不能引 ${toRel}`
    if (to && to.zone === 'modules') return `插件不 import 模块：plugins/${from.name} 不能引 ${toRel}，数据走 core/data`
    return `插件只能 import core/* 和自己目录：plugins/${from.name} 不能引 ${toRel}`
  }
  if (from.zone === 'modules') {
    if (!to) return null
    if (to.zone === 'plugins') return `模块不 import 插件：不能引 ${toRel}`
    if (to.name === from.name && from.name) return null
    if (!to.name) return `模块不 import modules 顶层文件 ${toRel}`
    const rest = stripExt(to.rest)
    if (rest === '' || rest === 'index') return null
    return `模块之间只能 import 对方的 index.ts：不能引 ${toRel}，改从 modules/${to.name} 引，或走 core/data`
  }
  return null
}

const boundaries = {
  meta: { type: 'problem', docs: { description: '插件和模块之间的 import 边界' } },
  create(context) {
    const file = context.physicalFilename ?? context.filename
    const fromRel = inSrc(file)
    if (!fromRel || !zoneOf(fromRel)) return {}
    const dir = path.dirname(file)
    function visit(source) {
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return
      const spec = source.value
      if (!spec.startsWith('.')) return
      const toRel = inSrc(path.resolve(dir, spec))
      if (toRel === null) return
      const msg = check(fromRel, toRel)
      if (msg) context.report({ node: source, message: msg })
    }
    return {
      ImportDeclaration: (n) => visit(n.source),
      ExportNamedDeclaration: (n) => visit(n.source),
      ExportAllDeclaration: (n) => visit(n.source),
      ImportExpression: (n) => visit(n.source),
    }
  },
}

export default {
  meta: { name: 'pmw' },
  rules: { boundaries },
}
