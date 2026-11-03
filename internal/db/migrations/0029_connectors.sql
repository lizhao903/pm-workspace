-- 0029_connectors: 连接器实例（CONN-01a）
--
-- 一行是一个接入的连接器，对应原型 web-next/src/data.ts 的 Connector。连接器的定义（认证方式、
-- 配置表单、工具清单、连通测试）在代码里注册（internal/connector），不进库；tool 是定义的 key，
-- 不建外键：定义由插件提供时插件停用后实例还在，只是不可用。
-- 一个工具只接一个账号，由代码查重，不建唯一索引（以后要放宽不必删索引）。
--
-- status：connected / connecting / error / paused / disconnected，同原型 ConnStatus；error 是最近一次失败的说明。
-- auth_mode：none / oauth2 / token，取值必须是定义支持的。
-- config 是 JSON：非凭证字段 {key: value}。凭证字段整组 JSON 加密存进保险箱 vault_secrets（kind=connector），
-- 这里只存条目 id 和每个字段的脱敏提示 secret_hints {key: hint}；不加外键，同 webhooks。
-- tools 是 JSON：[{name, desc, write, mode}]，mode 为 off / confirm / auto；tools_at 是最近一次拉取工具清单的时间。
-- direction：receive / both；interval 是同步间隔（分钟），0 表示不定时同步。
-- 时间列用定长毫秒 UTC（2006-01-02T15:04:05.000Z），没有时为 NULL。

CREATE TABLE connectors (
  id              TEXT PRIMARY KEY,
  tool            TEXT NOT NULL,
  name            TEXT NOT NULL,
  account         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'connecting',
  error           TEXT NOT NULL DEFAULT '',
  auth_mode       TEXT NOT NULL DEFAULT 'none',
  config          TEXT NOT NULL DEFAULT '{}',
  secret_id       TEXT NOT NULL DEFAULT '',
  secret_hints    TEXT NOT NULL DEFAULT '{}',
  direction       TEXT NOT NULL DEFAULT 'receive',
  interval        INTEGER NOT NULL DEFAULT 0,
  tools           TEXT NOT NULL DEFAULT '[]',
  tools_at        TEXT,
  last_tested_at  TEXT,
  last_sync_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_connectors_tool ON connectors(tool);
