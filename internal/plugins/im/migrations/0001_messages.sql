-- 0001_messages: IM 消息（IM-01a）
--
-- 对照原型 web-next/src/data.ts 的 Message。原型按「渠道 + 群名」认会话、按 sender_id 扫联系人认人；
-- 这里会话指向内核会话表（conversations，0028）的 id，发送人指向 IM 身份（contact_identities，0027）的 id，不靠名字。
-- 消息到达时会话或身份还没登记的，id 留空，渠道里的编号照存（conversation_external_id、sender_external_id），
-- 读的时候再按编号补认；会话、身份删掉时 id 置空，消息本身保留。
--
-- external_id 是渠道里的消息编号，适配器保证同一渠道里唯一（Slack 用「频道 id:ts」）；重复到达靠唯一约束去重。
-- connector_id 是收这条消息的连接器（connectors，0029），不建外键：删连接器不删历史消息。
-- conversation_name、sender_name 是到达时的快照，会话、身份认上之后显示以内核为准。
-- status 三态和原型 MsgStatus 一致；snooze_until 给稍后提醒（IM-02），先留着列。
-- relevance 是「与我相关」的原因：me（@我）、all（@所有人）、dm（私聊），无关为空串，到达时算一次。
-- attachments 是附件元数据的 JSON 数组（原型 MsgAttachment），获取到本地归 IM-04。
-- 时间用定长毫秒 UTC（2006-01-02T15:04:05.000Z），字符串比较即时间比较。

CREATE TABLE im_messages (
  id                       TEXT PRIMARY KEY,
  channel                  TEXT NOT NULL,
  connector_id             TEXT NOT NULL DEFAULT '',
  external_id              TEXT NOT NULL,
  conversation_id          TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  conversation_external_id TEXT NOT NULL DEFAULT '',
  conversation_kind        TEXT NOT NULL DEFAULT 'group' CHECK (conversation_kind IN ('group', 'direct')),
  conversation_name        TEXT NOT NULL DEFAULT '',
  sender_identity_id       TEXT REFERENCES contact_identities(id) ON DELETE SET NULL,
  sender_external_id       TEXT NOT NULL,
  sender_name              TEXT NOT NULL DEFAULT '',
  text                     TEXT NOT NULL DEFAULT '',
  attachments              TEXT NOT NULL DEFAULT '[]',
  relevance                TEXT NOT NULL DEFAULT '' CHECK (relevance IN ('', 'me', 'all', 'dm')),
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'ignored')),
  is_read                  INTEGER NOT NULL DEFAULT 0,
  snooze_until             TEXT,
  sent_at                  TEXT NOT NULL,
  received_at              TEXT NOT NULL,
  UNIQUE (channel, external_id)
);

CREATE INDEX im_messages_by_time ON im_messages(sent_at);
CREATE INDEX im_messages_by_conversation ON im_messages(conversation_id, sent_at);
CREATE INDEX im_messages_by_conversation_external ON im_messages(channel, conversation_external_id);
CREATE INDEX im_messages_by_sender ON im_messages(sender_identity_id);

-- 拉取型适配器的进度：每个适配器一行，cursor 由适配器自己解释（Slack 的 oldest、Telegram 的 update_id）。
CREATE TABLE im_cursors (
  adapter     TEXT PRIMARY KEY,
  cursor      TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
);
