-- 0004: 未设色的分类继承最近有色祖先的颜色。
--
-- 0002 建默认分类树时只给了一级分类颜色，二级留空，导致侧栏树和列表行的分类色点
-- 在最常用的二级分类上反而是中性色。用物化路径回填：取路径前缀最长、且已设色的祖先。
--
-- 用 instr(child.path, ancestor.path) = 1 做前缀匹配而不是 LIKE：
-- slug 允许中文后也可能带 % 和 _，LIKE 会把它们当通配符。

UPDATE categories
SET color = COALESCE((
  SELECT a.color
  FROM categories a
  WHERE a.type_id = categories.type_id
    AND a.id <> categories.id
    AND a.color <> ''
    AND instr(categories.path, a.path) = 1
  ORDER BY LENGTH(a.path) DESC
  LIMIT 1
), color)
WHERE color = '';
