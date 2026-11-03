-- 0011_outbox: 主动发出的消息（群组管理里「发消息」、SOP 节点「发消息」）
--
-- 回复（im_replies）挂在某条收到的消息上；主动发的是发到一个会话里、不针对哪条消息，单独记在这里，
-- 群组管理里能按会话看「发出的消息」。发送失败也记一行（status=failed，error 是原因）。
-- source：manual 是界面上手动发的，sop 是 SOP 节点发的（run_id 是执行 id）。
-- 会话删了一起删；连接器删了不级联，connector_id 留着。

CREATE TABLE im_outbox (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  connector_id    TEXT NOT NULL DEFAULT '',
  adapter         TEXT NOT NULL DEFAULT '',
  text            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error           TEXT NOT NULL DEFAULT '',
  external_id     TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sop')),
  run_id          TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);

CREATE INDEX im_outbox_by_conversation ON im_outbox(conversation_id, created_at);
