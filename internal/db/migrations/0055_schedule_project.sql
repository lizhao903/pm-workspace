-- 0055_schedule_project: 定时任务归到项目
--
-- project_id 是这条定时任务属于哪个项目（objects 里 type_id = project 的那一条），可空，空为不属于任何项目。
-- 用途：定时任务页按项目筛、项目详情的「定时任务」标签列出这个项目的；动作 task 到点建的任务也挂到这个项目。
-- 项目被彻底删除时置空；进回收站时保留（恢复后照旧）。

ALTER TABLE schedules ADD COLUMN project_id TEXT REFERENCES objects(id) ON DELETE SET NULL;

CREATE INDEX idx_schedules_project ON schedules(project_id);
