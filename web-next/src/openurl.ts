// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { createContext, useContext } from 'react'

// 打开一个地址：工作台开了「浏览器」模块就在内置浏览器里开，没开就交给系统浏览器
export type OpenUrl = (url: string, title?: string) => void
export const OpenUrlContext = createContext<OpenUrl>((url) => { window.open(url, '_blank', 'noopener') })
export const useOpenUrl = () => useContext(OpenUrlContext)

/** 原型分到的内网域名；没开内网域名或没分配时返回 null */
export const ProtoDomainContext = createContext<(protoId: string) => string | null>(() => null)
export const useProtoDomain = () => useContext(ProtoDomainContext)
