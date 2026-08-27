# Windows 打包指南（ZYXterm）

本文档说明如何在 **Windows** 上把 ZYXterm 打包成可安装/运行的 Windows 程序。

## 为什么要在 Windows 上打包

ZYXterm 的串口功能依赖 `serialport` **原生模块**。原生模块必须与目标系统的
ABI 匹配：

- 在 Linux 上打包，产物里的串口模块是 Linux 版，Windows 上无法加载；
- 因此要得到 Windows 可用的安装包，**必须在 Windows 环境（或 Windows 构建机）
  上执行打包**。

SSH / VNC / RDP 为纯 JS 实现，不受此限制。

## 一、准备 Windows 构建环境

1. **Windows 10 / 11**（x64）
2. **Node.js LTS**（18+，建议 20/22/24）→ <https://nodejs.org>
   - 安装后打开 PowerShell 或 CMD，执行 `node -v`、`npm -v` 确认
3. **Visual Studio Build Tools**（用于编译串口原生模块）
   - 下载 <https://visualstudio.microsoft.com/visual-cpp-build-tools/>
   - 安装时勾选 **「使用 C++ 的桌面开发」**（Desktop development with C++）
   - 或仅安装「单个组件」中的 MSVC 编译器 + Windows SDK

> 若不想安装 VS，可先尝试直接 `npm install` —— `serialport` 自带预编译二进制，
> 若 `@electron/rebuild` 能下载到 Electron 版本预编译产物则无需编译；
> 否则仍需要 VS 工具链。

## 二、中国大陆网络加速（可选）

`electron-builder` 打包时下载 Electron 与 winCodeSign 等工具，国内访问
GitHub 极慢（实测 105MB 的 Electron 从 GitHub 可能数小时）。务必设置镜像：

```powershell
# npm 镜像
npm config set registry https://registry.npmmirror.com

# Electron 二进制镜像（electron-builder 与 npm install 均读取）
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"

# electron-builder 自带工具（winCodeSign/nsis 等）镜像
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## 三、拷贝项目并安装依赖

将整个 ZYXterm 工程目录拷贝到 Windows（建议路径不含中文/空格，如 `D:\projects\ZYXterm`）。

```powershell
cd D:\projects\ZYXterm
npm install
```

`npm install` 会自动触发 `electron-builder install-app-deps`，
把 `serialport` 等原生模块重建成 **Windows + Electron** 的 ABI 版本。

> 若 `postinstall` 编译失败，先确认 VS Build Tools 已安装；可运行
> `npm install -g windows-build-tools` 或在 PowerShell 执行：
> `npm config set msvs_version 2022`

## 四、打包

```powershell
npm run dist:win
```

或分步执行：

```powershell
npm run build          # 先构建 out/（main/preload/renderer）
npx electron-builder --win   # 再打包 Windows 安装包
```

产物输出到 `dist/`：

| 文件 | 说明 |
| --- | --- |
| `ZYXterm-Setup-0.1.0.exe` | NSIS 安装包（可选安装目录、桌面快捷方式） |
| `win-unpacked/` | 免安装解压版（直接运行 `ZYXterm.exe`） |
| `builder-debug.yml` | 打包日志（排查用） |

## 五、运行验证

1. 安装 `ZYXterm-Setup-*.exe`，或在 `win-unpacked/` 直接运行 `ZYXterm.exe`
2. 首次启动如提示 **SmartScreen**，点「更多信息 → 仍要运行」（未签名应用属正常现象）
3. 测试各协议：
   - SSH：新建 SSH 连接，填写主机/端口/用户名/密码
   - 串口：在「设备管理器 → 端口(COM 和 LPT)」查看串口号，如 `COM3`
   - VNC / RDP：填写目标主机
4. RDP 使用 **Guacamole 嵌入方案**（画面嵌入应用内），需要 **guacd**：
   - **应用内置**：仅 Linux 打包会自动内置 guacd；Windows 包默认不含。
     若需 Windows 内置，自行编译/获取 Windows 版 `guacd.exe` 放入工程的
     `resources/guacd/guacd.exe` 再打包，应用会自动识别使用。
   - 配置**远程 guacd**（Windows 最省事）：运行应用前设置环境变量
     `GUACD_HOST` / `GUACD_PORT`，例如用 Docker 启动
     `docker run -d -p 4822:4822 guacamole/guacd`，应用即连接该远程
     guacd 完成 RDP 嵌入，无需本机安装。
   - 未检测到 guacd 时 RDP 提示「不可用」，不影响 SSH/VNC/串口。

## 六、可选：生成应用图标

当前使用 Electron 默认图标。如需自定义：

1. 准备 `512x512` 的 PNG
2. 在项目根新建 `build/` 目录放入 `icon.png`
3. 在 `package.json` 的 `build` 字段加入：

```json
"win": {
  "icon": "build/icon.png",
  ...
}
```

electron-builder 会自动从 PNG 生成 `.ico`。

## 七、自动编译 Windows 版 FreeRDP 及 RDP addon（GitHub Actions）

工程已内置 workflow（[`.github/workflows/build-windows-freerdp.yml`](.github/workflows/build-windows-freerdp.yml:1)），在 GitHub Actions（windows-2022 + MSVC）上编译：

- FreeRDP 3.23.0 运行库（`freerdp3.dll` 等）
- FreeRDP 开发包（头文件 + import lib，供 addon 编译）
- ZYXterm 的 RDP N-API addon（win32-x64 `freerdp.node`）

用法：

1. 将本工程推送到 GitHub（包含 `.github/workflows`）
2. 进入 **Actions → Build Windows FreeRDP → Run workflow**（手动触发）
3. 成功后下载 **freerdp-win64** artifact
4. 解压，把 DLL 与 `build/Release/freerdp.node` 放入工程的 `resources/freerdp/`（DLL 放根目录，addon 放 `build/Release/`）
5. 重新 `npm run dist:win` 或 `./build-docker.sh win` 打包 —— 应用内 RDP 使用 FreeRDP 嵌入式 addon，Windows 本地即可嵌入 RDP

> 说明：ZYXterm 的 RDP 已从 Apache Guacamole（guacd）切换到 **FreeRDP 嵌入式方案**，
> 运行时不再需要 guacd。

## 常见问题

- **编译报 `MSB4019` / 找不到 vcvarsall**：VS Build Tools 未装 C++ 工作负载
- **安装包被杀毒软件拦截**：未做代码签名，可加入白名单
- **SmartScreen 提示**：需代码签名证书（商业或自签名）后可消除
- **electron-builder 下载 Electron 慢**：参考第二节设置 `ELECTRON_MIRROR`
- **运行报 `bindings.node is not a valid Win32 application`**：这是**旧版交叉打包
  流程**把 serialport 全量重编译成 Linux 版并破坏多平台预编译导致的。
  **已修复**：serialport 使用 N-API（自带 win32-x64 的 Windows PE 预编译），
  打包脚本在 Windows 打包时移除 Linux 的 `build/Release` 产物，确保加载
  Windows PE 模块——**交叉打包的 Windows 包串口可正常使用**。
  请用最新工程重新打包。若仍遇此错误，可改用 Windows 环境执行
  `npm install && npm run dist:win`。
