-- 0002_minutes: M4a 的纪要、候选和内置流程（0.2.0，见 docs/recording-transcription-design.md §13）。
--
-- recording_recordings 的 minutes_json / minutes_model 在 0001 已经建好，这里只补设置：
--   minutes_flow      自动生成纪要时发起的 SOP 流程（id 或名称，空串=插件内直连 Agent）
--   minutes_threshold 「高置信度」阈值，0–1，默认 0.7
--
-- recording_todos 从「M2 预留的幂等映射」扩成候选表：还有 task_id（0001 的列，保留不用），
-- 一条候选一行，kind 是 project / task / goal，status 是 pending / confirmed / ignored。
-- project_id / project_title 是候选匹配到的项目；object_id / object_ref 是确认后建出来的任务；
-- owner_name 是 AI 建议的负责人名字，due_at 是建议的截止时间；reason 是 AI 给候选的理由。
--
-- recording_flows 记本插件写进 SOP 的内置流程，写过一次就不再写，用户删了也不补回来；
-- 卸载时撤下没改过的再删这一行（同视频插件的 video_sop_templates）。
-- 时间用 RFC3339 UTC。

ALTER TABLE recording_settings ADD COLUMN minutes_flow TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_settings ADD COLUMN minutes_threshold REAL NOT NULL DEFAULT 0.7;

ALTER TABLE recording_todos ADD COLUMN kind TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_todos ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_todos ADD COLUMN detail TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_todos ADD COLUMN confidence REAL NOT NULL DEFAULT 0;
ALTER TABLE recording_todos ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE recording_todos ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_todos ADD COLUMN project_title TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_todos ADD COLUMN object_id TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_todos ADD COLUMN object_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_todos ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_todos ADD COLUMN owner_name TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_todos ADD COLUMN due_at TEXT NOT NULL DEFAULT '';
ALTER TABLE recording_todos ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

CREATE INDEX recording_todos_by_status ON recording_todos(recording_id, status);

CREATE TABLE recording_flows (
  flow_id      TEXT PRIMARY KEY,
  installed_at TEXT NOT NULL
);
