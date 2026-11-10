// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { createContext } from 'react'

/** 顶栏里留给页面标题的位置；外壳（CORE-02a）提供，PageTitle 把内容送进去 */
export const TopbarContext = createContext<HTMLElement | null>(null)
