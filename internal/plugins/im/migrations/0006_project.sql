-- 0006_project: 消息归到项目（来消息分流：项目消息归到项目）
--
-- project_id 是这条消息归到的项目（内核对象 id，type project），没归为空。
-- 不加外键：内核表不在本插件的前缀里；项目删了（含软删）接口上按没归处理，见 messages.go 的 fill。
-- 由 SOP 节点 im_set_project 或消息抽屉里手动设置；GET /api/im/messages?project_id= 按它筛。

ALTER TABLE im_messages ADD COLUMN project_id TEXT;

CREATE INDEX im_messages_by_project ON im_messages(project_id, sent_at) WHERE project_id IS NOT NULL;
