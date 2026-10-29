-- 0041_enum_dicts: 联系人分组、IM 消息状态两本内置字典（PR-13，走查 A-05）
--
-- 前端早就按 contact_group、msg_status 读字典，后端没有时用内置值兜底，所以设置里改不了。
-- 这里按兜底值原样种进去，界面上看到的不变，只是能在「设置 / 枚举值」里改名、换色、停用了。
-- 任务状态（object_types.statuses）和文档分类（categories）本来就有自己的表，不另建字典。
--
-- 联系人分组的 key 就是显示名（stakeholders.contact_group 存的是名字，多个用「、」连），
-- 只种规格里的内置五组；导入时带进来的分组（Octok 这类）照旧按原值显示。
-- 「其他」是没填分组时的默认组，标 meta.default。
-- IM 消息状态三个 key 是 im_messages.status 的 CHECK 约束定死的，只能改名和颜色。
-- 不用 INSERT OR IGNORE：重复应用要报错（cmd/pmw 的迁移失败测试靠它）。

INSERT INTO dictionaries (id,name,description,scope,builtin,sort_order,created_at,updated_at) VALUES
 ('contact_group','联系人分组','联系人的分组筛选和分组标签，落在 stakeholders.contact_group','global',1,50,datetime('now'),datetime('now')),
 ('msg_status','IM 消息状态','IM 消息的处理状态，落在 im_messages.status。三个都是系统值','global',1,60,datetime('now'),datetime('now'));

INSERT INTO dict_items (id,dict_id,type_id,key,label,color,description,sort_order,meta,archived_at,created_at,updated_at) VALUES
 ('dit_grp_customer','contact_group',NULL,'客户','客户','#3d4fd6','',10,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_grp_partner','contact_group',NULL,'合作伙伴','合作伙伴','#0c8599','',20,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_grp_colleague','contact_group',NULL,'同事','同事','#e8590c','',30,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_grp_vendor','contact_group',NULL,'供应商','供应商','#7048e8','',40,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_grp_other','contact_group',NULL,'其他','其他','#868e96','没填分组的联系人也算在这里',50,'{"default":true}',NULL,datetime('now'),datetime('now'));

INSERT INTO dict_items (id,dict_id,type_id,key,label,color,description,sort_order,meta,archived_at,created_at,updated_at) VALUES
 ('dit_msg_pending','msg_status',NULL,'pending','待处理','#b0570b','收到后还没处理',10,'{"default":true}',NULL,datetime('now'),datetime('now')),
 ('dit_msg_done','msg_status',NULL,'done','已处理','#2f7d43','回复过或标了已处理',20,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_msg_ignored','msg_status',NULL,'ignored','已忽略','#a19d92','不用处理，不再提醒',30,'{}',NULL,datetime('now'),datetime('now'));

-- 任务状态的说明（Status.description，JSON 里的可选字段）：照原型 enumdata 的 task_status，
-- 加上原型没有的「受阻」（走查 A-08）。json_insert 只补没有的，用户写过的不动；按 json_each 原顺序拼回。
UPDATE object_types SET statuses = (
  SELECT json_group_array(
    CASE json_extract(value, '$.key')
      WHEN 'review' THEN json_insert(value, '$.description', '做完了等人验收，验收通过再改成已完成')
      WHEN 'blocked' THEN json_insert(value, '$.description', '卡住了，不算结束，算未完成')
      WHEN 'done' THEN json_insert(value, '$.description', '算作完成，不再提示逾期')
      WHEN 'cancelled' THEN json_insert(value, '$.description', '不算完成也不算逾期')
      ELSE json(value)
    END)
  FROM (SELECT value FROM json_each(object_types.statuses) ORDER BY key)
), updated_at = datetime('now')
WHERE id = 'task' AND json_valid(statuses);
