-- 0015_provider_key_vault: 模型服务商的 api_key 改放凭证保险箱
--
-- api_key_secret_id 指向 vault_secrets.id，空串表示没有密钥。不加外键：
-- 保险箱条目可以从 /api/secrets 单独删掉，那时这一行按「未配置密钥」处理。
--
-- 明文搬进保险箱要用主密钥加密，SQL 里做不了，放在启动流程里
-- （sqlite.Store.AttachVault）：逐行加密写进保险箱，再把旧的 api_key 列清成空串。
-- api_key 列保留不删，只是之后不再写入明文。

ALTER TABLE agent_providers ADD COLUMN api_key_secret_id TEXT NOT NULL DEFAULT '';
