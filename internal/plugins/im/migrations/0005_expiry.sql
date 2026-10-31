-- 0005_expiry: 超过期限没处理的消息记为已过期（IM-07）
--
-- expired_at 是被标成已过期的时间；只对 status = 'pending' 的有意义，接口把「待处理且 expired_at 非空」显示为 expired。
-- 不改 status 的 CHECK：那要重建 im_messages，而 im_replies、im_attachments 外键级联到它，重建时会被连带删掉。
-- 处理完、忽略、改回待处理时清空；已读不动。
-- expire_from 是从什么时候起算过期，空时按 sent_at；改回待处理时设成当时，免得刚改回来下一轮又被标过期。
-- im_settings 是本插件的设置，一项一行；expire_days 是多少天没处理算过期，0 为不过期，没有这一行时按 7 天。

ALTER TABLE im_messages ADD COLUMN expired_at TEXT;
ALTER TABLE im_messages ADD COLUMN expire_from TEXT;

CREATE TABLE im_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
