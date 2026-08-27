# ZYXterm

MobaXterm 风格的桌面终端软件，基于 Electron + React + TypeScript。

支持四种远程连接协议：

| 协议 | 说明 |
| --- | --- |
| SSH | 通过 `ssh2` 建立 shell 会话，配合 xterm.js 终端，支持密码 / 私钥认证 |
| 串口 | 通过 `serialport` 直接读写串口，支持波特率/数据位/停止位/校验/流控配置 |
| VNC | 主进程 WebSocket ↔ TCP 代理 + `@novnc/novnc` RFB 客户端，标签页内嵌显示 |
| RDP | Apache Guacamole 嵌入方案：guacd（基于 FreeRDP）编码 + WebSocket 桥，画面**嵌入应用内** canvas，支持键盘/鼠标 |

## 技术架构

```
┌─────────────────────────── 渲染进程 (React) ───────────────────────────┐
│  连接列表 / 标签页 / 新建对话框                                          │
│  ├─ xterm.js ────────────── SSH / 串口 终端                             │
│  └─ @novnc/novnc (RFB) ──── VNC 画布                                    │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ contextBridge (preload, IPC)
┌──────────────────────────────┴──────────────────────────────────────────┐
│                        主进程 (Electron)                                │
│  ConnectionManager（会话生命周期管理）                                   │
│  ├─ ssh2        → SSH shell channel                                     │
│  ├─ serialport  → 串口读写                                              │
│  ├─ ws + net    → VNC WebSocket↔TCP 代理                                │
│  └─ guacd 管理（本机启动/远程）+ WebSocket↔guacd 桥（RDP 嵌入）        │
│  ProfileStore → userData/connections.json                               │
└─────────────────────────────────────────────────────────────────────────┘
```

> 设计说明：SSH 与串口均未使用 `node-pty`（本地 PTY）。
> SSH 直接使用 ssh2 的 shell channel 对接 xterm；串口使用「直接模式」
> （xterm 输入 → 串口，串口数据 → xterm），避免引入原生编译依赖，跨平台更稳定。

## 目录结构

```
ZYXterm/
├── src/
│   ├── main/                  # 主进程
│   │   ├── index.ts           # 应用入口、窗口
│   │   ├── ipc.ts             # IPC 处理器注册
│   │   ├── store.ts           # 连接配置持久化
│   │   └── connections/       # 协议会话实现
│   │       ├── manager.ts     # 会话管理器
│   │       ├── ssh.ts         # SSH
│   │       ├── serial.ts      # 串口
│   │       ├── vnc.ts         # VNC 代理
│   │       └── rdp.ts         # RDP (Guacamole/guacd 桥)
│   ├── preload/               # 安全桥接
│   │   ├── index.ts
│   │   └── index.d.ts
│   ├── renderer/              # 渲染进程 (React)
│   │   └── src/
│   │       ├── App.tsx
│   │       └── components/    # Sidebar/Tabs/对话框/终端/VNC/RDP
│   └── shared/types.ts        # 主/渲染共享类型
├── electron.vite.config.ts
└── tsconfig*.json
```

## 系统依赖

### Linux / WSL2

Electron 运行需要图形库，串口原生模块需要编译工具，RDP 需要 guacd。
Debian/Ubuntu 安装：

```bash
sudo apt-get update && sudo apt-get install -y \
  build-essential python3 make g++ \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
  libasound2 libgtk-3-0 \
  guacd
```
（`guacd` 为 RDP 嵌入所需；它基于 FreeRDP 库，安装时会自动带上依赖）

### macOS / Windows

- macOS：安装 Xcode Command Line Tools（`xcode-select --install`）
- Windows：RDP 使用 guacd，可本机安装，或设置 `GUACD_HOST`/`GUACD_PORT`
  指定远程 guacd（如 Docker 容器 `guacamole/guacd`）

## 安装与运行

```bash
npm install            # 安装依赖（会自动下载 Electron、重建原生模块）
npm run dev            # 开发模式（热更新）
npm run build          # 构建产物到 out/
npm start              # 预览构建产物
npm run dist           # 打包安装包（electron-builder）
```

> 中国大陆网络下载 Electron 若较慢，可先设置镜像：
> `export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`

