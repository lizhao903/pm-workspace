-- 0011_session_object: 给会话记上它属于哪个工作对象
--
-- 起因：详情抽屉里的「AI 助手」是对象内的对话，而 agent_sessions 原来是一张平表，
-- 没有归属。把会话列表原样搬进抽屉的话，用户在 TSK-0015 里会看到自己在底部
-- 对话框聊的无关内容，以及别的对象的对话——那不是「这条任务的历史」。
--
-- object_id 可空，NULL 表示全局会话（底部那个对话框建的）。不给它一个默认值、
-- 也不拆成两张表：两处的消息、产物、供应商快照完全同构，拆表等于把同一套读写
-- 逻辑写两遍，而它们唯一的差别就是这一列。
--
-- ON DELETE CASCADE：和 task_runs 同一个取舍。围绕一个工作对象展开的对话，
-- 脱离了那个对象就只剩一堆没有主语的文字，留着也查不到它在说什么。
-- 注意这只在**硬删**时触发；软删（回收站）不动关联，从回收站恢复回来对话还在。
--
-- 与 stakeholders 的 SET NULL 不同：那边删掉的是「谁负责」这条信息，工作对象还在；
-- 这边删掉的是对话所依附的主体本身。

PRAGMA foreign_keys = ON;

ALTER TABLE agent_sessions ADD COLUMN object_id TEXT REFERENCES objects(id) ON DELETE CASCADE;

-- 两个场景各自的读法：抽屉按 object_id 取一条对象的，底部对话框取 object_id IS NULL 的。
-- 两个都要「最近的在前」，所以 updated_at 跟在后面。
CREATE INDEX idx_agent_sessions_object ON agent_sessions(object_id, updated_at DESC);

-- 存量 3 条会话全部留在 object_id IS NULL：它们确实都是在底部对话框里聊的。
-- 不去猜测归属——从消息内容反推「这条大概在说 REQ-0012」只会猜错，
-- 而猜错的后果是用户在某个对象的历史里看到一段他没在那儿说过的话。
