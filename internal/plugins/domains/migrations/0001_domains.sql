-- 0001_domains: 内网域名插件的设置、路由和测试结果（DOM-01a）
--
-- domains_settings 只有一行（id = 1），字段对照原型 web-next/src/domaindata.ts 的 DomainSettings，
-- 多 aliases（工作台的别名，完整域名的 JSON 数组）、http_port / https_port（pf 把 80、443 转到的端口）。
-- 默认行由插件安装时写（迁移里只能建表），按现有 bro.vip 方案（docs/local-domain.md）：后缀 bro.vip、别名 broleez.vip、hosts 解析、内置代理、HTTPS。
-- ca_installed 只为和原型同形，证书状态以 GET /api/domains/status 的检测为准。
--
-- domains_routes 对照 DomainRoute：target 拆成 target_kind / proto_id / url 三列。
-- 安装时写一条工作台自己的路由 dm_app（子域名为空，完整域名就是后缀）。
-- host 是子域名，完整域名 = host + '.' + 后缀；只有目标是这个工作台时 host 可以为空（完整域名就是后缀本身）。
-- 测试结果按完整域名另存在 domains_checks，不写回路由（SPEC-settings-20.17）。
-- 时间用 RFC3339 UTC。

CREATE TABLE domains_settings (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  enabled      INTEGER NOT NULL DEFAULT 1,
  suffix       TEXT NOT NULL,
  resolve      TEXT NOT NULL DEFAULT 'hosts',
  proxy        TEXT NOT NULL DEFAULT 'builtin',
  https        INTEGER NOT NULL DEFAULT 1,
  ca_installed INTEGER NOT NULL DEFAULT 0,
  lan          INTEGER NOT NULL DEFAULT 0,
  lan_ip       TEXT NOT NULL DEFAULT '',
  auto_proto   INTEGER NOT NULL DEFAULT 1,
  aliases      TEXT NOT NULL DEFAULT '[]',
  http_port    INTEGER NOT NULL DEFAULT 7777,
  https_port   INTEGER NOT NULL DEFAULT 7443,
  updated_at   TEXT NOT NULL
);

CREATE TABLE domains_routes (
  id          TEXT PRIMARY KEY,
  host        TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  proto_id    TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  auto        INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX domains_routes_by_created ON domains_routes(created_at);

CREATE TABLE domains_checks (
  fqdn    TEXT PRIMARY KEY,
  ok      INTEGER NOT NULL,
  at      TEXT NOT NULL,
  message TEXT NOT NULL
);
