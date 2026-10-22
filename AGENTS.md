# AGENTS.md — 给 AI 助手的安装与运行说明

> 这个文件是写给**AI 编码助手**看的。如果你是人类，看 [README.md](README.md) 就行。
> 目标：在一台干净的 Windows 机器上，把这个 Electron 桌面应用跑起来。

---

## 这是什么

一个 Electron 桌面应用（不是网站）：把老师课件（PDF / PPTX）变成知识卡，配间隔重复复习。
业务逻辑在 `app/api.mjs`，两个入口共用它：

- `app/electron/main.mjs` — 桌面入口（Electron 主进程）
- `app/server.mjs` — 网页版入口（本地 http 服务，开发时用）

前端是 `app/public/` 下的原生 HTML/CSS/JS，没有构建步骤。

---

## 最快路径：直接用成品包（推荐，不需要任何开发环境）

如果用户只是「想用」，**不要**去装 Node/Python，直接让他下载：

```
https://github.com/laozhengdang/miaomiao-study/releases/latest
```

压缩包里有 `老郑荡的妙妙小工具.exe`、Electron 引擎、内置 Python 3.12 + PyMuPDF。
解压双击即可。**这一步不需要你安装任何东西。**

只有用户明确要求「改代码」或「从源码跑」时，才继续往下。

---

## 从源码跑（需要开发环境）

### 依赖

| 依赖 | 版本 | 用途 | 检查命令 |
|---|---|---|---|
| Node.js | 22+ | 运行 Electron 主进程 | `node -v` |
| Python | 3.10+ | 解析 PDF（PyMuPDF）；PPTX 只用标准库 | `python --version` |
| pymupdf | 1.24+ | PDF 抽文字与图 | `python -c "import pymupdf"` |

**Node 必须 22 以上**：代码用了内置的 `node:sqlite`，低版本没有这个模块，
会直接报 `Cannot find module 'node:sqlite'`。

### 步骤

```bash
git clone https://github.com/laozhengdang/miaomiao-study.git
cd miaomiao-study

npm install                      # 会下载 Electron（约 100MB）
pip install pymupdf

npm start                        # 启动桌面版
```

只想跑网页版调试（无窗口）：

```bash
npm run web                      # http://127.0.0.1:5180
```

### 一键脚本

Windows 上可以直接跑 `一键安装.bat`（或 `powershell -ExecutionPolicy Bypass -File install.ps1`）：
它会检查 Node 版本、Python、PyMuPDF，缺的自动装，最后启动。

### 国内网络注意

`npm install` 卡在 Electron 下载时，设镜像后重试：

```bash
npm config set registry https://registry.npmmirror.com
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
```

`pip install pymupdf` 慢就用：

```bash
pip install pymupdf -i https://pypi.tuna.tsinghua.edu.cn/simple
```

---

## 验证装好了没有

```bash
node --input-type=module -e "const m = await import('./app/db.mjs'); console.log('db ok', m.db.prepare('select count(*) n from card').get())"
```

能打印 `db ok { n: 0 }` 就说明数据库层通了。

再跑自检（会检查数据完整性）：

```bash
node tools/selfcheck.mjs
```

---

## 关键约束（改代码时必须知道）

1. **数据目录**：默认 `<项目>/data`，可用环境变量 `MIAOMIAO_DATA` 改。
   成品包里是 `<exe 所在目录>/data`。**不要把这个目录提交到 git**（已在 .gitignore）。
2. **不要提交课程数据**：`data/`、`runtime/`、`build/` 都在 .gitignore 里。
3. **CSP 禁止内联事件**：前端 `script-src 'self'`，所有 `onclick` 必须在 JS 里绑定，
   写 `onclick="..."` 到 HTML 里会被浏览器拦掉且**没有任何报错**。
4. **数据库是内置 sqlite**：`node:sqlite`，没有原生模块，不需要编译。
   结构在 `app/db.mjs`，加字段用 `ensureColumn('表','列','列名 类型')`。
5. **课件解析走子进程**：`tools/ingest.py` 由 `app/api.mjs` 的 `startImport()` 调起，
   优先用 `runtime/python/python.exe`（成品包内置），没有才用系统 `python`。
6. **AI 功能需要用户自己的 API Key**，存在 `profile.ai_api_key`，代码里不硬编码。
   没有 Key 时导入会走「无 AI 降级模式」，仍然可用。

---

## 目录结构

```
app/
├─ db.mjs              数据库 schema 与迁移
├─ api.mjs             所有业务逻辑（约 1300 行）
├─ ai.mjs              AI 调用、提示词、余额查询
├─ server.mjs          网页版入口
├─ electron/
│  ├─ main.mjs         桌面入口 + IPC + --selfcheck / --uitest
│  └─ preload.cjs      暴露给前端的 nativeApi
└─ public/             index.html / app.js / style.css
tools/
├─ ingest.py           PDF/PPTX → 卡片（支持 ppt / exam / notes / syllabus 四种解析）
├─ selfcheck.mjs       数据自检
└─ pack.mjs            打包（复制 + 校验关键代码是否到位）
```

---

## 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `Cannot find module 'node:sqlite'` | Node 版本太低 | 升到 22+ |
| 导入时报 `找不到 python` | 没装 Python 或不在 PATH | `pip install pymupdf`，或把嵌入式 Python 放 `runtime/python/` |
| 旧 .ppt 导入报错 | 本机没有 PowerPoint / WPS，无法自动转换 | 装 Office/WPS，或让用户「另存为」.pptx / PDF |
| 点按钮没反应 | 写了内联 onclick，被 CSP 拦 | 在 JS 里 `el.onclick = ...` |
| `npm start` 白屏 | 前端 JS 语法错误 | 开 DevTools（Ctrl+Shift+I）看 Console |
| 打包后功能没变 | `打包.bat` 没真正复制 | 用 `node tools/pack.mjs`，它会校验并报错 |

---

## 如果用户只是想要一个能用的程序

**不要从源码构建。** 直接让他下 Release 的 zip（178MB），解压双击。
这是他真正需要的，而且比装开发环境快十倍。
