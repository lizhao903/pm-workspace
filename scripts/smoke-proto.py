#!/usr/bin/env python3
# powered by dsh - https://github.com/deepseek-ai/deepseek-harness

"""原型冒烟测试：逐个点一级菜单、二级菜单和标签，收集 console error 和页面横向滚动。

用法（make smoke-proto 调的就是这个）：
  /opt/miniconda3/bin/python scripts/smoke-proto.py [--url http://127.0.0.1:7778] [--out 截图目录]
      [--widths 375,768,1440] [--themes light,dark] [--max-sub 20]

- 每种主题 x 宽度开一个全新的浏览器上下文，清掉 localStorage，用默认的全部模块工作台（0xBroleez）。
- 只读原型：不启动、不重启，也不改原型文件；原型没在跑就提示启动命令后退出。
- 截图默认不保存；传 --out 才写到该目录（PROTO-04a 复用）。
- 有 console error（或页面未捕获异常）、页面横向滚动时退出码为 1；原型没起或环境不对为 2。
"""
import argparse
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULES_FILE = os.path.join(ROOT, 'web-next', 'src', 'workspacedata.ts')
START_HINT = '原型没在跑：先在另一个终端执行  cd web-next && npm run dev  （默认 http://127.0.0.1:7778），再跑 make smoke-proto'
# 内置浏览器里嵌入的页面加载失败不算错误
IGNORED = ('Failed to load resource',)
WAIT_MS = 250


def module_labels():
    """从原型源码读 MODULES 的中文名，用来核对菜单有没有漏模块；读不到就不核对。"""
    try:
        src = open(MODULES_FILE, encoding='utf-8').read()
    except OSError:
        return []
    block = re.search(r'export const MODULES[^=]*=\s*\[(.*?)\n\]', src, re.S)
    return re.findall(r"label:\s*'([^']+)'", block.group(1)) if block else []


