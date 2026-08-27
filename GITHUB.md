# 将 ZYXterm 上传到 GitHub

本文档说明如何把本项目推送到 GitHub，并触发「Build Windows guacd」工作流
（自动编译 Windows 版 `guacd.exe` 供下载）。

## 一、前提

- 已安装 `git`
- 已配置 git 用户（若未配置）：

  ```bash
  git config --global user.name "你的名字"
  git config --global user.email "你的邮箱"
  ```

- 已在 GitHub 注册账号

## 二、在 GitHub 上创建仓库（网页操作）

1. 登录 GitHub，点右上角 **＋ → New repository**
2. 填仓库名（如 `ZYXterm`）、可选描述；**Public 或 Private** 均可
3. **不要**勾选 "Add a README" / ".gitignore" / "license"（避免冲突）
4. 点 **Create repository**

创建后会显示远程地址，形如：
`https://github.com/<你的用户名>/ZYXterm.git`

## 三、本地初始化并提交

在项目根目录执行：

```bash
cd /home/zhaoyang/projects/ZYXterm

# 1. 初始化 git 仓库
git init

# 2. 暂存所有文件（node_modules/dist/out/docker-cache 等已由 .gitignore 排除）
git add -A

# 3. 查看将被提交的文件（确认没有大文件/敏感文件）
git status --short

# 4. 提交
git commit -m "init: ZYXterm - MobaXterm-like terminal (SSH/Serial/VNC/RDP)"
```

## 四、关联远程仓库并推送

```bash
# 5. 关联远程仓库（换成你自己的地址）
git remote add origin https://github.com/<你的用户名>/ZYXterm.git

# 6. 推送（首次用 -u 建立跟踪）
git push -u origin main
```

> 若默认分支是 `master`，可改推 master；或先改名：
> `git branch -M main`

> 提示：HTTPS 推送需要输入 GitHub 用户名 + **Personal Access Token（PAT）**，
> 密码不再是密码框。生成 PAT：GitHub → Settings → Developer settings →
> Personal access tokens → 勾选 `repo` 权限。也可改用 SSH：
> `git remote set-url origin git@github.com:<你的用户名>/ZYXterm.git`

## 五、触发「Build Windows FreeRDP」工作流

workflow（`.github/workflows/build-windows-freerdp.yml`）为**手动触发**，
用于编译 Windows 版 FreeRDP 3.23.0 运行库 + 开发包 + ZYXterm 的 RDP addon：

1. 打开仓库 → **Actions** 标签
2. 左侧选 **Build Windows FreeRDP**
3. 右侧点 **Run workflow → Run**

运行成功后，在 workflow 页面底部的 **Artifacts** 下载 **freerdp-win64**。

## 六、使用编译出的 guacd（Windows 内置）

1. 解压 `guacd-win64.zip`
2. 把 `guacd.exe` 及所有 DLL 放入工程的 `resources/guacd/`
   （注意：该目录的二进制已被 `.gitignore` 忽略，不会误提交）
3. 重新打包：`npm run dist:win`
4. 应用会**优先使用内置 guacd**，Windows 本地即可嵌入 RDP

> 若 workflow 编译失败（Guacamole server 的 Windows 移植不完善），
> 请改用**远程 guacd**：在任意有 docker 的机器执行
> `docker run -d -p 4822:4822 guacamole/guacd`，
> 运行应用前设置 `GUACD_HOST` 指向该机器 IP。

## 七、后续更新代码

```bash
git add -A
git commit -m "说明本次改动"
git push
```