> 部分环境（如个别 WSL2/CI）设置了 `ELECTRON_RUN_AS_NODE=1`，会强制
> Electron 以 Node 模式运行导致主进程拿不到 `app` 等 API。项目已内置
> [`scripts/run-vite.cjs`](scripts/run-vite.cjs) 包装器，在启动前自动移除
> 该变量，无需手动处理。

## Windows 打包

串口原生模块必须与目标平台 ABI 匹配，因此 **Windows 安装包需在 Windows
环境构建**。完整步骤见 **[WINDOWS.md](WINDOWS.md)**（含 VS Build Tools、
镜像加速、打包命令、guacd 部署、常见问题）。

## Docker 打包（Windows + Linux）

在没有本地编译环境（或需要跨平台产物）的机器上，可使用 Docker 镜像
`electronuserland/builder:wine` 打包：

```bash
./build-docker.sh          # Windows + Linux
./build-docker.sh win      # 仅 Windows
./build-docker.sh linux    # 仅 Linux
```

脚本特性（见 [`build-docker.sh`](build-docker.sh:1)）：
- 交互修改版本号（回车保持当前版本）
- 缓存复用：`docker-cache/` 挂载为容器 `~/.cache`，Electron/工具/npm 缓存
  跨多次构建复用，避免重复下载
- 产物输出到 `ZYXterm/` 目录（自动创建），不使用 update 目录
- 原生模块重建：`postinstall` 仅重建 `serialport`
  （[`scripts/rebuild-native.cjs`](scripts/rebuild-native.cjs:1)），跳过 ssh2 的
  可选加速模块 `cpu-features`——旧版 GCC 编译 Electron 43 的 V8 头文件会失败，
  且 `cpu-features` 非必需（ssh2 加载失败会自动回退纯 JS），不影响 SSH 功能

> **交叉打包的 Windows 包串口可用**：serialport 使用 **N-API**，自带全平台
> 预编译二进制（`prebuilds/win32-x64` 为 Windows PE，可跨 Node/Electron ABI 加载）。
> 打包脚本在 Windows 打包时移除 Linux 编译产物（`build/Release`），确保
> `node-gyp-build` 只加载 win32-x64 的 N-API PE 预编译模块。
> 同时已做优雅降级（[`src/main/serialport-loader.ts`](src/main/serialport-loader.ts:1)），
> 即使原生模块加载失败应用也不会崩溃，仅串口提示「不可用」。
> 若要在 Windows 上本地打包（最稳妥）：`npm run dist:win`。

## 使用说明

1. 点击左侧「＋ 新建」创建连接配置，选择协议并填写参数。
2. 「保存后立即连接」会直接打开会话标签页；也可在左侧双击连接再次打开。
3. SSH/串口在标签页内以终端方式显示；VNC 在标签页内嵌画布；
   RDP 通过 Guacamole 嵌入标签页内显示（需 guacd）。

### 连接参数

- **SSH**：主机、端口、用户名，认证方式（密码 / 私钥，私钥可选口令）。
- **串口**：设备路径（如 `/dev/ttyUSB0`、Windows 的 `COM3`）、波特率、
  数据位、停止位、校验位、流控。
- **VNC**：主机、端口、密码（可选）、画质、自动缩放、只读模式。
- **RDP**：主机、端口、用户名、密码、域、分辨率。

## 已知限制

- RDP 采用 Apache Guacamole 嵌入方案（画面嵌入应用内），需 **guacd**。来源（按优先级）：
  1. **应用内置**：Linux 打包时由 [`scripts/collect-guacd.sh`](scripts/collect-guacd.sh:1)
     自动收集 guacd 及其依赖进应用（AppImage 免系统安装）；
     Windows 如需内置，自行把 `guacd.exe` 放入 `resources/guacd/`
  2. 本机安装（Linux: `sudo apt install guacd`）
  3. 远程 guacd：环境变量 `GUACD_HOST`/`GUACD_PORT`（如 Docker 容器
     `docker run -d -p 4822:4822 guacamole/guacd`）
  应用已优雅降级：无 guacd 时 RDP 提示「不可用」，其它协议不受影响。
- 串口为直接模式（不做本地 PTY 桥接），依赖设备自身的回显行为；
  若设备不回显，可自行在代码中为串口终端启用 `localEcho`。
- 连接配置以明文 JSON 存储在 `userData/connections.json`，密码未加密。
