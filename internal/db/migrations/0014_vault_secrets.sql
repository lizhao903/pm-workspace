-- 0014_vault_secrets: 凭证保险箱，存连接器配置、API Key、Webhook 密钥等的密文
--
-- 只存 AES-256-GCM 密文和脱敏提示，明文不落库。主密钥不在库里：
-- macOS 优先放系统钥匙串，取不到退回数据目录下 0600 的 vault.key（见 internal/vault）。
--
-- key_id 是主密钥的指纹（sha256 前 8 字节）。主密钥换了（钥匙串被清、密钥文件丢了）
-- 时解密会失败，有它才能说清「是密钥不对」而不是「数据坏了」。
--
-- version 每次轮换加一，和 id 一起作为 GCM 的附加数据：把一行的密文挪到另一行、
-- 或用旧版本的密文覆盖回来，解密都会失败。
--
-- 全量导出（/api/admin/export）不含这张表。

CREATE TABLE vault_secrets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'api_key',
  hint        TEXT NOT NULL DEFAULT '',
  key_id      TEXT NOT NULL,
  nonce       BLOB NOT NULL,
  ciphertext  BLOB NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  rotated_at  TEXT
);
