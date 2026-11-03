-- 0007_conversation_projects: 群组默认归属的项目（IM 页按群组汇总）
--
-- 一个会话（内核会话表 conversations 的 id）最多一个默认项目；消息自己没归项目（im_messages.project_id 为空）时，
-- 读出来按所在会话的默认项目兜底，接口上 project_source 为 conversation。消息上手动或 SOP 设的归属优先。
-- 不复用项目插件的「绑定会话」（projects_conversations）：那是多对多（一个群可以出现在几个项目页里），
-- 而且本插件的 Store 只能读 im_ 前缀的表；这里是一对一的「这个群的消息默认算哪个项目」。
-- 删会话时一起删；project_id 不加外键（同 0006），项目删了（含软删）读的时候按没设处理。

CREATE TABLE im_conversation_projects (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- 按项目筛消息时要反查「哪些会话默认归这个项目」
CREATE INDEX im_conversation_projects_by_project ON im_conversation_projects(project_id);
