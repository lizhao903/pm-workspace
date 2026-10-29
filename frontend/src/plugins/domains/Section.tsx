// 设置 > 内网域名（DOM-01b），照原型 web-next/src/domains.tsx（SPEC-settings-20）。
// 正式版多了本机状态（20.29 到 20.32）和分三段的生成配置（20.33）；插件不改系统，要改的都给命令让用户自己执行。
// 顶栏的标题由外壳给（插件分节的宿主），总开关和说明放在本节第一行
import { useEffect, useState } from 'react'
import {
  errorText, useDomainConfig, useDomainRoutes, useDomainSettings, useDomainStatus, usePutDomainSettings, useTerminalPrototypes,
  QueryState, type DomainSettings, type DomainSettingsPatch,
} from '../../core/data'
import { Button, cls, Switch } from '../../core/ui'
import { ConfigBlock } from './ConfigBlock'
import {
  PROXY_KIND, RESOLVE_MODE, aliasError, awaitingAuto, normName, parseAliases, validIPv4, validPort, validSuffix,
} from './model'
import { Commands, CommitInput } from './parts'
import { useCopy } from './useCopy'
import { RoutesBlock } from './RoutesBlock'
import { StatusBlock } from './StatusBlock'
import './domains.css'

/** 等自动域名：每 2 秒取一次路由，最多 15 次 */
const AUTO_WAIT_MS = 2000
const AUTO_WAIT_TRIES = 15

export default function DomainsSection() {
  const settings = useDomainSettings()
  return (
    <QueryState query={settings} errorTitle="读不到内网域名的设置">
      {(s) => <Body s={s} />}
    </QueryState>
  )
}

