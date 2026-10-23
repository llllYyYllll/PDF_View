# Launch Tauri with MSVC environment (required on Windows)
$ErrorActionPreference = "Stop"

# Ensure Rust/cargo is on PATH (vcvars/cmd 子进程有时读不到新装的 User PATH)
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (-not (Test-Path (Join-Path $cargoBin "cargo.exe"))) {
  Write-Error "未找到 cargo。请先安装 Rust：https://rustup.rs ，然后重新打开终端。"
}
$env:Path = "$cargoBin;$env:Path"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
  Write-Error "未找到 Visual Studio Installer。请安装 VS 2022 Build Tools（C++ 工作负载）。"
}
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) {
  Write-Error "未找到 MSVC 工具链。请安装「使用 C++ 的桌面开发」工作负载。"
}
$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
$root = Split-Path -Parent $PSScriptRoot

# 把当前已含 cargo 的 PATH 传进 cmd，再叠加 vcvars
cmd /c "`"$vcvars`" && set `"PATH=$cargoBin;%PATH%`" && cd /d `"$root`" && npm run tauri:dev"
