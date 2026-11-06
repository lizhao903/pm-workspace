-- 0051_stakeholder_ai: 名册里的「AI 成员」（TSK-0500）
--
-- 任务交给工作台 Agent、Claude Code、DeepSeek 执行时，负责人要能指向它们。负责人仍只指向名册
-- （objects.owner_id → stakeholders），不另开一种引用：负责人筛选、统计、MCP 按名字传 owner 都不用改。
-- 名册里为每个工作台 Agent、每种 CLI 各维护一条，由工作台自动建、改名、归档，用户不手工维护。
--
-- ai_kind：'' 是人；'agent' 是工作台 Agent，ai_ref 记 agents.id；'cli' 是命令行执行器，ai_ref 记
-- task_runs.harness 的取值（claude / deepseek）。同一 (ai_kind, ai_ref) 只能有一条。
-- 不加外键：Agent 删了，名册里那条归档保留，负责它的任务仍显示得出名字。

ALTER TABLE stakeholders ADD COLUMN ai_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE stakeholders ADD COLUMN ai_ref TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_stakeholders_ai ON stakeholders(ai_kind, ai_ref) WHERE ai_kind <> '';
