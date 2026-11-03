-- 0002_actions: 消息处理动作（IM-02a）
--
-- 对照原型 web-next/src/App.tsx 的 actOnMessage 和 data.ts 的 Reply。
-- adapter 是收这条消息的适配器 key，回复时按它找适配器；0002 之前收的为空串，回复时按渠道找。
-- task_id 是这条消息转成的任务（objects.id）。内核 links 只能连两个对象，消息不是对象，关联记在消息这一侧；
-- 不建外键（插件表不引用内核对象表，任务软删、彻底删除都不该连带消息），读的时候查任务还在不在。
-- task_ref 是任务的编号（TSK-0001），编号不会变，存一份省得列表逐条回查。
-- reply_error 是最近一次回复发送失败的原因，下一次发成功时清空。
-- snooze_until 0001 已有：status 仍是 pending，到点由插件后台任务清掉，消息回到待处理。

ALTER TABLE im_messages ADD COLUMN adapter TEXT NOT NULL DEFAULT '';
ALTER TABLE im_messages ADD COLUMN task_id TEXT;
ALTER TABLE im_messages ADD COLUMN task_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE im_messages ADD COLUMN reply_error TEXT NOT NULL DEFAULT '';

CREATE INDEX im_messages_by_snooze ON im_messages(snooze_until) WHERE snooze_until IS NOT NULL;
CREATE INDEX im_messages_by_task ON im_messages(task_id) WHERE task_id IS NOT NULL;

-- 回复：一条消息可以回多次，发送失败的也留一行（status=failed，error 是原因）。
-- external_id 是渠道回给的消息编号，失败时为空串。
CREATE TABLE im_replies (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES im_messages(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error        TEXT NOT NULL DEFAULT '',
  external_id  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

CREATE INDEX im_replies_by_message ON im_replies(message_id, created_at);
