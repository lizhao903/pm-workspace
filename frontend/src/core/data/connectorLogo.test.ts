// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import { connectorLook, detectedLogo, detectPlatform } from './connectorLogo'

describe('按地址认平台（TSK-0725）', () => {
  it.each([
    ['https://mcp.notion.com/mcp', 'notion'],
    ['https://mcp.linear.app/sse', 'linear'],
    ['https://mcp.atlassian.com/v1/sse', 'atlassian'],
    ['https://api.githubcopilot.com/mcp/', 'github'],
    ['https://mcp.figma.com/mcp', 'figma'],
    ['https://docs.mcp.cloudflare.com/sse', 'cloudflare'],
    ['https://www.googleapis.com/drive/v3', 'google'],
    ['https://MCP.Sentry.dev/mcp', 'sentry'],
    ['https://example.com/notion.com', ''],
    ['https://notnotion.com/mcp', ''],
    ['not a url', ''],
    ['', ''],
  ])('%s -> %s', (url, want) => {
    expect(detectPlatform(url)).toBe(want)
  })

  it('OpenAPI 先看接口地址再看文档地址；不是自定义连接器不认', () => {
    expect(detectedLogo('custom_openapi', { base_url: 'https://api.stripe.com', spec_url: 'https://raw.githubusercontent.com/x/openapi.json' })).toBe('stripe')
    expect(detectedLogo('custom_openapi', { spec_url: 'https://raw.githubusercontent.com/x/openapi.json' })).toBe('github')
    expect(detectedLogo('slack', { url: 'https://mcp.notion.com/mcp' })).toBe('')
  })

  it('显示顺序：自己换的图标 > 认出的平台 > 定义的 logo', () => {
    const def = { tool: 'custom_mcp', label: 'MCP 服务', color: '#7a4fd6', logo: 'modelcontextprotocol' }
    const c = { tool: 'custom_mcp', name: '笔记', icon: '', config: { url: 'https://mcp.notion.com/mcp' } }
    expect(connectorLook(def)).toEqual({ label: 'MCP 服务', color: '#7a4fd6', logo: 'modelcontextprotocol', src: '' })
    expect(connectorLook(def, c).logo).toBe('notion')
    expect(connectorLook(def, { ...c, icon: 'data:image/png;base64,AA' }).src).toBe('data:image/png;base64,AA')
    // 抽屉里还没保存的地址
    expect(connectorLook(def, c, { url: 'https://mcp.linear.app/mcp' }).logo).toBe('linear')
    // 定义不在了（插件停用）：用实例名、没有平台图标
    expect(connectorLook(undefined, { tool: 'telegram', name: 'Bot', icon: '', config: {} })).toEqual({ label: 'Bot', color: '', logo: '', src: '' })
  })
})
