-- 0008_message_sessions: 从消息发起的 Agent 会话、会话里拆出来的任务（IM 消息页「发起会话」「拆分任务」）
--
-- im_message_sessions：一次发起可以带一组消息（列表上合并显示的一组：同一个私聊、同一人连发、重复消息），
-- 组里每条消息各记一行，都指向同一个会话。intent 是发起时的意图：chat 发起会话 / split 拆分任务。
-- 会话是内核 agent_sessions，删会话时一起删（外键级联），消息上的「已发起会话」跟着消失。
--
-- im_message_tasks：会话里 Agent 建的任务，props.source_ref 指向消息（内核 0047：会话来源记进新建对象），
-- 插件订阅 object.created 时记下来，消息上显示「已拆分 N 条任务」。转任务（task_id）建的那一条也会记进来，读的时候排除。
-- 任务硬删时一起删；软删的读的时候跳过。

CREATE TABLE im_message_sessions (
  message_id TEXT NOT NULL REFERENCES im_messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  intent     TEXT NOT NULL DEFAULT 'chat',
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, session_id)
);

CREATE INDEX im_message_sessions_by_session ON im_message_sessions(session_id);

CREATE TABLE im_message_tasks (
  message_id TEXT NOT NULL REFERENCES im_messages(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, task_id)
);

CREATE INDEX im_message_tasks_by_task ON im_message_tasks(task_id);
