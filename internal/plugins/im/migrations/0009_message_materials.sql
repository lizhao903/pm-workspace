-- 0009_message_materials: 消息转成的项目资料（IM 消息页「转项目资料」、附件「加入资料」）
--
-- 资料本身在项目插件的 projects_materials 里（插件之间不能互读表），这里只记「哪条资料来自哪些消息」：
-- im_material_sources 一条资料一行，记登记时的来源快照（渠道、会话、发信人、时间），消息以后被清理了资料上照样能说清出处；
-- im_material_messages 是资料和消息的对应（一组消息转成一条资料时每条消息一行），消息上显示「已转资料」靠它反查。
-- kind：messages 是消息正文拼成的笔记；attachment 是消息附件加进资料（attachment_id 是附件 id）。
-- 项目硬删时一起删（外键级联）；资料在项目里被移除时由前端调 DELETE 清掉；消息删了不级联，来源快照留着。

CREATE TABLE im_material_sources (
  material_id     TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'messages' CHECK (kind IN ('messages', 'attachment')),
  attachment_id   TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL DEFAULT '',
  channel         TEXT NOT NULL DEFAULT '',
  conversation_id TEXT,
  conversation    TEXT NOT NULL DEFAULT '',
  senders         TEXT NOT NULL DEFAULT '[]',
  first_at        TEXT NOT NULL,
  last_at         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX im_material_sources_by_project ON im_material_sources(project_id, created_at);

CREATE TABLE im_material_messages (
  material_id TEXT NOT NULL REFERENCES im_material_sources(material_id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,
  PRIMARY KEY (material_id, message_id)
);

CREATE INDEX im_material_messages_by_message ON im_material_messages(message_id);
