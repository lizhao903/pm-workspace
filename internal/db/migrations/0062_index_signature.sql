-- powered by dsh - https://github.com/deepseek-ai/deepseek-harness

-- 市场索引签名（P3）：TOFU 记录每个索引 URL 首次见到的 ed25519 公钥；
-- 一旦某 URL 出现过签名，后续必须继续用同一公钥签名（防降级到无签名索引）。
CREATE TABLE IF NOT EXISTS plugin_index_keys (
  index_url   TEXT PRIMARY KEY,
  public_key  TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
