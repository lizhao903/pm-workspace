// 平台图标清单（TSK-0725）：清单、SVG 文件、README 来源表、后端内置键、按地址认平台的域名表，几处要对得上。
import { describe, expect, it } from 'vitest'
import { PLATFORM_DOMAINS } from '../../data/connectorLogo'
import { LOGOS, logoFiles, logoUrl } from '.'

const readme = Object.values(import.meta.glob<string>('./README.md', { eager: true, query: '?raw', import: 'default' }))[0]
const backend = Object.values(import.meta.glob<string>('../../../../../internal/connector/logo.go', { eager: true, query: '?raw', import: 'default' }))[0]

describe('平台图标清单', () => {
  it('清单里的每个键都有 SVG 文件，文件也都在清单里', () => {
    expect(logoFiles().sort()).toEqual(Object.keys(LOGOS).sort())
    for (const k of Object.keys(LOGOS)) expect(logoUrl(k)).toBeTruthy()
    expect(logoUrl('nope')).toBeUndefined()
    expect(logoUrl('')).toBeUndefined()
  })

  it('README 的来源表列了每个文件', () => {
    for (const k of Object.keys(LOGOS)) expect(readme, k).toContain(`| \`${k}.svg\` |`)
  })

  it('后端 builtinLogos 的键都有图标', () => {
    const keys = [...backend.matchAll(/:\s*"([a-z0-9]+)",/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThanOrEqual(10)
    for (const k of keys) expect(LOGOS, k).toHaveProperty(k)
  })

  it('按地址认平台的域名表只指向有图标的键', () => {
    for (const [d, k] of PLATFORM_DOMAINS) expect(LOGOS, `${d} -> ${k}`).toHaveProperty(k)
  })
})
