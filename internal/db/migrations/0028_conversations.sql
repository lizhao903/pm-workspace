-- 0028_conversations: 会话表（CT-02）
--
-- 原型 web-next/src/data.ts 的 Message.conversation 和 projectdata.ts 的 ProjectChat 都按「渠道 + 群名」认群，
-- 改群名后项目绑定、消息归属就断了。这里给群聊和私聊一个稳定 id：项目绑定（PJ-02）、消息（IM 插件）都指向 id，
-- 改名只改 name，id 和 (channel, external_id) 不变。
--
-- channel 是渠道 key（和 contact_identities.channel 同一套），不建外键也不约束取值。
-- external_id 是渠道里的会话编号（Slack channel id、飞书 chat_id、Telegram chat id……），同一渠道唯一。
-- kind 是 group（群聊、频道）或 direct（私聊）；列名不用 type，避免和关键字混。
-- name 是群名或频道名，私聊可空。
-- created_at、updated_at 用定长毫秒 UTC（2006-01-02T15:04:05.000Z）。

CREATE TABLE conversations (
  id           TEXT PRIMARY KEY,
  channel      TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('group', 'direct')),
  name         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (channel, external_id)
);

-- 成员单独一张表，不存 JSON：要按身份反查他在哪些会话里，身份删除（含联系人删除时级联）时成员关系跟着删，
-- 不留指向不存在身份的 id。会话删除时成员一并删。
CREATE TABLE conversation_members (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  identity_id      TEXT NOT NULL REFERENCES contact_identities(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (conversation_id, identity_id)
);

CREATE INDEX idx_conversation_members_identity ON conversation_members(identity_id);
