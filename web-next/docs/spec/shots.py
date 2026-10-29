#!/usr/bin/env python3
"""更新规格包截图：调 scripts/smoke-proto.py 把原型逐页截一遍，按模块分到 shots/<模块 key>/；
再按本文件 STEPS 里写好的步骤截抽屉、弹窗这类点进去才看得到的界面。

用法（在仓库根目录）：
  /opt/miniconda3/bin/python web-next/docs/spec/shots.py [--url http://127.0.0.1:7778] [--only tasks,today]
      [--widths 375,1440] [--themes light,dark] [--step-widths 1440] [--no-steps] [--no-shrink]

- 只读原型：不启动、不重启；原型没在跑就提示后退出，已有截图不动。
- 先截到临时目录，跑完再替换 shots/ 下对应模块的 png；--only 只替换列出的模块。
- 文件名：<页面>-<宽度>-<主题>.png，页面是冒烟脚本记下的位置去掉模块名，模块入口记为「入口」。
- 默认把截图压成 256 色 png（体积约三分之一）；要原图加 --no-shrink。
- 冒烟有问题（退出码 1）时照常更新截图，但把问题打出来，退出码也是 1。
- 按步骤截的图和菜单截图放在同一个模块目录，文件名同样是 <名字>-<宽度>-<主题>.png；某个模块的步骤跑失败时，
  这个模块的截图整组不替换（避免只剩一半），退出码 1。宽度默认只截 1440，--step-widths 可以加 375。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
SMOKE = os.path.join(ROOT, 'scripts', 'smoke-proto.py')
MODULES_FILE = os.path.join(ROOT, 'web-next', 'src', 'workspacedata.ts')
SHOTS = os.path.join(HERE, 'shots')
# 冒烟脚本里不在 MODULES 里的一级位置
EXTRA = {'设置': 'settings'}
# 首页就是默认工作台的「今日」，不单独留
SKIP = ('首页',)
NAME = re.compile(r'^(\d+)-(light|dark)-(.+)\.png$')


def safe_name(s):
    # 和 smoke-proto.py 的 safe_name 保持一致
    return re.sub(r'[\\/:*?"<>|\s]+', '_', s).strip('_') or 'x'


def modules():
    """中文名 -> 模块 key，从原型的 MODULES 读。"""
    src = open(MODULES_FILE, encoding='utf-8').read()
    block = re.search(r'export const MODULES[^=]*=\s*\[(.*?)\n\]', src, re.S)
    if not block:
        sys.exit('没在 workspacedata.ts 里找到 MODULES，原型结构变了，先改本脚本')
    pairs = re.findall(r"key:\s*'([^']+)',\s*label:\s*'([^']+)'", block.group(1))
    m = {safe_name(label): key for key, label in pairs}
    m.update({safe_name(k): v for k, v in EXTRA.items()})
    return m


def split(where, labels):
    """「任务_全部任务」-> ('tasks', '全部任务')；长名字先匹配，避免前缀撞车。"""
    for label in sorted(labels, key=len, reverse=True):
        if where == label:
            return labels[label], '入口'
        if where.startswith(label + '_'):
            return labels[label], where[len(label) + 1:]
    return None, where


def shrink(path):
    from PIL import Image
    with Image.open(path) as im:
        q = im.convert('RGB').quantize(256, method=Image.Quantize.FASTOCTREE)
    q.save(path, 'PNG', optimize=True)


# ---------- 按步骤截图 ----------
# 每个模块一组步骤函数 flow(pg, shot)：pg 是已打开原型首页、清过本地数据、设好主题的页面，
# shot(名字) 截一张整页图。步骤改了原型状态不要紧，每个函数都在全新的浏览器上下文里跑。

def _menu(pg, label):
    pg.locator('.side-item, .side a, .side button', has_text=label).first.click()
    pg.wait_for_timeout(400)


def tasks_devloop(pg, shot):
    """任务抽屉的开发闭环区块、交给 Claude Code 弹窗、列表完成圆圈确认（SPEC-tasks-5、SPEC-tasks-6）。"""
    _menu(pg, '任务')
    pg.locator('.task-row', has_text='T-015').click(); pg.wait_for_timeout(400)
    dr = pg.locator('aside.drawer'); body = dr.locator('.drawer-body')
    shot('抽屉_待验收')
    dr.locator('.dev-sec').nth(0).evaluate('e => e.scrollIntoView({ block: "start" })'); pg.wait_for_timeout(150)
    shot('抽屉_进展')
    dr.locator('.dev-run-head').nth(1).click(); pg.wait_for_timeout(150)
    dr.locator('.dev-sec').nth(1).evaluate('e => e.scrollIntoView({ block: "start" })'); pg.wait_for_timeout(150)
    shot('抽屉_产出物和执行记录')
    body.evaluate('e => { e.scrollTop = 0 }')
    dr.locator('button', has_text='退回').first.click(); pg.wait_for_timeout(150)
    dr.locator('.dev-reviewbar textarea').focus()
    shot('抽屉_退回')
    dr.locator('.dev-review-form button', has_text='取消').click()
    dr.locator('button', has_text='交给 Claude Code').click(); pg.wait_for_timeout(200)
    dlg = pg.locator('[role=dialog]')
    shot('交给_Claude_Code')
    dlg.locator('input[type=checkbox]').click(); pg.wait_for_timeout(150)
    shot('交给_Claude_Code_允许写入确认')
    dlg.locator('button', has_text='算了，只读').click()
    dlg.locator('textarea').fill('先别改，看看界面上的超时还有没有别的地方写死')
    dlg.locator('.btn-primary').click(); pg.wait_for_timeout(2600)
    dr.locator('.dev-run.open').first.evaluate('e => e.scrollIntoView({ block: "center" })'); pg.wait_for_timeout(100)
    shot('抽屉_执行中')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
    pg.locator('.task-row', has_text='T-017').locator('.task-check').click(); pg.wait_for_timeout(200)
    shot('待验收_完成圆圈确认')


def tasks_unsaved(pg, shot):
    """任务抽屉有未保存的改动时关闭（SPEC-tasks-4.23）。"""
    _menu(pg, '任务')
    pg.locator('.task-row', has_text='T-014').click(); pg.wait_for_timeout(400)
    dr = pg.locator('aside.drawer')
    dr.locator('.field input').first.fill('确认演示环境能不能打开自定义角色页')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(150)
    shot('抽屉_未保存确认')


def tasks_schedule(pg, shot):
    """定时任务抽屉，执行记录里的任务编号可点（SPEC-tasks-8）。"""
    _menu(pg, '任务')
    pg.locator('.subnav button, .subnav a, .subnav-item', has_text='定时任务').first.click(); pg.wait_for_timeout(300)
    pg.locator('.sched-row', has_text='周会前整理议程').first.click(); pg.wait_for_timeout(300)
    pg.locator('aside.drawer .sched-history').evaluate('e => e.scrollIntoView({ block: "center" })'); pg.wait_for_timeout(100)
    shot('定时任务抽屉')


def _open_msg(pg, who, text=''):
    row = pg.locator('.msg', has_text=who)
    if text:
        row = row.filter(has_text=text)
    row.first.click(); pg.wait_for_timeout(300)


def messages_drawer(pg, shot):
    """消息抽屉：附件、连接器异常、只收消息、已转任务（SPEC-messages-2、SPEC-messages-3）。"""
    _menu(pg, 'IM 消息')
    _open_msg(pg, '林予安', '权限点清单')
    shot('抽屉_附件')
    _open_msg(pg, '唐一苇')
    shot('抽屉_连接异常')
    _open_msg(pg, '许知行', '@所有人')
    shot('抽屉_只收消息和已转任务')


def messages_fetch_paused(pg, shot):
    """连接器暂停时获取附件，失败原因按连接器状态说（SPEC-messages-3.5）。"""
    _menu(pg, 'IM 消息')
    pg.locator('button', has_text='渠道配置').first.click(); pg.wait_for_timeout(400)
    pg.locator('.conn-row', has_text='公司 Slack').first.click(); pg.wait_for_timeout(300)
    dr = pg.locator('aside.drawer')
    dr.locator('input.switch').last.uncheck()
    dr.locator('.drawer-foot .btn-primary').click(); pg.wait_for_timeout(300)
    _menu(pg, 'IM 消息')
    _open_msg(pg, 'Kevin Wu', '导出按钮')
    pg.locator('aside.drawer .att-row button', has_text='获取').first.click(); pg.wait_for_timeout(1200)
    shot('抽屉_附件获取失败')


def _project(pg, name, tab):
    _menu(pg, '项目')
    pg.locator('.pl-card', has_text=name).first.click(); pg.wait_for_timeout(300)
    pg.locator('.project-tabs button', has_text=tab).first.click(); pg.wait_for_timeout(300)


def projects_task_confirm(pg, shot):
    """项目任务标签里点待验收任务的完成圆圈，先弹确认（SPEC-projects-7.5）。"""
    _project(pg, '产品工作台新版', '任务')
    pg.locator('.pt-task', has_text='T-015').locator('.task-check').click(); pg.wait_for_timeout(200)
    shot('任务_待验收确认')


def projects_comms(pg, shot):
    """沟通标签：附件逐个决定、绑定面板（SPEC-projects-4、SPEC-projects-5）。"""
    _project(pg, '产品工作台新版', '沟通')
    pg.locator('.att-inbox button', has_text='逐个决定').click(); pg.wait_for_timeout(200)
    shot('沟通_附件逐个决定')
    pg.locator('.pt-chats .mount-head button', has_text='绑定').click(); pg.wait_for_timeout(200)
    shot('沟通_绑定')


def projects_dock(pg, shot):
    """标题行的终端、浏览器：在底部展开项目自己的终端和浏览器（SPEC-projects-14）。"""
    _project(pg, '产品工作台新版', '概览')
    btns = pg.locator('.tb-actions .pdock-btn')
    btns.nth(0).click(); pg.wait_for_timeout(200)
    pg.locator('.pdock .term-input').first.fill('ls'); pg.keyboard.press('Enter'); pg.wait_for_timeout(150)
    shot('终端和浏览器_终端')
    btns.nth(1).click(); pg.wait_for_timeout(600)
    shot('终端和浏览器_浏览器')



def _side(pg, label):
    # 只认一级菜单项：「会话」会撞上侧栏顶部的「新建会话」
    pg.locator('.side-item', has_text=label).first.click(); pg.wait_for_timeout(400)


def _sub(pg, label):
    pg.locator('.subnav-item', has_text=label).first.click(); pg.wait_for_timeout(300)


def _toggle_agent(pg, name):
    _side(pg, '设置'); _sub(pg, 'Agent')
    pg.locator('.agent-card', has_text=name).locator('.switch-line').click(); pg.wait_for_timeout(200)


def _new_chat(pg, agent, text):
    _side(pg, '会话')
    pg.locator('.subnav-new').click(); pg.wait_for_timeout(200)
    pg.locator('.agent-pick .menu-item', has_text=agent).click(); pg.wait_for_timeout(300)
    pg.locator('.ai-box textarea').fill(text); pg.keyboard.press('Meta+Enter'); pg.wait_for_timeout(1300)


def sessions_agent_off(pg, shot):
    """会话的 Agent 已停用、已删除时只能回看（SPEC-sessions-1.26、SPEC-sessions-1.27）。"""
    _toggle_agent(pg, '消息分诊助手')
    _side(pg, '会话')
    pg.locator('.chat-item', has_text='今天谁找我了').click(); pg.wait_for_timeout(300)
    shot('会话_Agent已停用')
    _toggle_agent(pg, '流程执行助手')
    _new_chat(pg, '流程执行助手', '你好，你能做什么')
    _side(pg, '设置'); _sub(pg, 'Agent')
    pg.locator('.agent-card', has_text='流程执行助手').click(); pg.wait_for_timeout(300)
    pg.locator('button.btn-danger-ghost', has_text='删除').click(); pg.wait_for_timeout(150)
    pg.locator('button.btn-danger', has_text='删除').click(); pg.wait_for_timeout(300)
    _side(pg, '会话')
    pg.locator('.chat-item', has_text='你好，你能做什么').click(); pg.wait_for_timeout(300)
    shot('会话_Agent已删除')


def sessions_perm(pg, shot):
    """权限没开时，回复指向设置 / Agent / 工具与权限（SPEC-sessions-1.18）。"""
    _new_chat(pg, '周报助手', '梁晚晴找我了吗，帮我回复一下')
    shot('会话_权限没开')


def sessions_outputs(pg, shot):
    """产出的目标已删除、来源跳到执行记录那一条（SPEC-sessions-3.5、SPEC-sessions-3.11）。"""
    _side(pg, '任务')
    pg.locator('.task-row', has_text='T-014').click(); pg.wait_for_timeout(300)
    dr = pg.locator('aside.drawer')
    dr.locator('button', has_text='删除任务').click(); dr.locator('.btn-danger', has_text='删除').click(); pg.wait_for_timeout(300)
    _side(pg, '会话'); _sub(pg, '产出结果')
    pg.locator('.output-row', has_text='确认演示环境').first.locator('.output-title .link-btn').click(); pg.wait_for_timeout(200)
    shot('产出结果_目标已删除')
    pg.locator('.output-row', has_text='第 43 周周报').filter(has_text='执行记录').locator('.output-origin button').click(); pg.wait_for_timeout(700)
    shot('执行记录_定位到那一条')


def _settings(pg, label):
    _side(pg, '设置'); _sub(pg, label)


def _row(pg, name):
    pg.locator('.conn-row', has_text=name).first.click(); pg.wait_for_timeout(300)


def _esc(pg):
    pg.keyboard.press('Escape'); pg.wait_for_timeout(200)


def settings_workspace(pg, shot):
    """工作台与模块：模板卡片、左上角切换菜单、删除确认（SPEC-settings-2）。"""
    _settings(pg, '工作台与模块')
    pg.locator('button', has_text='新建工作台').click(); pg.wait_for_timeout(200)
    shot('工作台与模块_模板')
    pg.locator('button', has_text='新建工作台').click(); pg.wait_for_timeout(150)
    pg.locator('button', has_text='删除工作台').click(); pg.wait_for_timeout(150)
    shot('工作台与模块_删除确认')
    pg.locator('.brand-btn').click(); pg.wait_for_timeout(200)
    shot('工作台切换菜单')


def settings_im_drawer(pg, shot):
    """即时通讯连接器抽屉：已连接、异常、新建，列表上断开确认（SPEC-settings-3.9、SPEC-settings-4）。"""
    _settings(pg, '连接器')
    pg.locator('.conn-row', has_text='公司 Slack').locator('button', has_text='断开').click(); pg.wait_for_timeout(150)
    pg.locator('.conn-row', has_text='公司 Slack').evaluate('e => e.scrollIntoView({ block: "center" })'); pg.wait_for_timeout(100)
    shot('连接器_断开确认')
    pg.locator('.conn-row', has_text='公司 Slack').locator('button', has_text='取消').click(); pg.wait_for_timeout(100)
    _row(pg, '公司 Slack')
    shot('即时通讯抽屉_已连接')
    _esc(pg); _row(pg, '企业微信')
    shot('即时通讯抽屉_异常')
    _esc(pg)
    pg.locator('.tool-card', has_text='QQ').locator('button', has_text='接入').click(); pg.wait_for_timeout(300)
    pg.locator('aside.drawer .drawer-foot .btn-primary').click(); pg.wait_for_timeout(150)
    shot('即时通讯抽屉_新建没填')


def settings_app_drawer(pg, shot):
    """应用与 API 连接器抽屉：OAuth 已授权、授权过期、Token、自定义 MCP（SPEC-settings-5）。"""
    _settings(pg, '连接器')
    _row(pg, '公司 GitHub')
    shot('应用连接器抽屉_OAuth')
    _esc(pg); _row(pg, 'Notion 产品空间')
    shot('应用连接器抽屉_授权过期')
    _esc(pg); _row(pg, '视频号数据')
    shot('应用连接器抽屉_Token')
    _esc(pg)
    pg.locator('.tool-card', has_text='MCP 服务').locator('button', has_text='接入').click(); pg.wait_for_timeout(300)
    shot('应用连接器抽屉_自定义')


def settings_provider_drawer(pg, shot):
    """模型服务商抽屉：正常、异常、本地、手填模型 ID（SPEC-settings-7）。"""
    _settings(pg, '模型服务商')
    for name, f in (('Anthropic', '服务商抽屉_正常'), ('OpenAI', '服务商抽屉_异常'), ('本机 Ollama', '服务商抽屉_本地')):
        pg.locator('.pv-card', has_text=name).first.click(); pg.wait_for_timeout(300)
        shot(f)
        _esc(pg)
    pg.locator('.pv-card-add', has_text='自定义').first.click(); pg.wait_for_timeout(300)
    pg.locator('aside.drawer .field input').first.fill('')
    pg.locator('aside.drawer .drawer-foot .btn-primary').click(); pg.wait_for_timeout(150)
    shot('服务商抽屉_自定义没填')


def settings_agent_editor(pg, shot):
    """Agent 配置页：基本信息、工具与权限、知识库、未保存确认、新建（SPEC-settings-9）。"""
    _settings(pg, 'Agent')
    pg.locator('.agent-card', has_text='消息分诊助手').click(); pg.wait_for_timeout(300)
    tab = lambda t: (pg.locator('.ae-tabs button', has_text=t).click(), pg.wait_for_timeout(200))
    tab('基本信息')
    shot('Agent配置页_基本信息')
    tab('工具与权限')
    shot('Agent配置页_工具与权限')
    tab('知识库')
    shot('Agent配置页_知识库')
    tab('基本信息')
    pg.locator('.agent-desc-input').fill('新 IM 消息先看一遍，认出是谁、要不要转任务')
    pg.locator('.editor-head button', has_text='Agent').click(); pg.wait_for_timeout(200)
    shot('Agent配置页_未保存确认')
    pg.locator('.ae-foot button', has_text='放弃修改').click(); pg.wait_for_timeout(300)
    pg.locator('button', has_text='新建 Agent').click(); pg.wait_for_timeout(300)
    shot('Agent配置页_新建')


def settings_agent_model_off(pg, shot):
    """模型不可用：停用 Anthropic 后打开用它模型的 Agent（SPEC-settings-9.11）。"""
    _settings(pg, '模型服务商')
    pg.locator('.pv-card', has_text='Anthropic').first.click(); pg.wait_for_timeout(300)
    pg.locator('aside.drawer .switch-row').last.locator('.switch').click()
    pg.locator('aside.drawer .drawer-foot .btn-primary').click(); pg.wait_for_timeout(300)
    _sub(pg, 'Agent')
    pg.locator('.agent-card', has_text='消息分诊助手').click(); pg.wait_for_timeout(300)
    pg.locator('.ae-tabs button', has_text='模型').click(); pg.wait_for_timeout(200)
    shot('Agent配置页_模型不可用')


def settings_kb(pg, shot):
    """知识库详情三个标签、阅读视图、加文档，知识库抽屉（SPEC-settings-11 到 SPEC-settings-14）。"""
    _settings(pg, '知识库')
    pg.locator('button', has_text='新建知识库').click(); pg.wait_for_timeout(300)
    shot('知识库抽屉_新建')
    _esc(pg)
    pg.locator('.kb-card', has_text='产品文档库').click(); pg.wait_for_timeout(300)
    shot('知识库详情_文档')
    pg.locator('.kbx-title').first.click(); pg.wait_for_timeout(300)
    shot('知识库详情_阅读')
    pg.locator('.project-tabs button', has_text='文档').click(); pg.wait_for_timeout(200)
    pg.locator('button', has_text='加文档').click(); pg.wait_for_timeout(300)
    shot('知识库详情_加文档')
    pg.locator('.project-tabs button', has_text='检索测试').click(); pg.wait_for_timeout(200)
    pg.locator('.kbx-samples .chip', has_text='权限变更').first.click(); pg.wait_for_timeout(300)
    shot('知识库详情_检索测试')
    pg.locator('.project-tabs button', has_text='设置').click(); pg.wait_for_timeout(200)
    shot('知识库详情_设置')
    pg.locator('button', has_text='改名称和分类').click(); pg.wait_for_timeout(300)
    shot('知识库抽屉_编辑')


def settings_skill(pg, shot):
    """技能抽屉：内置只读、自定义、复制一份（SPEC-settings-16）。"""
    _settings(pg, '技能')
    pg.locator('.skill-row', has_text='写周报').click(); pg.wait_for_timeout(300)
    shot('技能抽屉_内置')
    pg.locator('aside.drawer button', has_text='复制一份来改').click(); pg.wait_for_timeout(300)
    shot('技能抽屉_复制')
    _esc(pg)
    pg.locator('.skill-row', has_text='业务数据查询').click(); pg.wait_for_timeout(300)
    shot('技能抽屉_自定义')


def settings_incident(pg, shot):
    """运行异常抽屉：未处理、转任务、已解决（SPEC-settings-19）。"""
    _settings(pg, '运行异常')
    pg.locator('.inc-row', has_text='企业微信连接器凭证失效').first.click(); pg.wait_for_timeout(300)
    shot('运行异常抽屉')
    pg.locator('aside.drawer button', has_text='转为研发任务').click(); pg.wait_for_timeout(200)
    shot('运行异常抽屉_转任务')
    _esc(pg)
    # 演示数据里没有已解决的，先把「交易账户异常」标为已解决
    pg.locator('.inc-row', has_text='交易账户异常').first.click(); pg.wait_for_timeout(300)
    pg.locator('aside.drawer button', has_text='标为已解决').last.click(); pg.wait_for_timeout(200)
    pg.locator('.seg button', has_text='已解决').first.click(); pg.wait_for_timeout(200)
    pg.locator('.inc-row', has_text='交易账户异常').first.click(); pg.wait_for_timeout(300)
    shot('运行异常抽屉_已解决')


def settings_misc(pg, shot):
    """枚举值新建、内网域名加域名和 HTTPS 提示（SPEC-settings-17、SPEC-settings-20）。"""
    _settings(pg, '枚举值')
    pg.locator('.enum-list button', has_text='新建枚举').click(); pg.wait_for_timeout(200)
    shot('枚举值_新建')
    _sub(pg, '内网域名')
    pg.locator('.dm-routes button', has_text='加一个').click(); pg.wait_for_timeout(200)
    pg.locator('.switch-row', has_text='HTTPS').locator('.switch').click(); pg.wait_for_timeout(150)
    shot('内网域名_加域名和HTTPS')


def _sop_run(pg, title):
    """从执行记录打开一次执行；已在运行页时先返回。"""
    if pg.locator('.run-back').count():
        pg.locator('.run-back').click(); pg.wait_for_timeout(200)
    pg.locator('.run-row', has_text=title).first.click(); pg.wait_for_timeout(400)


def _sop_flow(pg, name):
    _side(pg, 'SOP'); _sub(pg, '流程库')
    pg.locator('.sop-lib-card', has_text=name).first.click(); pg.wait_for_timeout(300)


def sop_run(pg, shot):
    """运行页：检查、改输出、退回、并行、人工判断、失败、日志、未走此分支（SPEC-sop-7）。"""
    _side(pg, 'SOP')
    _sop_run(pg, '客户反馈转需求 · 梁晚晴')
    shot('运行页_待检查')
    ins = pg.locator('.inspector')
    ins.locator('.insp-banner button', has_text='修改输出').click(); pg.wait_for_timeout(150)
    ins.locator('.io-edit textarea').fill('{ "demands": ')
    ins.locator('.insp-banner button', has_text='保存修改并放行').click(); pg.wait_for_timeout(150)
    shot('运行页_改输出格式不对')
    ins.locator('.insp-banner button', has_text='取消修改').click(); pg.wait_for_timeout(100)
    ins.locator('.insp-banner button', has_text='退回').click(); pg.wait_for_timeout(150)
    shot('运行页_退回重做')
    pg.wait_for_timeout(1500)
    pg.locator('.inspector .insp-banner button', has_text='通过，继续执行').click(); pg.wait_for_timeout(1500)
    shot('运行页_并行执行中')
    _sop_run(pg, '联系人建档 · 梁晚晴')
    shot('运行页_人工判断')
    _sop_run(pg, '客户反馈转需求 · 许知行')
    shot('运行页_失败')
    pg.locator('.insp-tabs button', has_text='日志').click(); pg.wait_for_timeout(150)
    shot('运行页_日志')
    _sop_run(pg, '联系人建档 · 何嘉宁')
    pg.locator('.fnode', has_text='合并字段').click(); pg.wait_for_timeout(300)
    shot('运行页_已完成_未走此分支')


sop_run.widths = (375, 1440)


def sop_start(pg, shot):
    """流程详情删除拦截、发起执行抽屉、逐步确认、改输入、终止（SPEC-sop-5、SPEC-sop-6、SPEC-sop-7）。"""
    _sop_flow(pg, '客户反馈转需求')
    pg.locator('button.btn-danger-ghost', has_text='删除').click(); pg.wait_for_timeout(150)
    shot('流程详情_不能删除')
    # 手机宽度下确认条会把按钮挤出屏幕（原型问题，已记进 sop.md），换个流程打开就收起了
    _sop_flow(pg, '周会纪要整理')
    pg.locator('button.btn-primary', has_text='执行').first.evaluate('e => e.click()'); pg.wait_for_timeout(300)
    dr = pg.locator('aside.drawer')
    shot('发起执行')
    dr.locator('.field', has_text='会议').locator('input').fill('')
    dr.locator('.drawer-foot .btn-primary').click(); pg.wait_for_timeout(150)
    shot('发起执行_必填没填')
    dr.locator('.field', has_text='会议').locator('input').fill('产品周会 10/30')
    dr.locator('.check input[type=checkbox]').check()
    dr.locator('.drawer-foot .btn-primary').click(); pg.wait_for_timeout(400)
    shot('运行页_执行前暂停')
    ins = pg.locator('.inspector')
    ins.locator('.insp-banner button', has_text='修改输入').click(); pg.wait_for_timeout(150)
    shot('运行页_改输入')
    ins.locator('.insp-banner button', has_text='取消修改').click(); pg.wait_for_timeout(100)
    ins.locator('.insp-banner button', has_text='确认并执行').click(); pg.wait_for_timeout(1300)
    shot('运行页_多个步骤待确认')
    pg.locator('button', has_text='终止执行').first.evaluate('e => e.click()'); pg.wait_for_timeout(300)
    shot('运行页_已终止')


sop_start.widths = (375, 1440)


def sop_editor_entry(pg, shot):
    """编排页入口、开始节点属性、节点选择器，窄屏下手动打开 AI 协助（SPEC-sop-8 到 SPEC-sop-11）。"""
    _side(pg, 'SOP'); _sub(pg, '流程库')
    pg.locator('.subnav-new').first.evaluate('e => e.click()'); pg.wait_for_timeout(500)
    shot('编辑器_新建')
    if not pg.locator('.ai-panel').count():
        pg.locator('.cv-empty button', has_text='让 AI 帮我建').click(); pg.wait_for_timeout(300)
        shot('AI协助_打开')
    # 编排页没有二级菜单，先点左上角返回
    pg.locator('.cv-top-left .icon-btn').first.evaluate('e => e.click()'); pg.wait_for_timeout(300)
    _sop_flow(pg, '客户反馈转需求')
    pg.locator('button.btn-outline', has_text='编辑').click(); pg.wait_for_timeout(600)
    shot('编辑器_编辑')
    pg.locator('.cv-node[data-node="__start"] .cv-node-head').click(); pg.wait_for_timeout(300)
    shot('编辑器_开始节点属性')
    pg.locator('.node-panel .np-add').first.click(); pg.wait_for_timeout(200)
    shot('编辑器_节点选择器')


sop_editor_entry.widths = (375, 1440)


def sop_editor_new(pg, shot):
    """新建：发布时校验、AI 拆步骤的提案和应用、必填配置（SPEC-sop-8、SPEC-sop-9、SPEC-sop-10）。"""
    _side(pg, 'SOP'); _sub(pg, '流程库')
    pg.locator('.subnav-new').first.evaluate('e => e.click()'); pg.wait_for_timeout(500)
    pg.locator('.cv-top-right .btn-primary', has_text='发布').click(); pg.wait_for_timeout(200)
    shot('编辑器_发布没填')
    pg.locator('.cv-top-right .menu-wrap > button').click(); pg.wait_for_timeout(100)
    pg.locator('.ai-example').first.click(); pg.wait_for_timeout(1100)
    shot('AI协助_提案')
    pg.locator('.ai-proposal button', has_text='应用到流程').click(); pg.wait_for_timeout(600)
    shot('AI协助_已应用')
    pg.locator('.cv-node[data-node="__start"] .cv-handle').click(); pg.wait_for_timeout(200)
    pg.locator('.palette input').fill('HTTP'); pg.wait_for_timeout(100)
    pg.locator('.palette-item', has_text='HTTP 请求').click(); pg.wait_for_timeout(400)
    pg.locator('.cv-top-right .btn-primary').click(); pg.wait_for_timeout(200)
    pg.locator('.cv-top-right .menu-wrap > button').click(); pg.wait_for_timeout(100)
    shot('编辑器_必填配置没填')


def sop_editor_edit(pg, shot):
    """编辑已有流程：分支节点、普通节点属性、上次运行、检查结果（SPEC-sop-8、SPEC-sop-9）。"""
    _sop_flow(pg, '客户反馈转需求')
    pg.locator('button.btn-outline', has_text='编辑').click(); pg.wait_for_timeout(600)
    pg.locator('.cv-node', has_text='判断反馈类型').locator('.cv-node-head').click(); pg.wait_for_timeout(300)
    shot('编辑器_分支节点属性')
    pg.locator('.cv-node', has_text='AI 提炼诉求').locator('.cv-node-head').click(); pg.wait_for_timeout(300)
    shot('编辑器_节点属性')
    pg.locator('.np-tabs button', has_text='上次运行').click(); pg.wait_for_timeout(200)
    shot('编辑器_上次运行')
    pg.locator('.cv-top-right .menu-wrap > button').click(); pg.wait_for_timeout(150)
    shot('编辑器_检查')


def _term_run(pg, cmd):
    pg.locator('.term-pane.focus .term-input').fill(cmd); pg.keyboard.press('Enter'); pg.wait_for_timeout(150)


def _term_split(pg, title):
    pg.locator('.term-pane.focus .term-btn[title="%s"]' % title).click(); pg.wait_for_timeout(200)


def terminal_split(pg, shot):
    """拆成 2x2、焦点格、命令输出和报错、多标签和改名（SPEC-terminal-1、SPEC-terminal-2）。"""
    _side(pg, '终端')
    _term_run(pg, 'ls')
    _term_split(pg, '向右拆分'); _term_run(pg, 'git status')
    _term_split(pg, '向下拆分'); _term_run(pg, 'npm run dev')
    _term_split(pg, '向右拆分'); _term_run(pg, 'help')
    shot('2x2分屏')
    pg.locator('.term-tab-add').click(); pg.wait_for_timeout(200)
    pg.locator('.term-tab').first.dblclick(); pg.wait_for_timeout(150)
    pg.locator('.term-tab-input').fill('原型调试')
    shot('多标签和改名')


terminal_split.widths = (375, 1440)


def terminal_proto(pg, shot):
    """在原型目录里 npm run dev 启动原型、Ctrl+C 停止（SPEC-terminal-2）。"""
    _side(pg, '终端')
    _term_run(pg, 'cd docs')
    _term_run(pg, 'npm run dev'); pg.wait_for_timeout(1600)
    shot('运行原型')
    pg.locator('.term-pane.focus .term-input').press('Control+c'); pg.wait_for_timeout(900)
    _term_run(pg, 'history')
    shot('停止原型和历史')


terminal_proto.widths = (375, 1440)


def _br_go(pg, addr):
    pg.locator('.br-addr input').fill(addr); pg.keyboard.press('Enter'); pg.wait_for_timeout(300)


def browser_tabs(pg, shot):
    """原型没运行、原型标签、网页标签的嵌入提示、标签右键菜单（SPEC-browser-1、SPEC-browser-3）。"""
    _side(pg, '浏览器')
    _br_go(pg, '7790')
    shot('原型没在运行')
    pg.locator('.br-tab-add').click(); pg.wait_for_timeout(200)
    pg.locator('.br-proto', has_text='新版前端原型').locator('button', has_text='打开').click(); pg.wait_for_timeout(2500)
    shot('原型标签')
    pg.locator('.br-tab-add').click(); pg.wait_for_timeout(200)
    _br_go(pg, 'example.com'); pg.wait_for_timeout(2500)
    shot('网页_嵌入提示')
    pg.locator('.br-tab').first.click(button='right'); pg.wait_for_timeout(150)
    shot('标签右键菜单')


browser_tabs.widths = (375, 1440)


def browser_google(pg, shot):
    """Google 登录、授权范围、账号面板、Drive 没登录和没授权（SPEC-browser-4、SPEC-browser-5）。"""
    _side(pg, '浏览器')
    _br_go(pg, 'drive.google.com/drive/my-drive')
    shot('Drive_没登录')
    pg.locator('.br-login-btn').click(); pg.wait_for_timeout(200)
    shot('登录_选择账号')
    md = pg.locator('.br-modal')
    md.locator('.br-acc-pick', has_text='使用其他账号').click(); pg.wait_for_timeout(100)
    md.locator('input').fill('chen.yi')
    md.locator('button[type=submit]').click(); pg.wait_for_timeout(100)
    shot('登录_邮箱不对')
    md.locator('button', has_text='返回').click(); pg.wait_for_timeout(100)
    md.locator('.br-acc-pick').first.click(); pg.wait_for_timeout(150)
    md.locator('.br-scope', has_text='drive.readonly').locator('input').uncheck()
    shot('登录_授权范围')
    md.locator('.btn-primary', has_text='允许').click(); pg.wait_for_timeout(1300)
    shot('Drive_没授权')
    pg.locator('.br-acc').click(); pg.wait_for_timeout(150)
    shot('账号面板')


browser_google.widths = (375, 1440)


def browser_drive(pg, shot):
    """原型里模拟的 Drive 文件浏览和预览，正式版不搬（SPEC-browser-5）。"""
    _side(pg, '浏览器')
    pg.locator('.br-drive-guest button', has_text='登录 Google').click(); pg.wait_for_timeout(200)
    pg.locator('.br-modal .br-acc-pick').first.click(); pg.wait_for_timeout(150)
    pg.locator('.br-modal .btn-primary', has_text='允许').click(); pg.wait_for_timeout(1300)
    pg.locator('.br-drive-link', has_text='我的云端硬盘').click(); pg.wait_for_timeout(300)
    shot('Drive_文件浏览')
    pg.locator('.br-frow', has_text='2027 产品路线图').click(); pg.wait_for_timeout(300)
    shot('Drive_文件预览')


browser_drive.widths = (375, 1440)


STEPS = {
    'tasks': [tasks_devloop, tasks_unsaved, tasks_schedule],
    'messages': [messages_drawer, messages_fetch_paused],
    'projects': [projects_task_confirm, projects_comms, projects_dock],
    'sessions': [sessions_agent_off, sessions_perm, sessions_outputs],
    'settings': [settings_workspace, settings_im_drawer, settings_app_drawer, settings_provider_drawer, settings_agent_editor,
                 settings_agent_model_off, settings_kb, settings_skill, settings_incident, settings_misc],
    'sop': [sop_run, sop_start, sop_editor_entry, sop_editor_new, sop_editor_edit],
    'terminal': [terminal_split, terminal_proto],
    'browser': [browser_tabs, browser_google, browser_drive],
}


def run_steps(url, out, widths, themes, keys):
    """按 STEPS 截图到 out。返回 {模块: [(文件路径, 规格包里的文件名)]} 和跑失败的模块。"""
    from playwright.sync_api import sync_playwright
    got, failed = {}, {}
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome')
        try:
            for key in keys:
                for flow in STEPS.get(key, []):
                    # 步骤函数可以用 widths 属性指定自己的宽度，比如 SOP 运行页也要手机宽度
                    for w in getattr(flow, 'widths', widths):
                        for theme in themes:
                            ctx = browser.new_context(viewport={'width': w, 'height': 900}, color_scheme=theme)
                            pg = ctx.new_page()

                            def shot(name, pg=pg, w=w, theme=theme):
                                f = f'{name}-{w}-{theme}.png'
                                path = os.path.join(out, f)
                                pg.screenshot(path=path)
                                got.setdefault(key, []).append((path, f))
                            try:
                                pg.goto(url)
                                pg.evaluate("t => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('pmw-next-theme', t) }", theme)
                                pg.goto(url); pg.wait_for_timeout(700)
                                flow(pg, shot)
                            except Exception as e:  # noqa: BLE001 步骤跑不通就记下来，别的模块照常
                                failed.setdefault(key, []).append(f'{flow.__name__} {w} {theme}：{str(e).splitlines()[0][:200]}')
                            finally:
                                ctx.close()
        finally:
            browser.close()
    return got, failed


def main():
    ap = argparse.ArgumentParser(description='更新规格包截图')
    ap.add_argument('--url', default=os.environ.get('PROTO_URL', 'http://127.0.0.1:7778'))
    ap.add_argument('--only', help='只更新这些模块，逗号分隔的模块 key，如 tasks,today')
    ap.add_argument('--widths', default='375,1440', help='手机和桌面宽度')
    ap.add_argument('--themes', default='light,dark')
    ap.add_argument('--step-widths', default='1440', help='按步骤截图用的宽度')
    ap.add_argument('--no-steps', action='store_true', help='只截菜单，不按步骤截抽屉和弹窗（会删掉已有的步骤截图）')
    ap.add_argument('--no-shrink', action='store_true', help='不压缩，保留原图')
    a = ap.parse_args()

    labels = modules()
    keys = set(labels.values())
    only = {x.strip() for x in a.only.split(',') if x.strip()} if a.only else None
    if only and only - keys:
        sys.exit(f'没有这些模块：{"、".join(sorted(only - keys))}；可用的是 {"、".join(sorted(keys))}')

    tmp = tempfile.mkdtemp(prefix='spec-shots-')
    try:
        cmd = [sys.executable, SMOKE, '--url', a.url, '--out', tmp, '--widths', a.widths, '--themes', a.themes]
        code = subprocess.run(cmd, cwd=ROOT).returncode
        if code not in (0, 1):
            print('冒烟脚本没跑起来，已有截图没动')
            return code

        picked, unknown = {}, []
        for f in sorted(os.listdir(tmp)):
            m = NAME.match(f)
            if not m:
                continue
            width, theme, where = m.groups()
            if where in SKIP:
                continue
            key, page = split(where, labels)
            if key is None:
                unknown.append(f)
                continue
            if only and key not in only:
                continue
            picked.setdefault(key, []).append((os.path.join(tmp, f), f'{page}-{width}-{theme}.png'))

        failed = {}
        if not a.no_steps:
            steps_dir = os.path.join(tmp, 'steps')
            os.makedirs(steps_dir)
            want = [k for k in sorted(only or keys) if k in STEPS]
            widths = [int(x) for x in a.step_widths.split(',') if x.strip()]
            themes = [x.strip() for x in a.themes.split(',') if x.strip()]
            got, failed = run_steps(a.url, steps_dir, widths, themes, want)
            for key, files in got.items():
                picked.setdefault(key, []).extend(files)
            for key, errs in failed.items():
                print(f'{key} 的步骤截图失败，这个模块的截图没替换：')
                for x in errs:
                    print('  ' + x)

        for key in sorted(only or keys):
            if key in failed:
                continue
            d = os.path.join(SHOTS, key)
            if os.path.isdir(d):
                for f in os.listdir(d):
                    if f.endswith('.png'):
                        os.remove(os.path.join(d, f))
            files = picked.get(key, [])
            if not files:
                continue
            os.makedirs(d, exist_ok=True)
            for src, name in files:
                dst = os.path.join(d, name)
                shutil.move(src, dst)
                if not a.no_shrink:
                    shrink(dst)
            print(f'{key:10} {len(files):>4} 张')

        if unknown:
            print('认不出模块、没收进规格包的截图：' + '、'.join(unknown))
        print(f'截图在 {SHOTS}')
        return 1 if failed and code == 0 else code
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
