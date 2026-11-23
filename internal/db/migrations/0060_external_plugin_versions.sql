-- powered by dsh - https://github.com/deepseek-ai/deepseek-harness

-- 外部插件升级/回滚（P1-b）：external_plugins 保存上一版本，回滚时交换当前/上一版本。
-- 只加不改；老库升级后 previous_* 为空，表示没有可回滚版本。
ALTER TABLE external_plugins ADD COLUMN previous_version TEXT NOT NULL DEFAULT '';
ALTER TABLE external_plugins ADD COLUMN previous_install_dir TEXT NOT NULL DEFAULT '';
ALTER TABLE external_plugins ADD COLUMN previous_manifest TEXT NOT NULL DEFAULT '';
ALTER TABLE external_plugins ADD COLUMN previous_permissions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE external_plugins ADD COLUMN previous_granted TEXT NOT NULL DEFAULT '[]';
ALTER TABLE external_plugins ADD COLUMN previous_package_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE external_plugins ADD COLUMN previous_source_type TEXT NOT NULL DEFAULT '';
ALTER TABLE external_plugins ADD COLUMN previous_source_ref TEXT NOT NULL DEFAULT '';
