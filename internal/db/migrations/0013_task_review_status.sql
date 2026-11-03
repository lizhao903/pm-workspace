-- 0013_task_review_status: 待办类型加「待验收」状态（review，非终态）
-- 开发任务闭环里 Claude Code 做完提交验收，状态切到这里，由人验收后再改成已完成
-- 只加不改：已经有 review 的（用户在设置里自己加过）不动；内置状态集还在时插在「进行中」后面，否则追加到末尾

UPDATE object_types
SET statuses = replace(statuses,
      '{"key":"blocked"',
      '{"key":"review","label":"待验收","color":"#7048e8","terminal":false},{"key":"blocked"'),
    updated_at = datetime('now')
WHERE id = 'task'
  AND statuses NOT LIKE '%"key":"review"%'
  AND statuses LIKE '%{"key":"doing",%{"key":"blocked"%';

UPDATE object_types
SET statuses = json_insert(statuses, '$[#]', json('{"key":"review","label":"待验收","color":"#7048e8","terminal":false}')),
    updated_at = datetime('now')
WHERE id = 'task'
  AND statuses NOT LIKE '%"key":"review"%';
