-- 0042_task_type_name: 内置任务类型的显示名从「待办」改成「任务」（PR-20，走查 T-04）
--
-- 界面上一直叫「任务」，只有 /api/object-types 和 MCP 的 pmw_list_types 还是「待办」。
-- 只动 name、plural，不动 key（task）和前缀（TSK）；名字已经不是内置原名的（手工改过）不动。

UPDATE object_types SET name = '任务', updated_at = datetime('now')
WHERE id = 'task' AND name = '待办';

UPDATE object_types SET plural = '任务', updated_at = datetime('now')
WHERE id = 'task' AND plural = '待办事项';
