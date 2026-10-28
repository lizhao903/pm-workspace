#!/usr/bin/env python3
"""正式前端冒烟测试：逐个打开已启用模块，亮暗两种主题 x 三种宽度，收集 console error、页面异常和横向滚动。

用法（make smoke-frontend 调的就是这个）：
  /opt/miniconda3/bin/python scripts/smoke-frontend.py [--front-port 7780] [--front-url http://127.0.0.1:7780]
      [--widths 390,768,1440] [--themes light,dark] [--module tasks,docs] [--wait 0]

- 已启用模块从正式前端侧栏菜单（aside 里的 a.side-item）读，不写死；/_dev 下的开发页不算模块，不跑。
- 每个主题 x 宽度开全新的浏览器上下文，清掉存储后只写主题（pmw-theme），并核对 <html data-theme>。
- 只读：不启动、不重启前端和后端；前端没在跑就提示启动命令后退出。页面上不做点击和写操作。
- 退出码：0 没问题；1 有问题（逐条列出模块、主题、宽度；前端整体报错读不到菜单也算）；2 前端没在跑、地址不对或环境不对。
"""
import argparse
import os
import sys
import urllib.error
import urllib.request

FRONT_HINT = '正式前端没在跑（{url}）：先在另一个终端执行  cd frontend && npm run dev  （默认 7780，接口代理到测试实例 7796；换端口用 npx vite --port <端口> --strictPort，再给本脚本传 --front-port）'
SETTLE_MS = 400
# 侧栏菜单：分组里的模块加底部的模块（设置）
MENU_JS = """() => [...document.querySelectorAll('aside.shell-side .side-group a.side-item, aside.shell-side .side-foot a.side-item')]
  .map((a) => ({ path: new URL(a.href).pathname, label: (a.querySelector('.side-label')?.textContent || a.textContent || '').trim() }))"""
OVERFLOW_JS = '() => ({ w: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), c: document.documentElement.clientWidth })'


def reachable(url):
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            return r.status < 500
    except (urllib.error.URLError, OSError, ValueError):
        return False


def open_fresh(page, url, theme):
    """打开页面，清掉存储只留主题，重新加载。"""
    page.goto(url, wait_until='domcontentloaded')
    page.evaluate("t => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('pmw-theme', t) }", theme)
    page.reload(wait_until='networkidle')


def read_menu(browser, base):
    """用宽屏打开首页读一次侧栏菜单，去重、去掉 /_dev。"""
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    errs = []
    try:
        page = ctx.new_page()
        page.on('console', lambda m: m.type == 'error' and errs.append((m.text or '').splitlines()[0][:300]))
        page.on('pageerror', lambda e: errs.append(str(e).splitlines()[0][:300]))
        open_fresh(page, base, 'light')
        try:
            page.wait_for_selector('aside.shell-side a.side-item', state='attached', timeout=15000)
        except Exception as e:
            # 菜单没出来多半是前端整体挂了，把页面上的报错带出来
            raise MenuError(str(e).splitlines()[0][:200], list(dict.fromkeys(errs))[:5]) from None
        seen, out = set(), []
        for m in page.evaluate(MENU_JS):
            p = m['path'].rstrip('/') or '/'
            if p in seen or p.startswith('/_dev'):
                continue
            seen.add(p)
            out.append({'path': p, 'label': m['label'] or p})
        return out
    finally:
        ctx.close()


class MenuError(Exception):
    def __init__(self, msg, errs):
        super().__init__(msg + ''.join(f'\n  页面报错：{x}' for x in errs))
        self.errs = errs


class Run:
    """一个主题 x 宽度的组合：记录当前模块，出问题时带上模块、主题、宽度。"""

    def __init__(self, page, theme, width):
        self.page, self.theme, self.width = page, theme, width
        self.where = '启动'
        self.problems = []
        page.on('console', self.on_console)
        page.on('pageerror', lambda e: self.add('页面异常', str(e).splitlines()[0][:300]))

    def on_console(self, msg):
        if msg.type != 'error':
            return
        text = (msg.text or '(空)').splitlines()[0][:300]
        # 资源加载失败只说状态码，补上是哪个地址
        src = (msg.location or {}).get('url') if 'Failed to load resource' in text else None
        self.add('console error', text + (f'（{src}）' if src else ''))

    def add(self, kind, detail):
        self.problems.append({'kind': kind, 'where': self.where, 'theme': self.theme, 'width': self.width, 'detail': detail})

    def visit(self, base, mod, wait):
        self.where = f'{mod["label"]}（{mod["path"]}）'
        page = self.page
        try:
            page.goto(base + mod['path'], wait_until='networkidle', timeout=20000)
        except Exception as e:
            self.add('打不开', str(e).splitlines()[0][:200])
            return
        page.wait_for_timeout(SETTLE_MS + wait)
        st = page.evaluate("""() => ({
          theme: document.documentElement.dataset.theme,
          shell: !!document.querySelector('.shell'),
          title: document.querySelector('.shell-content .shell-placeholder h1')?.textContent || '',
        })""")
        if not st['shell']:
            self.add('路由出错', '外壳没渲染，落到了路由错误页')
        elif st['title'] in ('页面不存在', '出错了'):
            self.add('路由出错', f'内容区显示「{st["title"]}」')
        if st['theme'] != self.theme:
            self.add('主题不对', f'期望 {self.theme}，页面是 {st["theme"]}')
        sw = page.evaluate(OVERFLOW_JS)
        if sw['w'] > sw['c'] + 1:
            self.add('横向滚动', f"页面宽 {sw['w']}px，视口 {sw['c']}px")


