# 从源码安装并启动（Windows）
# 用法：右键「使用 PowerShell 运行」，或在项目目录执行
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# 如果你只是「想用这个工具」，不要跑这个脚本 ——
# 直接去下载成品包：https://github.com/laozhengdang/miaomiao-study/releases/latest

$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host $m }
function Bad($m) { Write-Host $m -ForegroundColor Red }

Say '=========================================='
Say ' 老郑荡的妙妙小工具 · 源码安装'
Say '=========================================='
Say ''

# ---------- 1. Node ----------
Say '[1/4] 检查 Node.js…'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Bad '  没有 Node.js。请先安装 Node 22 或更高版本：https://nodejs.org/'
  Say '  装完后重新运行这个脚本。'
  Read-Host '按回车退出'
  exit 1
}
$ver = (& node -v).Trim()
$clean = $ver.TrimStart('v')
$major = [int]($clean.Split('.')[0])
Say "  找到 $ver"
if ($major -lt 22) {
  Bad "  Node 版本太低（需要 22+，当前 $ver）。"
  Say '  原因：程序用了内置的 node:sqlite 模块，低版本没有。'
  Say '  升级后重新运行。'
  Read-Host '按回车退出'
  exit 1
}
Say '  ✓ Node 版本够用'

# ---------- 2. Python ----------
Say ''
Say '[2/4] 检查 Python…'
$py = $null
foreach ($c in @('python', 'py', 'python3')) {
  $cmd = Get-Command $c -ErrorAction SilentlyContinue
  if ($cmd) { $py = $c; break }
}
if (-not $py) {
  Bad '  没有 Python。导入 PDF 需要它。'
  Say '  请安装 Python 3.10+：https://www.python.org/downloads/'
  Say '  （安装时勾选 "Add Python to PATH"）'
  Say '  或者：只用成品包，就不需要 Python。'
  Read-Host '按回车退出'
  exit 1
}
Say "  找到 $((& $py --version) 2>&1)"

Say '  检查 PyMuPDF…'
$hasPymupdf = $false
try {
  & $py -c "import pymupdf" 2>$null
  if ($LASTEXITCODE -eq 0) { $hasPymupdf = $true }
} catch { $hasPymupdf = $false }

if ($hasPymupdf) {
  Say '  ✓ PyMuPDF 已安装'
} else {
  Say '  没装 PyMuPDF，正在安装（走清华源，快一些）…'
  & $py -m pip install pymupdf -i https://pypi.tuna.tsinghua.edu.cn/simple
  if ($LASTEXITCODE -ne 0) {
    Bad '  安装失败。手动执行：python -m pip install pymupdf'
    Read-Host '按回车退出'
    exit 1
  }
  Say '  ✓ PyMuPDF 装好了'
}

# ---------- 3. npm install ----------
Say ''
Say '[3/4] 安装依赖（会下载 Electron，约 100MB，可能要几分钟）…'
if (-not (Test-Path 'node_modules')) {
  # 国内网络先设镜像，失败再回默认源
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  & npm install --registry=https://registry.npmmirror.com
  if ($LASTEXITCODE -ne 0) {
    Say '  镜像源失败，换官方源重试…'
    Remove-Item Env:ELECTRON_MIRROR -ErrorAction SilentlyContinue
    & npm install
    if ($LASTEXITCODE -ne 0) {
      Bad '  依赖安装失败。手动执行：npm install'
      Read-Host '按回车退出'
      exit 1
    }
  }
  Say '  ✓ 依赖装好了'
} else {
  Say '  ✓ node_modules 已存在，跳过'
}

# ---------- 4. 验证 ----------
Say ''
Say '[4/4] 验证数据库层…'
$check = & node --input-type=module -e "const m = await import('./app/db.mjs'); const n = m.db.prepare('select count(*) n from card').get().n; console.log('ok:' + n)"
if ($check -like 'ok:*') {
  Say "  ✓ 数据库正常（现有卡片 $($check -replace 'ok:','') 张）"
} else {
  Bad '  数据库层有问题，请把上面的报错发给开发者'
  Read-Host '按回车退出'
  exit 1
}

Say ''
Say '=========================================='
Say ' 装好了，正在启动…'
Say '=========================================='
Start-Sleep -Seconds 1
& npm start
