# 提交到 Awesome DSH Plugin 列表 / Submitting to awesome-dsh-plugin

按官方贡献指南（<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>）：
**一个 PR 只加一个文件** `data/plugins/<owner>__<repo>.yml`，两个 README 由脚本生成、**不要手改**。

## 先满足三条硬门槛

| 门槛 | 我们的状态 |
| --- | --- |
| 仓库 `package.json` 声明 **`dsh.bundle`**（只声明 `dsh.client` 是最常见的被拒原因） | ✅ `dsh.bundle.patch: ./cordis.patch.yml`，且 `cordis.patch.yml` 在仓库根 |
| 仓库里有**真实可用的代码**（占位/纯 README 不收） | ✅ 189 个离线用例 + e2e/负样本脚本 |
| 仓库**创建满 1 天** | ⚠️ 需要你先把仓库建好并等满 1 天再提 PR（当场提会被 CI 打回） |

## 步骤

1. **建公开仓库并推送**（把 `OWNER` 换成你的 GitHub 账号；`package.json` 里的 `repository` / `homepage` / `bugs`
   三处也要把 `OWNER` 换掉，npm 发布时 `repository` 必须指回本仓库）：

   ```sh
   cd E:/dshplugins/dsh-screenshot
   git remote add origin https://github.com/ntesicn/dsh-screenshot-xn.git
   git push -u origin main
   ```

2. **Fork** `awesome-dsh-plugin/awesome-dsh-plugin`，然后在你的 fork 里新增下面这个文件（名字必须是
   `data/plugins/ntesicn__dsh-screenshot-xn.yml`）。描述里含 `: ` 时必须加引号，否则 YAML 解析失败：

   ```yaml
   url: https://github.com/ntesicn/dsh-screenshot-xn
   name: ntesicn/dsh-screenshot-xn
   category: ui
   tarball: https://github.com/ntesicn/dsh-screenshot-xn/releases/latest/download/dsh-screenshot-xn-1.0.0.tgz
   description:
     en: 'Full-screen screenshot panel for DSH: marquee select, annotate, then insert, copy or save as, with offline OCR and translation.'
     zh: 'DSH 整屏截图面板：框选、标注，一键插入对话 / 复制 / 另存为，并支持离线 OCR 识别与翻译。'
   ```

   - `category` 取值来自官方列表；截图类工具用 `ui`（UI 增强）。若你更想突出识别能力，`vision` 也在表里。
   - `owner__repo` 的下划线是**两个**，文件名必须与仓库名一致。
   - `tarball:` 指向本仓库已发布的 Release 资产（`v1.0.0`）。它必须是 GitHub Release 托管的 https `.tgz` ——
     商店会优先展示它而不是源码构建命令。资产内容与本地 `npm pack` 的产物逐字节一致（SHA256
     `53B936EB4074584DEDFE334EDCED15663CFE4554412E0C21E97DE79518273729`，286012 字节）。

3. **开 PR**，标题例如 `Add ntesicn/dsh-screenshot-xn`。CI 会依次检查：条目数（≤3）→ 你仓库的 `dsh.bundle`
   → 仓库年龄（≥1 天）→ `awesome-lint` 与站点构建。失败时 PR 评论会指出要改什么，改完推到同一分支即可。

## 可选但推荐

- **发 npm**：市场会展示下载量并按下载量排序（收录与否不受影响）。发布时 `repository` 必须指回上面的仓库，
  映射由 registry 自动采集，**条目里不要写 `npm:` 字段**（会被校验拒绝）。
- **截图**：已在本仓库放好 `screenshots.json` + `assets/shot-*.png`（市场详情页会展示 App Store 风格截图）。
  之后换图只要推自己的仓库，下一次构建自动生效。
- **预构建 tarball**：已发布 —— <https://github.com/ntesicn/dsh-screenshot-xn/releases/tag/v1.0.0>
  （资产 `dsh-screenshot-xn-1.0.0.tgz`，286012 字节），条目里用 `tarball:` 指向它即可。
  本插件本来也能从源码安装（`dsh plugin add`），但 tarball 让商店优先给出"下载即用"的入口。
- **npm（本机网络受限）**：`www.npmjs.com` 在本机网络下返回 **403**（PowerShell 与浏览器一样），
  但 **registry 是通的**（`npm ping` → PONG）。所以注册/登录不能走网站，要走 CLI：

  ```sh
  npm adduser --registry=https://registry.npmjs.org/
  # 依次输入用户名 / 密码 / 邮箱，然后填邮箱里收到的一次性验证码
  npm whoami --registry=https://registry.npmjs.org/     # 确认登录成功
  ```

  登录成功后 token 会写进 `~/.npmrc`，之后直接 `npm publish` 即可（`package.json` 里的
  `publishConfig` 已把 registry 钉到官方源，避免本机默认的淘宝镜像把发布请求打回去）。

## 当前状态（已完成 / 待办）

| 项 | 状态 |
| --- | --- |
| 公开仓库 | ✅ <https://github.com/ntesicn/dsh-screenshot-xn>（`main`，`dsh.bundle` + `cordis.patch.yml` 就位） |
| 预构建 Release | ✅ `v1.0.0`：<https://github.com/ntesicn/dsh-screenshot-xn/releases/tag/v1.0.0> |
| 市场截图 | ✅ `screenshots.json` + `assets/shot-*.png` |
| npm 发布 | ⬜ 需要在能访问 npm 的网络/终端里 `npm adduser`（见上），然后 `npm publish` |
| 提 PR 收录 | ⬜ **等仓库创建满 1 天**后，在 `awesome-dsh-plugin` 加一个 `data/plugins/ntesicn__dsh-screenshot-xn.yml` |

## 本地打包

```sh
npm pack --pack-destination ../dist     # 产出 dsh-screenshot-xn-1.0.0.tgz（约 0.27MB，只含白名单文件）
```

包里**不含** ONNX 模型与 `node_modules`：模型在首次使用 OCR 时按需下载并校验 SHA256（`lib/ocr-models.mjs`）。
