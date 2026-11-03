-- 0010_threads: Slack 串里的回复（在串里回复、没勾「同时发送到频道」的那种）
--
-- 串里的回复照普通消息落在 im_messages，多记它属于哪个串：
-- thread_parent_external_id 是父消息的 external_id（Slack 是「频道 id:父消息 ts」），不是串里回复的为空串；
-- 父消息在库里时读的时候按 (channel, external_id) 认出来（parent_message_id），不在库里（我自己发起的串、早于第一次拉取的）
-- 也能显示「回复 谁：说了什么」，所以另存到达时的快照：thread_parent_sender 父消息发信人、thread_parent_text 父消息正文前 80 字。
-- 拉取进度（每个串拉到哪条回复）在 im_cursors 的 Slack 进度里，不另建表。

ALTER TABLE im_messages ADD COLUMN thread_parent_external_id TEXT NOT NULL DEFAULT '';
ALTER TABLE im_messages ADD COLUMN thread_parent_sender TEXT NOT NULL DEFAULT '';
ALTER TABLE im_messages ADD COLUMN thread_parent_text TEXT NOT NULL DEFAULT '';

CREATE INDEX im_messages_by_thread ON im_messages(channel, thread_parent_external_id) WHERE thread_parent_external_id <> '';
