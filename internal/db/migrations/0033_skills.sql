-- 0033_skills: 自定义技能（AG-01b2）
--
-- 一行是一个自定义技能，对应原型 web-next/src/agentdata.ts 的 Skill，id 前缀 sk。
-- 内置技能写在代码里（internal/agent），插件技能由插件 Register 时登记，都不进这张表。
-- 原型的 desc、when 是 SQL 关键字，列名用 description、when_to_use，接口里仍叫 desc、when。
-- uses 是工具名的 JSON 数组，只是说明，不校验。
-- Agent 挂载技能存在 agents.skills（0032），删除技能时由代码从里面摘掉，不建外键。
-- 时间列用定长毫秒 UTC（2006-01-02T15:04:05.000Z）。

CREATE TABLE skills (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  instructions  TEXT NOT NULL,
  when_to_use   TEXT NOT NULL DEFAULT '',
  uses          TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
