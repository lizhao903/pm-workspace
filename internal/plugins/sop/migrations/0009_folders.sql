-- 0009_folders: 流程库的文件夹（TSK-0482，插件 0.15.0）
--
-- sop_folders 是一级文件夹，不分层；name 去首尾空白后 1 到 30 字，不分大小写唯一。id 前缀 sfd。
-- sop_flows.folder_id 是流程所在的文件夹，NULL 是「未分类」。删文件夹时插件先把里面的流程置回 NULL 再删文件夹，
-- 不靠外键（ALTER TABLE ADD COLUMN 加不了带动作的外键）；读到指向不存在文件夹的 folder_id 时按未分类处理。
--
-- 已有流程迁移后都是未分类。按名字前缀「xxx · 」自动建文件夹并归入不在这里做（插件迁移只许 CREATE TABLE、
-- CREATE INDEX、ALTER TABLE ADD COLUMN，不许 UPDATE），由插件后台任务 folder_seed 在启用时做一次，
-- 做完在 sop_settings 记 folders_seeded，之后不再做；规则见 docs/api-contract.md「SOP 编排插件 sop」的「文件夹」。

CREATE TABLE sop_folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX sop_folders_name ON sop_folders (name COLLATE NOCASE);

ALTER TABLE sop_flows ADD COLUMN folder_id TEXT;

CREATE INDEX sop_flows_folder ON sop_flows (folder_id);
