# 在桌面创建「老郑荡的妙妙小工具」快捷方式
# 由 创建桌面快捷方式.bat 调用，也可以直接：
#   powershell -ExecutionPolicy Bypass -File tools\make_shortcut.ps1
param(
  [string]$ExePath = "",
  [string]$Name = "老郑荡的妙妙小工具"
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $ExePath) {
  # 优先成品目录，其次项目根（源码运行）
  $candidates = @(
    (Join-Path $root 'build\老郑荡的妙妙小工具\老郑荡的妙妙小工具.exe'),
    (Join-Path $root '老郑荡的妙妙小工具.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $ExePath = $c; break } }
}

if (-not $ExePath -or -not (Test-Path $ExePath)) {
  Write-Host '[x] 没找到 老郑荡的妙妙小工具.exe' -ForegroundColor Red
  Write-Host '    请确认这个脚本和 exe 在同一个程序目录里。'
  Write-Host '    如果下载的是源码，请先运行 一键安装.bat。'
  exit 1
}

$exe = (Resolve-Path $ExePath).Path
$dir = Split-Path -Parent $exe
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop "$Name.lnk"

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = $dir
$lnk.IconLocation = "$exe,0"
$lnk.Description = '把课件 PDF 变成能考的知识卡'
$lnk.WindowStyle = 1
$lnk.Save()

if (Test-Path $lnkPath) {
  Write-Host ''
  Write-Host "✓ 桌面快捷方式已创建：$lnkPath" -ForegroundColor Green
  Write-Host "  指向：$exe"
} else {
  Write-Host '[x] 创建失败' -ForegroundColor Red
  exit 1
}
