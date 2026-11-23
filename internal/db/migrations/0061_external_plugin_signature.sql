-- powered by dsh - https://github.com/deepseek-ai/deepseek-harness

-- 外部插件签名/信任（P2）：external_plugins 记录发布者与是否验签通过；
-- plugin_publisher_keys 是 TOFU 公钥表（publisher.id -> 首次见到的 ed25519 公钥）。
ALTER TABLE external_plugins ADD COLUMN publisher_id TEXT NOT NULL DEFAULT '';
ALTER TABLE external_plugins ADD COLUMN publisher_verified INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS plugin_publisher_keys (
  publisher_id TEXT PRIMARY KEY,
  public_key   TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL
);
