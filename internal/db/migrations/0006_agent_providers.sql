-- 0006_agent_providers: Agent 模型供应商接入点
--
-- 三种 kind：openai（含一切 /v1 兼容端点）、gemini、ollama（本地，不需要 key）。
--
-- 关于 api_key 存明文的取舍：这是一个单人本地工具，数据库文件就在用户自己的
-- 磁盘上（data/pm.db）。引入 keychain / 主密码 / KMS 会带来「密钥丢了整个库打不开」
-- 的运维负担，收益却只在「攻击者已经能读你的磁盘」这个前提下才成立——到那一步
-- 他也能读走 keychain 解密后的结果。所以这里有意存明文，把防线放在出口侧：
-- 所有读取路径（ListProviders / GetProvider / HTTP 响应）一律只返回脱敏串，
-- 明文只有 ProviderAPIKey 一个入口，且只给服务端调模型用。
-- 如果将来这个库要多人共享或同步到云端，这个取舍必须重做。
--
-- 不塞种子数据：供应商必须带用户自己的密钥才有意义，预置几条假的只会让
-- 「测试连接」全都红掉。

PRAGMA foreign_keys = ON;

CREATE TABLE agent_providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- openai | gemini | ollama
  base_url    TEXT NOT NULL DEFAULT '',   -- 留空时由 store 按 kind 补默认值
  model       TEXT NOT NULL DEFAULT '',
  api_key     TEXT NOT NULL DEFAULT '',   -- 明文，取舍见文件头
  enabled     INTEGER NOT NULL DEFAULT 1,
  is_default  INTEGER NOT NULL DEFAULT 0,
  extra       TEXT NOT NULL DEFAULT '{}', -- JSON，temperature / 组织 ID 之类
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 部分唯一索引：只约束 is_default=1 的行，保证全局至多一个默认供应商。
-- 写在库里而不是只靠应用层判断——先清后置的顺序一旦写错，这里会直接报冲突。
CREATE UNIQUE INDEX idx_agent_providers_default
  ON agent_providers(is_default) WHERE is_default = 1;

CREATE INDEX idx_agent_providers_created ON agent_providers(created_at);
