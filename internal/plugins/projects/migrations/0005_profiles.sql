-- 0005_profiles: 项目档案（AUTO-04）
--
-- 给分类 Agent 和各 pipeline 用的项目信息，一个项目一行，没建过档案的项目没有行（读出来是空档案）。
-- 不放对象 props：props 的 PATCH 整体替换，和设置页边改边存会互相覆盖；目录、命令要在接口里校验。
--
-- 分类用：intro 简介、keywords 关键词、platforms 平台标签（web、桌面、云端……），后两个是 JSON 字符串数组。
-- 目录：code_dir 代码库、proto_dir 原型库、prd_dir PRD，本机绝对路径，保存时校验存在且是目录（软链跟过去看）；空串表示没设。
-- 命令：commands 是 JSON 对象，key 是 build、test、test_env、release、smoke、rollback，
--   值是 {command, dir, timeout_sec}：dir 相对代码库目录，timeout_sec 为 0 表示用执行方的默认值。本期只存不执行。
-- 人员：owner_ids 负责人、acceptor_ids 验收人员，JSON 联系人 id 数组（联系人是内核干系人名册）。
--   删联系人不级联清这里：读的时候按名册过滤掉已经不在的人。
-- 硬删项目时一起删；软删项目不动，同干系人、原型。

CREATE TABLE projects_profiles (
  project_id   TEXT PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
  intro        TEXT NOT NULL DEFAULT '',
  keywords     TEXT NOT NULL DEFAULT '[]',
  platforms    TEXT NOT NULL DEFAULT '[]',
  code_dir     TEXT NOT NULL DEFAULT '',
  proto_dir    TEXT NOT NULL DEFAULT '',
  prd_dir      TEXT NOT NULL DEFAULT '',
  commands     TEXT NOT NULL DEFAULT '{}',
  owner_ids    TEXT NOT NULL DEFAULT '[]',
  acceptor_ids TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
