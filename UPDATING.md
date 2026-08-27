# ZYXterm 自动更新发布指南

应用使用 **electron-updater** 自动检查更新，发布源为 **GitHub Releases**（`ZY953870777/ZYXterm`）。

## 工作原理

- 主进程启动 5 秒后自动检查更新，之后**每小时自动检查一次**（仅打包版；已下载/下载中不重复检查）
- 发现新版本后右下角出现"下载"按钮 → 下载完成提示"重启并安装"
- 更新源信息来自 electron-builder 打包时生成的 `app-update.yml`（由 `package.json` 的 `build.publish` 决定）

---

## 方式 A（推荐）：GitHub Actions 自动编译并发布

`.github/workflows/release.yml` 自动完成 **Windows + Linux** 双平台发布（两个 job 并行，上传到同一 Release）：

**Windows（windows-2022）**
1. 编译 FreeRDP 3.30（MSVC + vcpkg）
2. 编译 freerdp N-API addon（Electron ABI）
3. 将 DLL + `freerdp.node` 放入 `resources/freerdp/`
4. `npm ci --ignore-scripts`（serialport 用 N-API 预编译，无需重编译）
5. `electron-builder --win --publish always`：打包 NSIS 安装包并上传 `latest.yml` + 安装包 + `.blockmap`

**Linux（ubuntu-latest）**
1. `apt` 安装系统 FreeRDP3 开发库（`libfreerdp-dev`）
2. 编译 freerdp N-API addon（Linux），随包分发 `libfreerdp3.so.3`/`libwinpr3.so.3`（rpath 加载）
3. `electron-builder --linux --publish always`：打包 **AppImage + deb**，上传 `latest-linux.yml` + 安装包

### 发布步骤

1. **改版本号**：编辑 `package.json` 的 `version`（如 `0.1.1`），提交并推送。
2. **打标签**（触发自动编译发布）：
   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```
   （或在 GitHub 网页 Actions → **Release Windows + Linux x64** → **Run workflow** 手动触发。）
3. 等 workflow 跑完（约 20-40 分钟），GitHub 仓库 **Releases** 页会自动出现 `v0.1.1`，含 Windows 与 Linux 产物及各自的 `latest*.yml`。
4. 旧版本客户端启动后会自动检测到更新（electron-updater 按平台读取 `latest.yml` / `latest-linux.yml`）。

> 说明：Release 由 `GITHUB_TOKEN`（`permissions: contents: write`）创建，公开/私有仓库均可用，无需额外配置 PAT。编译与打包全部在 GitHub 完成，**无需本地 Docker 打包**。

---

## 方式 B：本地打包 + 手动上传

适合需要本地验证或离线发布的场景。

### 1. 本地打包

```bash
cd /mnt/l/lineup_server/zyxterm_electron
bash build-docker.sh win
```

> Windows 用的 FreeRDP dll + `freerdp.node` 来自 GitHub workflow
> （`build-windows-freerdp.yml`）产物，需先放入 `resources/freerdp/`。

产物在 `dist/`（或 `ZYXterm/`），自动更新需要：

- `ZYXterm-Setup-<version>.exe`
- `latest.yml`
- `*.blockmap`

### 2. 推送并发布

```bash
git add -A && git commit -m "release: v0.1.1"
git push origin main

# 用 GitHub CLI 上传为 Release
gh release create v0.1.1 \
  dist/ZYXterm-Setup-0.1.1.exe \
  dist/latest.yml \
  dist/ZYXterm-Setup-0.1.1.exe.blockmap \
  --title "ZYXterm v0.1.1" --notes "更新说明"
```

> ⚠️ `latest.yml` 必须与安装包在同一 Release 的 Assets 中，否则应用检查不到更新。

---

## 常见问题

- **更新检查失败 / 404**：确认 `build.publish` 的 owner/repo 正确、`latest.yml` 在 Release
  Assets 中、版本号高于已安装版本。
- **每小时检查是否打扰**：未发现新版本时右下角不显示任何提示；已下载更新后不再重复检查，等用户重启安装。
- **只支持 Windows**：当前 `win` 目标生成 `latest.yml`；Linux/mac 若需自动更新需另行配置。
