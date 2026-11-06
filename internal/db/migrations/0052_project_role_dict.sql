-- 0052_project_role_dict: 项目干系人角色走枚举字典（TSK-0718）
--
-- 角色原来写死在前端 PROJECT_ROLES 和项目插件的 Roles 白名单里，设置里改不了。
-- 这里按原值种进字典：key 不变（projects_stakeholders.role 存的就是 key），已有数据不迁移即可对上；
-- 显示名、说明照原来的常量，界面上看到的不变，只是能在「设置 / 枚举值」里改名、换色、停用、排序、加新角色。
-- 「参与」是新加干系人的默认角色，标 meta.default。
-- 引用数统计插件表 projects_stakeholders（插件没装时按 0 算），被用着的角色只能停用不能删。
-- 不用 INSERT OR IGNORE：重复应用要报错（cmd/pmw 的迁移失败测试靠它）。

INSERT INTO dictionaries (id,name,description,scope,builtin,sort_order,created_at,updated_at) VALUES
 ('project_role','项目干系人角色','项目干系人的角色，落在项目插件的 projects_stakeholders.role','global',1,70,datetime('now'),datetime('now'));

INSERT INTO dict_items (id,dict_id,type_id,key,label,color,description,sort_order,meta,archived_at,created_at,updated_at) VALUES
 ('dit_role_decider','project_role',NULL,'decider','决策人','#c0352b','拍板、验收',10,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_role_contact','project_role',NULL,'contact','对接人','#3d4fd6','日常沟通、需求来源',20,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_role_owner','project_role',NULL,'owner','负责人','#e8590c','我方交付负责',30,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_role_member','project_role',NULL,'member','参与','#0c8599','一起做事',40,'{"default":true}',NULL,datetime('now'),datetime('now')),
 ('dit_role_informed','project_role',NULL,'informed','知会','#a19d92','有进展告诉他就行',50,'{}',NULL,datetime('now'),datetime('now'));