def smoke_one(browser, base, mods, theme, width, wait):
    ctx = browser.new_context(viewport={'width': width, 'height': 900}, color_scheme=theme)
    page = ctx.new_page()
    run = Run(page, theme, width)
    try:
        open_fresh(page, base, theme)
        for m in mods:
            run.visit(base, m, wait)
    except Exception as e:
        run.add('脚本异常', str(e).splitlines()[0][:200])
    finally:
        ctx.close()
    return run.problems


def main():
    ap = argparse.ArgumentParser(description='正式前端冒烟测试')
    ap.add_argument('--front-port', type=int, default=int(os.environ.get('FRONT_PORT', '7780')), help='正式前端 dev server 端口')
    ap.add_argument('--front-url', help='正式前端地址，给了就忽略 --front-port')
    ap.add_argument('--widths', default='390,768,1440')
    ap.add_argument('--themes', default='light,dark')
    ap.add_argument('--module', help='只跑这些模块，逗号分隔，填路由路径（tasks）或菜单名；默认跑菜单里全部')
    ap.add_argument('--wait', type=int, default=0, help='每个模块打开后额外等的毫秒数')
    a = ap.parse_args()
    base = (a.front_url or f'http://127.0.0.1:{a.front_port}').rstrip('/')
    try:
        widths = [int(x) for x in a.widths.split(',') if x.strip()]
    except ValueError:
        print(f'--widths 只能是逗号分隔的数字：{a.widths}')
        return 2
    themes = [x.strip() for x in a.themes.split(',') if x.strip()]
    bad = [t for t in themes if t not in ('light', 'dark')]
    if bad or not themes or not widths:
        print(f'--themes 只能是 light、dark，--widths 不能为空（当前 themes={a.themes} widths={a.widths}）')
        return 2

    if not reachable(base):
        print(FRONT_HINT.format(url=base))
        return 2
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('没找到 playwright：请用本机 base Python 跑（/opt/miniconda3/bin/python scripts/smoke-frontend.py）')
        return 2

    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome')
        try:
            try:
                mods = read_menu(browser, base)
            except Exception as e:
                print(f'读不到侧栏菜单（{base}）：{e}')
                # 页面自己报了错算前端的问题（退出 1），否则当作地址或环境不对（退出 2）
                return 1 if getattr(e, 'errs', None) else 2
            if a.module:
                want = {x.strip().strip('/') for x in a.module.split(',') if x.strip()}
                mods = [m for m in mods if m['path'].strip('/') in want or m['label'] in want]
            if not mods:
                print('侧栏菜单里没有可跑的模块' + (f'（--module {a.module} 没匹配上）' if a.module else ''))
                return 2
            print(f'前端 {base}，模块 {len(mods)} 个：' + '、'.join(f'{m["label"]}({m["path"]})' for m in mods), flush=True)
            problems = []
            for theme in themes:
                for width in widths:
                    got = smoke_one(browser, base, mods, theme, width, a.wait)
                    problems += got
                    print(f'[{theme:5} {width:>4}] {len(mods)} 个模块，问题 {len(got)} 条', flush=True)
        finally:
            browser.close()

    total = len(mods) * len(themes) * len(widths)
    if not problems:
        print(f'通过：{total} 次打开，没有 console error、页面异常和横向滚动')
        return 0
    print(f'\n发现 {len(problems)} 条问题（{total} 次打开）：')
    for x in problems:
        print(f'- [{x["kind"]}] 模块 {x["where"]}，主题 {x["theme"]}，宽度 {x["width"]}：{x["detail"]}')
    return 1


if __name__ == '__main__':
    sys.exit(main())
