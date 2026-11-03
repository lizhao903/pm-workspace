-- 0001_stakeholders: 项目干系人（PJ-01b）
--
-- 一个项目里有哪些联系人、各自什么角色、关注什么。对照原型 web-next/src/projectdata.ts 的 Stakeholder。
-- 人用内核的干系人名册（stakeholders，CT-01a 起也是联系人），项目是 type=project 的对象，这里只存关联。
-- 一个人在一个项目里只有一个角色：同一对 (project_id, stakeholder_id) 只有一行，换角色就改这一行。
-- 角色五选一，和原型 STAKE_ROLE 一致；接口先校验，CHECK 兜底。
-- 删项目（硬删）或删联系人时关联行一起删：关联本身没有独立意义，和 object_participants 同一个取舍。
-- 软删项目不动这里，从回收站恢复后干系人还在。

CREATE TABLE projects_stakeholders (
  project_id     TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  stakeholder_id TEXT NOT NULL REFERENCES stakeholders(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('decider', 'contact', 'owner', 'member', 'informed')),
  focus          TEXT NOT NULL DEFAULT '',
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (project_id, stakeholder_id)
);

-- 联系人详情里要列出「他在哪些项目里」
CREATE INDEX projects_stakeholders_by_contact ON projects_stakeholders(stakeholder_id);
