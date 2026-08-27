# ZYXterm

基于 Electron + React + TypeScript 的跨平台桌面终端，在一个应用内集中管理
SSH / 串口 / VNC / RDP 远程连接，支持标签页管理、多窗口分离与自动更新。

## 功能特性

| 协议 | 说明 |
| --- | --- |
| SSH | `ssh2` + xterm.js，密码 / 私钥认证；命令历史、快捷命令、命令补全、SFTP 文件浏览 / 上传 / 下载、实时目录跟踪 |
| 串口 | `serialport` 直接读写，波特率 / 数据位 / 停止位 / 校验 / 流控可配置 |
| VNC | `@novnc/novnc` + 主进程 WebSocket↔TCP 代理，内嵌画布，画质 / 自动缩放 / 只读模式 |
| RDP | 原生 FreeRDP 3 嵌入式（C++ addon），画面脏区增量推送到 canvas，分辨率跟随容器自动调整，键盘 / 鼠标 / 滚轮注入，canvas 绘制远程光标 |

其他特性：

- **标签页 & 多窗口**：标签拖拽排序、分离成独立窗口、合并回主窗口、右键重连 / 关闭
- **配置安全**：连接配置持久化到 `userData/connections.json`，密码经 Electron `safeStorage` 加密存储（Windows DPAPI / 系统钥匙串）
- **自动更新**：`electron-updater` + GitHub Releases，启动时检查 + 每小时定时检查

## 技术架构

```
┌─────────────────────────── 渲染进程 (React) ───────────────────────────┐
│  连接列表 / 标签页 / 新建对话框                                          │
│  ├─ xterm.js ────────────── SSH / 串口 终端                             │
│  ├─ @novnc/novnc (RFB) ──── VNC 画布                                    │
│  └─ RDPView2 ────────────── RDP canvas（脏区绘制 + 远程光标）           │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ contextBridge (preload, IPC)
┌──────────────────────────────┴──────────────────────────────────────────┐
│                        主进程 (Electron)                                │
│  ConnectionManager（会话生命周期管理）                                   │
│  ├─ ssh2        → SSH shell channel                                     │
│  ├─ serialport  → 串口读写                                              │
│  ├─ ws + net    → VNC WebSocket↔TCP 代理                                │
│  └─ utilityProcess → rdp-worker.cjs → freerdp addon（FreeRDP 3）        │
│  ProfileStore → userData/connections.json（safeStorage 加密）           │
│  WindowManager（多窗口 / 标签分离合并）、updater（自动更新）             │
└─────────────────────────────────────────────────────────────────────────┘
```

> 设计说明：SSH 与串口均未使用 `node-pty`（本地 PTY）。SSH 直接使用 ssh2 的
> shell channel 对接 xterm；串口使用「直接模式」（xterm 输入 → 串口，
> 串口数据 → xterm），避免引入不必要的原生编译依赖，跨平台更稳定。

### RDP 嵌入式实现

- **addon**：[`native/freerdp`](native/freerdp/binding.gyp) 是用 `node-addon-api`
  编写的 FreeRDP 3 客户端（C++），在 `utilityProcess` 子进程中加载
  （[`rdp-worker.cjs`](src/main/rdp-worker.cjs)），避免阻塞主进程。
- **画面**：FreeRDP 将桌面脏区帧经 IPC 推送到渲染进程
  （[`RDPView2.tsx`](src/renderer/src/components/RDPView2.tsx)）绘制到 canvas；
  容器尺寸变化时通过 `rdp:setSize` 动态重连以匹配分辨率（铺满）。
- **交互**：canvas 的键盘 / 鼠标 / 滚轮事件经 IPC 回传 addon 注入远程桌面；
  远程光标（PointerNew / PointerLarge / PointerCached）也在 canvas 上绘制。
- **运行库**：FreeRDP 动态库随安装包分发（Linux 经 `ldd` 收集依赖 + `patchelf`
  设置 rpath，Windows 内置 DLL），目标机无需额外安装 FreeRDP。

## 目录结构

```
ZYXterm/
├── .github/workflows/
│   ├── release.yml                 # 自动编译 FreeRDP3 + addon + 打包发布（Windows / Linux）
│   └── build-windows-freerdp.yml   # 手动编译 Windows FreeRDP 运行库
├── native/freerdp/                 # RDP 原生 addon 源码（C++ / node-addon-api）
│   ├── binding.gyp
│   └── src/rdp_session.cc          # FreeRDP 3 客户端实现（帧 / 尺寸 / 指针）
├── scripts/                        # 构建与测试脚本
│   ├── run-vite.cjs                # electron-vite 包装器（跨平台 / 自动移除 ELECTRON_RUN_AS_NODE）
│   ├── rebuild-native.cjs          # 重建原生模块（serialport / freerdp addon）
│   └── test-*.cjs                  # 各协议 / 界面测试脚本
├── src/
│   ├── main/                       # 主进程
│   │   ├── index.ts                # 应用入口、窗口、自动更新初始化
│   │   ├── ipc.ts                  # IPC 处理器注册
│   │   ├── store.ts                # 连接配置持久化（safeStorage 加密）
│   │   ├── updater.ts              # 自动更新（GitHub Releases）
│   │   ├── window-manager.ts       # 多窗口 / 标签分离合并
│   │   ├── rdp-worker.cjs          # RDP utility 进程（加载 freerdp addon）
│   │   ├── serialport-loader.ts    # 串口原生模块加载（失败优雅降级）
│   │   └── connections/            # 协议会话实现
│   │       ├── manager.ts          # 会话管理器
│   │       ├── ssh.ts              # SSH
│   │       ├── serial.ts           # 串口
│   │       ├── vnc.ts              # VNC 代理
│   │       ├── rdp2.ts             # RDP（FreeRDP addon 会话）
│   │       └── types.ts            # 会话接口
│   ├── preload/                    # contextBridge 安全桥接
│   ├── renderer/                   # 渲染进程 (React)
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── styles.css
│   │       └── components/         # Sidebar / Tabs / 对话框 / 终端 / VNC / RDP 等
│   └── shared/types.ts             # 主 / 渲染共享类型
├── electron.vite.config.ts
├── tsconfig*.json
├── package.json
├── README.md / WINDOWS.md / GITHUB.md / UPDATING.md
└── plans/                          # 设计文档（如 freerdp-rdp-integration.md）
```

