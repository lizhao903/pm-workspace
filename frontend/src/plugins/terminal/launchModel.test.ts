import { describe, expect, it } from 'vitest'
import { commandError, renderClaudeCommand } from './launchModel'

const p = { prompt_file: '/d/tmp/handoff/run_1/prompt.md', mcp_config: '/d/tmp/handoff/run_1/mcp.json', workdir: "/w/it's here" }

describe('启动命令渲染（和后端 RenderClaudeCommand 同规则）', () => {
  it('没写占位符：先补提示词再补 MCP 配置', () => {
    expect(renderClaudeCommand('', p)).toBe(`gogogo "$(cat '/d/tmp/handoff/run_1/prompt.md')" --mcp-config '/d/tmp/handoff/run_1/mcp.json'`)
  })
  it('写全了不补，单引号转义', () => {
    expect(renderClaudeCommand('cd {{workdir}} && claude --mcp-config {{mcp_config}} -- "$(cat {{prompt_file}})"', p))
      .toBe(`cd '/w/it'\\''s here' && claude --mcp-config '/d/tmp/handoff/run_1/mcp.json' -- "$(cat '/d/tmp/handoff/run_1/prompt.md')"`)
  })
  it('只写了一个补另一个；多包的引号去掉', () => {
    expect(renderClaudeCommand('claude --mcp-config {{mcp_config}}', p))
      .toBe(`claude --mcp-config '/d/tmp/handoff/run_1/mcp.json' "$(cat '/d/tmp/handoff/run_1/prompt.md')"`)
    expect(renderClaudeCommand('cd "{{workdir}}" && claude \'{{prompt_file}}\' {{mcp_config}}', p))
      .toBe(`cd '/w/it'\\''s here' && claude '/d/tmp/handoff/run_1/prompt.md' '/d/tmp/handoff/run_1/mcp.json'`)
  })
  it('只能写一行', () => {
    expect(commandError('a\nb')).toBeTruthy()
    expect(commandError('gogogo')).toBeUndefined()
  })
})
