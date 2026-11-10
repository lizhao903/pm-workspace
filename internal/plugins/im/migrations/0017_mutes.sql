-- 0017_mutes: 自动忽略发信人（TSK-0495）
--
-- im_mutes 一行是一条「自动忽略」：这个发信人之后收到的消息入库即「已忽略」、已读，不发 im.message_received
-- （所以不触发 SOP 的 IM 流程、Agent 的 IM 触发，消息页也不提醒）。
-- kind：sender 按渠道身份（channel + sender_external_id，Slack 的用户、机器人编号，Telegram 的编号）；
--       contact 按联系人（stakeholder_id，名下全部 IM 身份一起生效，按收消息时认上的联系人算）。
-- conversation_id 空串是全部会话，非空是只在这个会话（内核 conversations.id）里忽略此人。
-- name 是标记时的显示名快照（机器人名、联系人名），消息详情里「因发信人 X 被设为自动忽略」用它。
-- stakeholder_id、conversation_id 不建外键：联系人、会话删了这条照留，列表里标出来，用户自己取消。
--
-- im_messages.muted_by 是把这条消息自动忽略掉的那条 im_mutes.id（标记时一并忽略的已有消息也记），muted_name 是当时的 name；
-- 取消标记不清它们（已被自动忽略的消息不自动恢复），消息被改回待处理或标为已处理时清空。
-- 时间用定长毫秒 UTC，同 0001。

CREATE TABLE im_mutes (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('sender', 'contact')),
  channel            TEXT NOT NULL DEFAULT '',
  sender_external_id TEXT NOT NULL DEFAULT '',
  stakeholder_id     TEXT NOT NULL DEFAULT '',
  conversation_id    TEXT NOT NULL DEFAULT '',
  name               TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL,
  CHECK ((kind = 'sender' AND channel <> '' AND sender_external_id <> '' AND stakeholder_id = '')
      OR (kind = 'contact' AND stakeholder_id <> '' AND channel = '' AND sender_external_id = ''))
);

CREATE UNIQUE INDEX im_mutes_target ON im_mutes(kind, channel, sender_external_id, stakeholder_id, conversation_id);

ALTER TABLE im_messages ADD COLUMN muted_by TEXT NOT NULL DEFAULT '';
ALTER TABLE im_messages ADD COLUMN muted_name TEXT NOT NULL DEFAULT '';

CREATE INDEX im_messages_by_muted ON im_messages(muted_by) WHERE muted_by <> '';