def reachable(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            return r.status < 500
    except (urllib.error.URLError, OSError, ValueError):
        return False


def safe_name(s):
    return re.sub(r'[\\/:*?"<>|\s]+', '_', s).strip('_') or 'x'


class Run:
    """一个主题 x 宽度的组合：记录当前位置，出问题时带上模块、主题、宽度。"""

    def __init__(self, page, theme, width, out):
        self.page, self.theme, self.width, self.out = page, theme, width, out
        self.where = '启动'
        self.problems = []
        self.steps = 0
        page.on('console', self.on_console)
        page.on('pageerror', lambda e: self.add('页面异常', str(e).splitlines()[0][:300]))

    def on_console(self, msg):
        if msg.type != 'error':
            return
        text = msg.text
        if any(s in text for s in IGNORED):
            return
        self.add('console error', text.splitlines()[0][:300] if text else '(空)')

    def add(self, kind, detail):
        self.problems.append({'kind': kind, 'where': self.where, 'theme': self.theme, 'width': self.width, 'detail': detail})

    def check(self, where):
        """点完一步：等渲染，查横向滚动，按需截图。"""
        self.where = where
        self.page.wait_for_timeout(WAIT_MS)
        self.steps += 1
        sw = self.page.evaluate('() => ({ w: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), c: document.documentElement.clientWidth })')
        if sw['w'] > sw['c'] + 1:
            self.add('横向滚动', f"页面宽 {sw['w']}px，视口 {sw['c']}px")
        if self.out:
            name = f'{self.width}-{self.theme}-{safe_name(where)}.png'
            self.page.screenshot(path=os.path.join(self.out, name))

    def close_overlays(self):
        # 点二级菜单可能弹出抽屉或对话框，按 Esc 收起，避免挡住后面的点击
        try:
            self.page.keyboard.press('Escape')
        except Exception:
            pass

    def click(self, loc, where):
        try:
            loc.scroll_into_view_if_needed(timeout=3000)
            loc.click(timeout=5000)
        except Exception as e:
            self.where = where
            self.add('点不到', str(e).splitlines()[0][:200])
            return False
        self.check(where)
        return True


def labels_of(loc):
    out = []
    for i in range(loc.count()):
        el = loc.nth(i)
        if not el.is_visible():
            continue
        t = (el.inner_text() or '').strip().splitlines()
        out.append((i, t[0].strip() if t else f'#{i + 1}'))
    return out


def walk_subs(run, base, max_sub):
    """点当前页的二级菜单项，每项再点它页面上的标签；然后点当前页自己的标签。"""
    page = run.page
    subs = labels_of(page.locator('.subnav .subnav-item'))[:max_sub]
    for i, label in subs:
        run.close_overlays()
        if run.click(page.locator('.subnav .subnav-item').nth(i), f'{base} / {label}'):
            walk_tabs(run, f'{base} / {label}')
    if not subs:
        walk_tabs(run, base)
    return len(subs)


def walk_tabs(run, base):
    page = run.page
    sel = '.np-tabs button'
    for i, label in labels_of(page.locator(sel)):
        run.close_overlays()
        run.click(page.locator(sel).nth(i), f'{base} / 标签 {label}')


def smoke_one(browser, url, theme, width, out, max_sub):
    ctx = browser.new_context(viewport={'width': width, 'height': 900}, color_scheme=theme)
    page = ctx.new_page()
    run = Run(page, theme, width, out)
    menu = []
    try:
        page.goto(url, wait_until='domcontentloaded')
        # 清掉 localStorage，只留主题，重新加载后就是默认的全部模块工作台
        page.evaluate("t => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('pmw-next-theme', t) }", theme)
        page.reload(wait_until='networkidle')
        page.wait_for_selector('.side-group .side-item', timeout=10000)
        got = page.evaluate('() => document.documentElement.dataset.theme')
        if got != theme:
            run.add('主题不对', f'期望 {theme}，页面是 {got}')
        run.check('首页')
        items = page.locator('.side-group .side-item')
        menu = [label for _, label in labels_of(items)]
        for i, label in enumerate(menu):
            run.close_overlays()
            if not run.click(items.nth(i), label):
                continue
            n = walk_subs(run, label, max_sub)
            # 项目没有二级菜单，标签在详情里：打开第一个项目再点标签
            if n == 0 and page.locator('.pl-card').count():
                if run.click(page.locator('.pl-card').first, f'{label} / 第一个项目'):
                    walk_tabs(run, f'{label} / 第一个项目')
        run.close_overlays()
        if run.click(page.locator('.side-foot .side-item').first, '设置'):
            walk_subs(run, '设置', max_sub)
    except Exception as e:
        run.add('脚本中断', str(e).splitlines()[0][:300])
    finally:
        ctx.close()
    return run, menu


def main():
    ap = argparse.ArgumentParser(description='原型冒烟测试')
    ap.add_argument('--url', default=os.environ.get('PROTO_URL', 'http://127.0.0.1:7778'))
    ap.add_argument('--out', help='截图输出目录；不传就不保存截图')
    ap.add_argument('--widths', default='375,768,1440')
    ap.add_argument('--themes', default='light,dark')
    ap.add_argument('--max-sub', type=int, default=20, help='每个模块最多点几个二级菜单项')
    a = ap.parse_args()

    if not reachable(a.url):
        print(START_HINT)
        return 2
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('没找到 playwright：用本机 base Python 跑，/opt/miniconda3/bin/python scripts/smoke-proto.py')
        return 2
    if a.out:
        os.makedirs(a.out, exist_ok=True)
    widths = [int(x) for x in a.widths.split(',') if x.strip()]
    themes = [x.strip() for x in a.themes.split(',') if x.strip()]
    expect = module_labels()

    problems, rows = [], []
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel='chrome')
        except Exception as e:
            print('启动 Chrome 失败：' + str(e).splitlines()[0])
            return 2
        try:
            for theme in themes:
                for width in widths:
                    run, menu = smoke_one(browser, a.url, theme, width, a.out, a.max_sub)
                    missing = [m for m in expect if m not in menu]
                    rows.append((theme, width, len(menu), run.steps, len(run.problems), missing))
                    problems += run.problems
                    print(f'[{theme:5} {width:>4}] 一级菜单 {len(menu)} 个，点了 {run.steps} 步，问题 {len(run.problems)} 个' +
                          (f'，菜单里没有：{"、".join(missing)}' if missing else ''), flush=True)
        finally:
            browser.close()

    print()
    print('== 汇总 ==')
    print(f'原型 {a.url}；主题 {"、".join(themes)}；宽度 {"、".join(map(str, widths))}；源码 MODULES {len(expect)} 个')
    print(f'共点 {sum(r[3] for r in rows)} 步，问题 {len(problems)} 个')
    if a.out:
        print(f'截图在 {os.path.abspath(a.out)}')
    if not problems:
        print('通过')
        return 0
    # 同一个问题在多个组合里出现时合并显示
    merged = {}
    for x in problems:
        k = (x['kind'], x['where'], x['detail'])
        merged.setdefault(k, []).append(f"{x['theme']}/{x['width']}")
    for (kind, where, detail), combos in merged.items():
        print(f'- [{kind}] {where} ({"、".join(combos)})：{detail}')
    return 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
