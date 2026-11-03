-- 0022_webhooks: Webhook 配置（TASK-02a）
--
-- 一行是一个 Webhook：外部系统往接收地址推 JSON，按映射规则取字段建任务。
-- 本迁移只存配置；收件、映射执行、去重和推送记录归 TASK-02b，需要时另加表或列。
--
-- token 是接收地址的最后一段，随机生成，唯一。
-- 接收密钥（算签名用）不在这张表里：明文加密存进保险箱 vault_secrets（kind=webhook），
-- 这里只存条目 id。不加外键：保险箱条目被单独删掉时 Webhook 还在，重新轮换密钥即可补上。
-- mapping 是 JSON：{title, desc, priority, assignee, due}，值是推送 JSON 里的路径。
-- defaults 是 JSON：{priority, assignee}。filter、dedupe 是一行表达式和一条路径，留空不生效。
-- sample 是编辑时的示例推送，原样保存。
-- created_at、updated_at 用定长毫秒 UTC（2006-01-02T15:04:05.000Z）。

CREATE TABLE webhooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  secret_id   TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  mapping     TEXT NOT NULL DEFAULT '{}',
  filter      TEXT NOT NULL DEFAULT '',
  dedupe      TEXT NOT NULL DEFAULT '',
  defaults    TEXT NOT NULL DEFAULT '{}',
  sample      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_webhooks_created ON webhooks(created_at);