> 说明：`resources/`（FreeRDP 运行库 / addon 产物）、`dist/`、`out/`、
> `node_modules/` 等构建产物与本地工具脚本均不入库，由构建流程生成。

## 安装与运行

```bash
npm install            # 安装依赖（postinstall 自动重建原生模块）
npm run dev            # 开发模式（热更新）
npm run build          # 构建产物到 out/
npm start              # 预览构建产物
```

> 中国大陆网络下载 Electron 若较慢，可先设置镜像：
> `export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`
>
> 部分环境（如个别 WSL2/CI）设置了 `ELECTRON_RUN_AS_NODE=1`，会强制
> Electron 以 Node 模式运行导致主进程拿不到 `app` 等 API。项目已内置
> [`scripts/run-vite.cjs`](scripts/run-vite.cjs) 包装器，在启动前自动移除
> 该变量，无需手动处理。

### 开发环境依赖（Linux / WSL2）

Electron 运行需要图形库，串口原生模块需要编译工具，RDP addon 需要
FreeRDP 3 开发库：

```bash
sudo apt-get update && sudo apt-get install -y \
  build-essential python3 make g++ \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
  libasound2 libgtk-3-0 \
  freerdp3-dev          # RDP addon 编译所需（Ubuntu 24.04+）
```

> RDP addon 在 Linux 使用系统 FreeRDP 3 开发库编译（见
> [`binding.gyp`](native/freerdp/binding.gyp)）；若未安装 `freerdp3-dev`，
> [`scripts/rebuild-native.cjs`](scripts/rebuild-native.cjs) 会跳过 addon 重建并
> 回退到随包预编译产物（安装包自带，目标机无需额外安装 FreeRDP）。
>
> macOS：安装 Xcode Command Line Tools（`xcode-select --install`）。
> Windows：串口原生模块需与目标平台 ABI 匹配，Windows 安装包请在
> Windows 环境打包（见 [WINDOWS.md](WINDOWS.md)）。

## 打包与发布

- **GitHub Actions 自动编译发布**：推送 `v*` 标签或手动触发
  [`release.yml`](.github/workflows/release.yml)，自动编译 FreeRDP 3 + addon，
  打包 Windows（NSIS）与 Linux（AppImage + deb）并上传到 GitHub Releases，
  供 [`updater.ts`](src/main/updater.ts) 自动更新。详细流程见
  [UPDATING.md](UPDATING.md)。
- **Windows 本地打包**：完整步骤（VS Build Tools、镜像加速、打包命令、
  常见问题）见 [WINDOWS.md](WINDOWS.md)。
- **上传 GitHub**：仓库初始化与推送步骤见 [GITHUB.md](GITHUB.md)。

## 使用说明

1. 点击左侧「＋ 新建」创建连接配置，选择协议并填写参数。
2. 「保存后立即连接」会直接打开会话标签页；也可在左侧双击连接再次打开。
3. SSH / 串口在标签页内以终端方式显示；VNC / RDP 在标签页内嵌画布显示。

### 连接参数

- **SSH**：主机、端口、用户名，认证方式（密码 / 私钥，私钥可选口令）。
- **串口**：设备路径（如 `/dev/ttyUSB0`、Windows 的 `COM3`）、波特率、
  数据位、停止位、校验位、流控。
- **VNC**：主机、端口、密码（可选）、画质、自动缩放、只读模式。
- **RDP**：主机、端口、用户名、密码、域、分辨率（默认跟随窗口容器）。

## 已知限制

- RDP 需要可用的 freerdp addon：安装包内置（随包分发）；开发模式需先编译
  （`freerdp3-dev`），或放置预编译产物 `resources/freerdp/build/Release/freerdp.node`
  ——该目录不入库，由构建流程生成。
- 串口为直接模式（不做本地 PTY 桥接），依赖设备自身的回显行为；
  若设备不回显，可自行在代码中为串口终端启用 `localEcho`。
- 连接配置存储于 `userData/connections.json`（该文件不入库），
  密码经 safeStorage 加密保存；开发模式在部分平台（如 Linux 无钥匙串）
  可能回退为加密后存储。
