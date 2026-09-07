# VNC 自定义按键映射（含鼠标侧键）

ZYXterm 的 VNC 连接支持自定义映射表：**按下任意键（或鼠标键）时，改为向远端
发送任意组合键**。例如：

| 源（按下） | 目标（发送） |
|---|---|
| `f12` | `ctrl+shift+p` |
| `ctrl+alt+k` | `ctrl+w` |
| `mouse_back` | `alt+left` |
| `mouse_forward` | `alt+right` |

映射按列表顺序匹配，第一条命中的生效。

## 1. 配置位置

"新建/编辑连接 → VNC → 自定义按键映射"：

- 每行是一条映射：`源 → 目标`；
- 每行有"录制"按钮：点击后直接按下要识别的键即可，不需要手写字符串；
  - 源：可录制键盘组合，也可录制鼠标中键/右键/侧键；
  - 目标：只接受键盘组合；
  - 录制中按 `Esc` 取消；鼠标左键请手动输入 `mouse_left`；
- 也可以手动编辑输入框（支持导入/导出配置）；
- 点"＋ 添加映射"增加任意条，点行尾 `×` 删除；
- 默认已配置两条（可删改）：
  - `mouse_back → ctrl+alt+minus`
  - `mouse_forward → ctrl+shift+minus`

## 2. 写法说明

### 2.1 源（from）

- 键盘键或组合：`f12`、`ctrl+alt+k`、`shift+F2`、`a`、`;`、`[`；
- 鼠标键：
  - `mouse_left`（左键，谨慎使用）
  - `mouse_middle`（中键）
  - `mouse_right`（右键）
  - `mouse_back`（后退侧键）
  - `mouse_forward`（前进侧键）

### 2.2 目标（to）

目标必须是键盘组合键，例如 `ctrl+shift+p`、`ctrl+alt+minus`、`alt+left`。

支持的键名：

- 修饰键：`ctrl` / `shift` / `alt` / `meta` / `super`，左右区分可用
  `control_l`、`shift_r`、`alt_l` 等；
- 单字符：`a`、`1`、`;`、`[`、`-` 等（区分大小写）；
- 命名键：`F1`~`F35`、`left/right/up/down`、`pageup/pagedown`、`home/end`、
  `insert/delete`、`tab/enter/escape/backspace/space`、`kp_0`~`kp_9`、
  `kp_add`、`kp_enter`、`audio_mute`、`volumeup`、`media_next`、
  `browser back/forward` 等；
- 任意 keysym：`0x1234`（X11 keysym）、`unicode:4e2d`（Unicode 码点）；
- 组合键用 `+` 连接；加号键本身写作 `plus`。

### 2.3 匹配规则

- 键盘源按键按**修饰键精确匹配**：配置 `f12` 时，按住 Ctrl 再按 F12 不会触发；
  需要时请写 `ctrl+f12`；
- 键名以物理键位（`KeyboardEvent.code`）解析，适合标准 US 布局；
- 源键不会再发给远端，只有映射后的目标组合会发送；
- 目标组合中"用户当前已按住的修饰键"不会重复按下/释放；源组合里多出来、
  目标不需要的修饰键会临时释放，发完再恢复（如 `ctrl+alt+k → ctrl+w`
  不会把 alt 带进目标）；
- 映射仅在 VNC 画布拥有焦点时生效；
- 无法解析的源/目标会被忽略，不会影响其它映射。

## 3. VS Code 默认前进/后退快捷键

| 动作 | 命令 ID | 默认快捷键 |
|---|---|---|
| 后退（Go Back） | workbench.action.navigateBack | `Ctrl+Alt+-`（减号） |
| 前进（Go Forward） | workbench.action.navigateForward | `Ctrl+Shift+-`（减号） |

注意：VS Code 的"键盘快捷方式"编辑器只接受键盘按键，**不会录制鼠标侧键**，
因此在里面点击侧键没有反应是正常现象。

## 4. 远端诊断（RealVNC / VS Code）

在远端 Ubuntu 的终端运行（Xorg 会话）：

```bash
sudo apt install x11-utils
xev -event mouse
```

点击侧键：

- 看到 `button 8` / `button 9`：事件已到达远端，问题在应用侧；
- 什么也没有：VNC 客户端/服务端没有转发侧键。

使用 ZYXterm 的映射功能时，远端收到的是映射后的**键盘组合**，`xev` 里看不到
button 8/9，但 VS Code 的导航仍会生效。

Wayland 会话下 `xev` 不可用，可用 `wev`（`sudo apt install wev`）观察。
RealVNC 通常使用 Xorg 会话，建议登录时选择 "Ubuntu on Xorg"。

## 5. 其它 VNC 客户端下的兜底（xbindkeys）

如果使用 RealVNC Viewer 等第三方客户端，且 `xev` 能看到 button 8/9，但应用
不响应，可在远端 Ubuntu（Xorg 会话）把侧键翻译成键盘快捷键：

```bash
sudo apt install xbindkeys xdotool

cat >> ~/.xbindkeysrc <<'EOF'
"xdotool key --clearmodifiers ctrl+alt+minus"
  b:8
"xdotool key --clearmodifiers ctrl+shift+minus"
  b:9
EOF

killall xbindkeys 2>/dev/null
xbindkeys
```

说明：

- `b:8` / `b:9` 是 X11 鼠标按钮编号（8=后退，9=前进）；
- `minus` 是减号键名，不能写成 `-`；
- 只对 **Xorg** 会话有效；
- 开机自启：把 `xbindkeys` 加入"启动应用程序"。

## 6. 实现注意

RFB 普通 PointerEvent 的 button-mask 只有 U8，首字节 bit7 是
`ExtendedMouseButtons` 扩展事件的 marker bit。不要手工往普通 PointerEvent
里塞 bit7/bit8，否则服务端后续报文会错位，导致画面黑屏/连接断开。需要真实
Button8/9 时，应依赖服务端对 `ExtendedMouseButtons`（伪编码 -316）的支持，
或使用本页的键盘映射方案。
