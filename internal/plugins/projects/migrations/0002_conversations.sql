-- 0002_conversations: 项目绑定的 IM 会话（PJ-02a）
--
-- 原型 web-next/src/projectdata.ts 的 ProjectChat 按「渠道 + 群名」或联系人认会话，改群名就断。
-- 这里按内核会话表（conversations，0028）的 id 绑：改群名、改渠道编号都不影响绑定。
-- 一个会话可以绑多个项目：同一个客户群、同一个对接人的私聊常常同时聊几个项目，原型里也是各项目各自绑。
-- 同一对 (project_id, conversation_id) 只有一行，重复绑定接口回 409。
-- 硬删项目或删会话时绑定一起删；软删项目不动，恢复后绑定还在。

CREATE TABLE projects_conversations (
  project_id      TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (project_id, conversation_id)
);

-- 会话详情里要列出「绑在哪些项目上」
CREATE INDEX projects_conversations_by_conversation ON projects_conversations(conversation_id);
