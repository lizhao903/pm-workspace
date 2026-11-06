-- 0016_name_lookups: 群组管理「查询回填」回渠道查名字的记录（TSK-0494）
--
-- 群组管理里只显示渠道编号（Slack 的 U…、C…）的行，点「查询回填」回渠道查人名（users.info）、会话名（conversations.info），
-- 查到的写回 im_messages 里空着的 sender_name、conversation_name；这里记每个编号查的结果，查到的 name 非空，
-- 查不到的 code、message 是原因（机器人没权限、对方不在这个工作区等），批量回填时跳过已经查不到的，免得每次都重复查。
-- kind：user 是发信人，conversation 是会话。时间用定长毫秒 UTC，同 0001。

CREATE TABLE im_name_lookups (
  channel     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('user', 'conversation')),
  external_id TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  code        TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT '',
  checked_at  TEXT NOT NULL,
  PRIMARY KEY (channel, kind, external_id)
);

CREATE INDEX im_messages_by_sender_external ON im_messages(channel, sender_external_id);
