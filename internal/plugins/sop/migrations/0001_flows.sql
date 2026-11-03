-- 0001_flows: SOP 流程定义（SOP-01a）
--
-- 对照原型 web-next/src/sopflow.ts 的 Sop。fields、steps、layout 存 JSON，形状和原型一致，
-- 保存前由插件校验（步骤 key 唯一、依赖存在且无环、分支指向判断节点、必填配置项），校验口径见 flows.go。
-- 原型的 desc、trigger 列名改成 description、trigger_desc（避开 SQL 关键字）。
-- layout 是编排画布上的节点位置，没有就是 NULL，前端按依赖自动排。
-- version 从 1 起，每次修改加 1；执行时拿定义快照（SOP-01b），进行中的运行不受后来的修改影响。
-- 时间用 RFC3339 UTC。

CREATE TABLE sop_flows (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  trigger_desc TEXT NOT NULL DEFAULT '',
  fields       TEXT NOT NULL DEFAULT '[]',
  steps        TEXT NOT NULL DEFAULT '[]',
  layout       TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX sop_flows_by_created ON sop_flows(created_at);
