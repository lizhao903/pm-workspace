// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useSyncExternalStore } from 'react'

// 交给 Claude Code 的角色（SPEC-tasks-6.18、SPEC-settings-24，AUTO-03 由预置提示词升级）：执行要求、权限、输出要求、默认目录。
// 弹窗里选一个，执行要求和输出要求拼进提示词，权限决定流式执行能不能改文件。
// 原型只放内存（刷新回到内置六个）；正式产品存在 agent_settings.run_prompts，GET / PUT /api/run-prompts，
// 没设过回内置六个，旧数据读时把没见过的内置角色补在末尾（按 id，删掉的不补回）。

export type RolePermission = 'read_only' | 'accept_edits'
export type RoleDirKind = 'code' | 'prototype' | 'prd' | 'any'
export type RunPreset = {
  id: string; scene: string; content: string; default: boolean
  permission: RolePermission; output: string; dir_kind: RoleDirKind
}

const FINISH = '结束时用 pmw_finish_run 回报 summary（一段结论）和 result（JSON 对象）：'

export const DEFAULT_PRESETS: RunPreset[] = [
  { id: 'rp_classify', scene: '分类', default: false, permission: 'read_only', dir_kind: 'any',
    content: '判断这条需求该归到哪个项目：读任务内容、来源消息和各项目档案的摘要，给出最可能的项目和理由；拿不准时列出候选项目，不要猜。',
    output: FINISH + '{"project_id": "最可能的项目 id，拿不准时留空", "confidence": 0 到 1 的置信度, "candidates": ["候选项目 id"], "reason": "一句话理由"}。' },
  { id: 'rp_pm', scene: '产品经理工作台', default: true, permission: 'accept_edits', dir_kind: 'prototype',
    content: '请按用户要求输出 PRD 文档，更新产品原型，同步后回复用户消息。',
    output: '验收标准要写成能逐条测试的样子；每份产出（PRD、原型、规格）用 pmw_record_artifact 登记。' + FINISH + '{"artifacts": ["产出的文件或链接"], "questions": ["需要提出人回答的问题，没有为空"]}。' },
  { id: 'rp_review', scene: '研发评审', default: false, permission: 'read_only', dir_kind: 'code',
    content: '只读评审：对照任务的验收标准，审查 PRD、原型和规格是否清楚、能实现、能测试，指出歧义、遗漏和与现有代码冲突的地方。',
    output: FINISH + '{"verdict": "pass 或 reject", "issues": [{"title": "问题", "detail": "说明和依据", "severity": "blocker 或 minor"}]}；verdict 为 reject 时 issues 至少一条。' },
  { id: 'rp_dev', scene: '研发', default: false, permission: 'accept_edits', dir_kind: 'code',
    content: '按任务内容和验收标准修改代码，跑通相关测试后提交；结束时说明改了哪些文件、怎么验证的。',
    output: FINISH + '{"files": ["改动的文件"], "tests": "passed 或 failed", "commits": ["提交的 sha"]}。' },
  { id: 'rp_testdesign', scene: '测试设计', default: false, permission: 'accept_edits', dir_kind: 'code',
    content: '按验收标准设计测试：逐条写出测试用例（前置条件、步骤、预期），能自动化的写成测试代码或脚本放进项目的测试目录；不改业务代码。',
    output: FINISH + '{"cases": 用例条数, "automated": 已自动化的条数, "files": ["新增的测试文件"]}。' },
  { id: 'rp_protosync', scene: '原型同步', default: false, permission: 'accept_edits', dir_kind: 'prototype',
    content: '把原型拉齐到已上线的代码：对照代码和规格，找出原型里过时、缺失的界面和状态并补齐，更新规格里的状态标注；拿不准的差异列出来交给产品裁决，不要自己定。',
    output: FINISH + '{"synced": ["已同步的页面或规格条目"], "pending": [{"title": "拿不准的差异", "detail": "说明"}]}。' },
]

export const PERMISSION_OPTIONS: { value: RolePermission; label: string }[] = [
  { value: 'accept_edits', label: '允许改文件（acceptEdits）' },
  { value: 'read_only', label: '只读' },
]
export const DIR_KIND_OPTIONS: { value: RoleDirKind; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'code', label: '代码目录' },
  { value: 'prototype', label: '原型目录' },
  { value: 'prd', label: 'PRD 目录' },
]

export function blankRole(): RunPreset {
  return { id: '', scene: '', content: '', default: false, permission: 'accept_edits', output: '', dir_kind: 'any' }
}

export const PRESET_MAX = 30
export const PRESET_SCENE_MAX = 40
export const PRESET_CONTENT_MAX = 4000
export const PRESET_OUTPUT_MAX = 2000

let state: RunPreset[] = DEFAULT_PRESETS
const subs = new Set<() => void>()
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

export function useRunPresets(): RunPreset[] {
  return useSyncExternalStore(subscribe, () => state)
}

/** 整组保存；新条目补 id */
export function saveRunPresets(list: RunPreset[]) {
  let n = 0
  state = list.map((p) => ({ ...p, id: p.id || `rp_${Date.now().toString(36)}${n++}`, scene: p.scene.trim(), content: p.content.trim(), output: p.output.trim() }))
  subs.forEach((f) => f())
}

/** 一条的问题，口径同后端：场景 1 到 40 字不重复，执行要求 1 到 4000 字，输出要求最多 2000 字 */
export function presetIssues(list: RunPreset[], i: number): { scene?: string; content?: string; output?: string } {
  const scene = list[i].scene.trim()
  const content = list[i].content.trim()
  const out: { scene?: string; content?: string; output?: string } = {}
  if (!scene) out.scene = '写一个角色场景'
  else if ([...scene].length > PRESET_SCENE_MAX) out.scene = `最多 ${PRESET_SCENE_MAX} 字`
  else if (list.findIndex((x) => x.scene.trim() === scene) !== i) out.scene = '和上面的重复了'
  if (!content) out.content = '写上执行要求'
  else if ([...content].length > PRESET_CONTENT_MAX) out.content = `最多 ${PRESET_CONTENT_MAX} 字`
  if ([...list[i].output.trim()].length > PRESET_OUTPUT_MAX) out.output = `最多 ${PRESET_OUTPUT_MAX} 字`
  return out
}

/** 当前的角色列表（非 React 处取用，比如 SOP 节点的下拉选项） */
export const runPresetsNow = (): RunPreset[] => state
