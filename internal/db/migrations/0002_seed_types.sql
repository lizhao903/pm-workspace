-- 0002_seed_types: 内置 6 类工作对象 + 默认分类树

INSERT INTO object_types (id,name,plural,ref_prefix,icon,color,builtin,sort_order,statuses,created_at,updated_at) VALUES
 ('requirement','需求','需求池','REQ','target','#3b5bdb',1,10,
  '[{"key":"inbox","label":"待整理","color":"#868e96","terminal":false},{"key":"backlog","label":"需求池","color":"#495057","terminal":false},{"key":"planned","label":"已排期","color":"#1971c2","terminal":false},{"key":"doing","label":"进行中","color":"#e8590c","terminal":false},{"key":"done","label":"已上线","color":"#2b8a3e","terminal":true},{"key":"dropped","label":"已废弃","color":"#adb5bd","terminal":true}]',
  datetime('now'),datetime('now')),
 ('task','待办','待办事项','TSK','check','#e8590c',1,20,
  '[{"key":"todo","label":"未开工","color":"#868e96","terminal":false},{"key":"doing","label":"进行中","color":"#e8590c","terminal":false},{"key":"blocked","label":"受阻","color":"#c92a2a","terminal":false},{"key":"done","label":"已完成","color":"#2b8a3e","terminal":true},{"key":"cancelled","label":"已取消","color":"#adb5bd","terminal":true}]',
  datetime('now'),datetime('now')),
 ('project','项目','项目','PRJ','folder','#0c8599',1,30,
  '[{"key":"planning","label":"筹备中","color":"#868e96","terminal":false},{"key":"active","label":"进行中","color":"#0c8599","terminal":false},{"key":"paused","label":"已暂停","color":"#f08c00","terminal":false},{"key":"done","label":"已结项","color":"#2b8a3e","terminal":true}]',
  datetime('now'),datetime('now')),
 ('doc','文档','文档','DOC','file','#5f3dc4',1,40,
  '[{"key":"draft","label":"草稿","color":"#868e96","terminal":false},{"key":"review","label":"评审中","color":"#f08c00","terminal":false},{"key":"published","label":"已发布","color":"#2b8a3e","terminal":true},{"key":"archived","label":"已归档","color":"#adb5bd","terminal":true}]',
  datetime('now'),datetime('now')),
 ('resource','资源','资源','RES','link','#1098ad',1,50,
  '[{"key":"active","label":"可用","color":"#2b8a3e","terminal":false},{"key":"stale","label":"待复核","color":"#f08c00","terminal":false},{"key":"retired","label":"已下线","color":"#adb5bd","terminal":true}]',
  datetime('now'),datetime('now')),
 ('note','笔记','笔记','NOTE','pencil','#868e96',1,60,
  '[{"key":"open","label":"未处理","color":"#868e96","terminal":false},{"key":"processed","label":"已消化","color":"#2b8a3e","terminal":true}]',
  datetime('now'),datetime('now'));

INSERT INTO ref_counters (type_id,next_seq)
  SELECT id, 1 FROM object_types;

-- 默认分类树（可在界面里增删改）
INSERT INTO categories (id,type_id,parent_id,name,slug,path,depth,color,description,sort_order,created_at,updated_at) VALUES
 ('cat_req_prod','requirement',NULL,'产品功能','product','/product/',0,'#3b5bdb','',10,datetime('now'),datetime('now')),
 ('cat_req_tech','requirement',NULL,'技术优化','tech','/tech/',0,'#0c8599','',20,datetime('now'),datetime('now')),
 ('cat_req_ops','requirement',NULL,'运营支持','ops','/ops/',0,'#f08c00','',30,datetime('now'),datetime('now')),
 ('cat_req_comp','requirement',NULL,'合规风控','compliance','/compliance/',0,'#c92a2a','',40,datetime('now'),datetime('now')),
 ('cat_task_dev','task',NULL,'研发','dev','/dev/',0,'#3b5bdb','',10,datetime('now'),datetime('now')),
 ('cat_task_pm','task',NULL,'产品','pm','/pm/',0,'#e8590c','',20,datetime('now'),datetime('now')),
 ('cat_task_meet','task',NULL,'会议与沟通','meeting','/meeting/',0,'#5f3dc4','',30,datetime('now'),datetime('now')),
 ('cat_prj_inner','project',NULL,'内部项目','internal','/internal/',0,'#0c8599','',10,datetime('now'),datetime('now')),
 ('cat_prj_cust','project',NULL,'客户项目','customer','/customer/',0,'#2b8a3e','',20,datetime('now'),datetime('now')),
 ('cat_doc_prd','doc',NULL,'需求文档','prd','/prd/',0,'#3b5bdb','',10,datetime('now'),datetime('now')),
 ('cat_doc_tech','doc',NULL,'技术方案','tech','/tech/',0,'#0c8599','',20,datetime('now'),datetime('now')),
 ('cat_doc_meet','doc',NULL,'会议纪要','meeting','/meeting/',0,'#5f3dc4','',30,datetime('now'),datetime('now')),
 ('cat_doc_rev','doc',NULL,'复盘总结','review','/review/',0,'#f08c00','',40,datetime('now'),datetime('now')),
 ('cat_res_link','resource',NULL,'链接书签','bookmark','/bookmark/',0,'#1098ad','',10,datetime('now'),datetime('now')),
 ('cat_res_file','resource',NULL,'文件素材','file','/file/',0,'#5f3dc4','',20,datetime('now'),datetime('now')),
 ('cat_res_tool','resource',NULL,'工具账号','tool','/tool/',0,'#868e96','',30,datetime('now'),datetime('now')),
 ('cat_note_idea','note',NULL,'灵感','idea','/idea/',0,'#f08c00','',10,datetime('now'),datetime('now')),
 ('cat_note_log','note',NULL,'工作日志','log','/log/',0,'#868e96','',20,datetime('now'),datetime('now'));

-- 二级分类示例
INSERT INTO categories (id,type_id,parent_id,name,slug,path,depth,color,description,sort_order,created_at,updated_at) VALUES
 ('cat_req_prod_cloud','requirement','cat_req_prod','云端平台','cloud','/product/cloud/',1,'','',10,datetime('now'),datetime('now')),
 ('cat_req_prod_local','requirement','cat_req_prod','本地客户端','local','/product/local/',1,'','',20,datetime('now'),datetime('now')),
 ('cat_req_tech_perf','requirement','cat_req_tech','性能','perf','/tech/perf/',1,'','',10,datetime('now'),datetime('now')),
 ('cat_req_tech_debt','requirement','cat_req_tech','技术债','debt','/tech/debt/',1,'','',20,datetime('now'),datetime('now'));
