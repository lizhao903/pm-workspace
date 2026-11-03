-- 0003_attachments: 消息附件下载到本地（IM-04a）
--
-- 对照原型 web-next/src/data.ts 的 MsgAttachment：附件元数据仍在 im_messages.attachments（渠道给的，原样存），
-- 获取状态和本地路径是插件自己的，单独一张表，读消息时叠到对应附件上（fetch、local、error）。
-- 没有行就是未获取（idle）；status 只有 done（已获取）、error（失败，error 是原因）两种，下载在请求里同步做完，不存「获取中」。
-- attachment_id 是附件在消息里的 id（MsgAttachment.id），到达时没给的由插件补成 att_ 开头。
-- local_path 是本机绝对路径：数据目录下 attachments/<渠道>/<文件名>，同一个文件只属于一个附件。
-- 消息删了行一起删；本机文件不删（文件可能已经加进项目资料）。

CREATE TABLE im_attachments (
  message_id    TEXT NOT NULL REFERENCES im_messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('done', 'error')),
  local_path    TEXT NOT NULL DEFAULT '',
  size          INTEGER,
  error         TEXT NOT NULL DEFAULT '',
  fetched_at    TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (message_id, attachment_id),
  CHECK (status <> 'done' OR local_path <> '')
);

CREATE UNIQUE INDEX im_attachments_by_path ON im_attachments(local_path) WHERE local_path <> '';
