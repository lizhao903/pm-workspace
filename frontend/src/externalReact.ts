// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 外部插件（P1-a）共享的 React：index.html 的 import map 把 react / react-dom / react-dom/client /
// react/jsx-runtime 都指到这个入口。插件 bundle 把 React 做 external，运行期从宿主同一个构建产物里取，
// 和主应用是同一份 React 实例（两套 React 会让 hook/context 直接失效）。改这里别引其它依赖。
//
// 注意：@types/react 是 `export = React` 的写法，不能用 `export * from 'react'`，所以这里显式列一遍。
// react 19 的公开导出（内部 __ 开头的不要）在这里逐个转出；新增 React 版本时同步补。
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { createRoot as reactCreateRoot, hydrateRoot as reactHydrateRoot } from 'react-dom/client'
import { jsx, jsxs } from 'react/jsx-runtime'

export const Activity = React.Activity
export const Children = React.Children
export const Component = React.Component
export const Fragment = React.Fragment
export const Profiler = React.Profiler
export const PureComponent = React.PureComponent
export const StrictMode = React.StrictMode
export const Suspense = React.Suspense
export const ViewTransition = React.ViewTransition
export const act = React.act
export const addTransitionType = React.addTransitionType
export const cache = React.cache
export const cacheSignal = React.cacheSignal
export const captureOwnerStack = React.captureOwnerStack
export const cloneElement = React.cloneElement
export const createContext = React.createContext
export const createElement = React.createElement
export const createRef = React.createRef
export const forwardRef = React.forwardRef
export const isValidElement = React.isValidElement
export const lazy = React.lazy
export const memo = React.memo
export const startTransition = React.startTransition
export const use = React.use
export const useActionState = React.useActionState
export const useCallback = React.useCallback
export const useContext = React.useContext
export const useDebugValue = React.useDebugValue
export const useDeferredValue = React.useDeferredValue
export const useEffect = React.useEffect
export const useEffectEvent = React.useEffectEvent
export const useId = React.useId
export const useImperativeHandle = React.useImperativeHandle
export const useInsertionEffect = React.useInsertionEffect
export const useLayoutEffect = React.useLayoutEffect
export const useMemo = React.useMemo
export const useOptimistic = React.useOptimistic
export const useReducer = React.useReducer
export const useRef = React.useRef
export const useState = React.useState
export const useSyncExternalStore = React.useSyncExternalStore
export const useTransition = React.useTransition
export const version = React.version

// react-dom 的具名导出（createPortal、flushSync、资源预加载等）；version 和 react 的重复，不转出
export const browser = ReactDOM.browser
export const createPortal = ReactDOM.createPortal
export const flushSync = ReactDOM.flushSync
export const preconnect = ReactDOM.preconnect
export const prefetchDNS = ReactDOM.prefetchDNS
export const preinit = ReactDOM.preinit
export const preinitModule = ReactDOM.preinitModule
export const preload = ReactDOM.preload
export const preloadModule = ReactDOM.preloadModule
export const requestFormReset = ReactDOM.requestFormReset
export const unstable_batchedUpdates = ReactDOM.unstable_batchedUpdates
export const useFormState = ReactDOM.useFormState
export const useFormStatus = ReactDOM.useFormStatus

export const createRoot = reactCreateRoot
export const hydrateRoot = reactHydrateRoot
export { jsx, jsxs }

export default React