function Body({ s }: { s: DomainSettings }) {
  const put = usePutDomainSettings()
  const routes = useDomainRoutes()
  const status = useDomainStatus()
  const config = useDomainConfig()
  // 原型列表来自项目插件；项目插件没启用时取不到，当没有原型
  const protos = useTerminalPrototypes().data ?? []
  const { copied, copy } = useCopy()
  // 原型启动后后端收到事件才建自动域名，有在跑却还没域名的原型时隔一会儿取一次路由，取到或等够了就停
  const waiting = awaitingAuto(routes.data, protos, s)
  const refetchRoutes = routes.refetch
  useEffect(() => {
    if (!waiting) return
    let n = 0
    const t = setInterval(() => {
      if (++n >= AUTO_WAIT_TRIES) clearInterval(t)
      void refetchRoutes()
    }, AUTO_WAIT_MS)
    return () => clearInterval(t)
  }, [waiting, refetchRoutes])
  const [howCa, setHowCa] = useState(false)
  // 局域网访问要先有 IPv4：没填地址时打开开关只先展开地址框，填好一起存
  const [wantLan, setWantLan] = useState(false)
  const lanOn = s.lan || wantLan
  const toggleLan = (v: boolean) => {
    if (v && !validIPv4(s.lan_ip)) return setWantLan(true)
    setWantLan(false)
    save({ lan: v })
  }
  const set = (patch: DomainSettingsPatch) => put.mutateAsync(patch)
  const save = (patch: DomainSettingsPatch) => { set(patch).catch(() => {}) }
  const suffixBad = !validSuffix(s.suffix)
  const ca = status.data?.items.find((i) => i.key === 'ca')

  return (
    <div className="dm-page">
      <div className="dm-head">
        <span className="dm-head-desc">给本机跑的服务配好记的域名，自己和局域网里的同事不用记端口</span>
        <Switch checked={s.enabled} onCheckedChange={(v) => save({ enabled: v })} aria-label="内网域名总开关">
          {s.enabled ? '已启用' : '未启用'}
        </Switch>
      </div>
      {put.isError && <div className="dm-err" role="alert">没存上：{errorText(put.error)}</div>}

      <StatusBlock query={status} copied={copied} onCopy={copy} />

      <div className={cls('dm-grid', !s.enabled && 'dm-off')}>
        <section className="dm-sec" aria-label="域名后缀和解析方式">
          <div className="dm-title">域名后缀</div>
          <SuffixInput s={s} onCommit={(v) => set({ suffix: v })} />
          <div className="dm-title dm-sub">工作台的别名</div>
          <CommitInput
            className="input mono" aria-label="工作台的别名" placeholder="比如 broleez.vip，多个用空格隔开"
            value={s.aliases.join(' ')} normalize={(v) => v.toLowerCase()}
            invalid={(v) => !!aliasError(parseAliases(v), s.suffix)}
            onCommit={(v) => set({ aliases: parseAliases(v) })}
          />
          <div className="dm-hint">和「这个工作台」那条一起写进 hosts、pf 和证书</div>

          <div className="dm-title dm-sub">解析方式</div>
          <div className="dm-opts" role="radiogroup" aria-label="解析方式">
            {(Object.keys(RESOLVE_MODE) as (keyof typeof RESOLVE_MODE)[]).map((k) => (
              <label key={k} className={cls('dm-opt', s.resolve === k && 'on')}>
                <input type="radio" name="dm-resolve" checked={s.resolve === k} onChange={() => save({ resolve: k })} />
                <span><b>{RESOLVE_MODE[k].label}</b><span className="dm-hint">{RESOLVE_MODE[k].desc}</span></span>
              </label>
            ))}
          </div>
        </section>

        <section className="dm-sec" aria-label="反向代理和访问">
          <div className="dm-title">反向代理</div>
          <div className="dm-seg dm-seg-full" role="group" aria-label="反向代理">
            {(Object.keys(PROXY_KIND) as (keyof typeof PROXY_KIND)[]).map((k) => (
              <button key={k} type="button" className={cls(s.proxy === k && 'on')} aria-pressed={s.proxy === k} onClick={() => save({ proxy: k })}>
                {PROXY_KIND[k].label}
              </button>
            ))}
          </div>
          <div className="dm-hint">{PROXY_KIND[s.proxy].desc}</div>
          {s.proxy === 'builtin' && (
            <div className="dm-ports">
              <span className="dm-hint">pf 把 80 转到</span>
              <PortInput label="明文口" value={s.http_port} other={s.https_port} onCommit={(n) => set({ http_port: n })} />
              <span className="dm-hint">443 转到</span>
              <PortInput label="TLS 口" value={s.https_port} other={s.http_port} onCommit={(n) => set({ https_port: n })} />
            </div>
          )}

          <div className="dm-switch-row dm-sub">
            <span><span className="dm-label">HTTPS</span><span className="dm-hint">用本地根证书给每个域名签证书；OAuth 回调、摄像头这类接口要求 HTTPS</span></span>
            <Switch checked={s.https} onCheckedChange={(v) => save({ https: v })} aria-label="HTTPS" />
          </div>
          {s.https && (
            <>
              <div className={cls('dm-ca', ca?.state === 'ok' ? 'ok' : 'warn')}>
                <span>
                  {!ca ? (status.isFetching ? '正在检测本地根证书…' : '本地根证书还没检测到')
                    : ca.state === 'ok' ? '本地根证书已装进系统钥匙串'
                    : ca.state === 'unknown' ? `没检测到本地根证书：${ca.message}`
                    : '本地根证书还没装，浏览器会提示连接不安全'}
                </span>
                <Button size="sm" variant="outline" aria-expanded={howCa} onClick={() => setHowCa(!howCa)}>{howCa ? '收起' : '怎么安装'}</Button>
              </div>
              {howCa && (
                <div className="dm-how">
                  <div className="dm-hint">插件不替你装证书；在终端执行下面的命令，装完点「重新检测」看结果</div>
                  <Commands id="ca" commands={config.data?.cert?.commands ?? ['mkcert -install']} copied={copied} onCopy={copy} />
                </div>
              )}
            </>
          )}

          <div className="dm-switch-row dm-sub">
            <span><span className="dm-label">允许局域网访问</span><span className="dm-hint">代理监听 0.0.0.0，域名解析到本机的局域网地址；同事的设备也要能解析这个后缀</span></span>
            <Switch checked={lanOn} onCheckedChange={toggleLan} aria-label="允许局域网访问" />
          </div>
          {(lanOn || s.resolve === 'router_dns') && (
            <div className="dm-ip">
              <span className="dm-hint">本机局域网地址</span>
              <CommitInput className="input mono" aria-label="本机局域网地址" placeholder="192.168.1.23" value={s.lan_ip}
                normalize={(v) => v.trim()} invalid={(v) => !!v && !validIPv4(v)}
                onCommit={(v) => set(wantLan && validIPv4(v) ? { lan_ip: v, lan: true } : { lan_ip: v }).then(() => setWantLan(false))} />
              {wantLan && !s.lan && <span className="dm-warn-inline">填好本机局域网地址（IPv4）就打开</span>}
              {lanOn && s.resolve === 'hosts' && <span className="dm-warn-inline">hosts 文件只对这台电脑生效，局域网访问建议改用本机 DNS 或路由器 DNS</span>}
            </div>
          )}
        </section>
      </div>

      <RoutesBlock s={s} query={routes} protos={protos} suffixBad={suffixBad} copied={copied} onCopy={copy}
        onAutoProto={(v) => save({ auto_proto: v })} />

      <ConfigBlock s={s} query={config} copied={copied} onCopy={copy} />
    </div>
  )
}

function SuffixInput({ s, onCommit }: { s: DomainSettings; onCommit: (v: string) => unknown }) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? s.suffix
  const bad = !validSuffix(shown)
  return (
    <>
      <div className={cls('dm-suffix', bad && 'bad')}>
        <span className="dm-faint">*.</span>
        <CommitInput className="mono" aria-label="域名后缀" value={s.suffix} normalize={normName} onDraft={setDraft}
          invalid={(v) => !validSuffix(v)} onCommit={onCommit} />
      </div>
      <div className={cls('dm-hint', bad && 'danger-text')}>
        {bad ? '后缀不合法；也别用 .local，它被系统的 mDNS 占用了' : `比如 app.${shown}；推荐 .lan、.internal 或自己公司的内网域名`}
      </div>
    </>
  )
}

function PortInput({ label, value, other, onCommit }: { label: string; value: number; other: number; onCommit: (n: number) => unknown }) {
  const bad = (v: string) => !validPort(Number(v)) || Number(v) === other
  return (
    <CommitInput className="input mono dm-port" aria-label={label} title={label} inputMode="numeric" value={String(value)}
      normalize={(v) => v.replace(/\D/g, '')} invalid={bad} onCommit={(v) => onCommit(Number(v))} />
  )
}
