# 提交到 Awesome DSH Plugin 列表 / Submitting to awesome-dsh-plugin

按官方贡献指南（<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>）：
**一个 PR 只加一个文件** `data/plugins/<owner>__<repo>.yml`，两个 README 由脚本生成、**不要手改**。

## 三条硬门槛

| 门槛 | 我们的状态 |
| --- | --- |
| 仓库 `package.json` 声明 **`dsh.bundle`**（只声明 `dsh.client` 是最常见的被拒原因） | ✅ `dsh.bundle.patch: ./cordis.patch.yml`，且 `cordis.patch.yml` 在仓库根 |
| 仓库里有**真实可用的代码**（占位/纯 README 不收） | ✅ 195 个离线用例 + e2e/负样本脚本 |
| 仓库**创建满 1 天** | ✅ 仓库建于 2026-10-02，已满 |

## 已提交的内容

PR：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6538>（标题 `Add ntesicn/dsh-screenshot-xn`）

这条 PR 就是**唯一**的上架通道：DSH 市场本身（`node_modules/dshmarket`）不是插件目录，它每次打开都实时拉
`https://awesome-dsh-plugin.com/plugins.json`（`src/regions.ts:80` `CATALOG_OFFICIAL`），而那份数据由精选列表
的 CI 每日生成。所以**合并后站点与本机市场会自动收录，通常一天内生效**，不需要再往别处提交。

新增的唯一文件 `data/plugins/ntesicn__dsh-screenshot-xn.yml`：

```yaml
url: https://github.com/ntesicn/dsh-screenshot-xn
name: ntesicn/dsh-screenshot-xn
category: vision
description:
  en: 'Full-screen screenshot panel for the DSH composer: ...'   # 661 字符，见文件
  zh: 'DSH 输入框旁的整屏截图面板：...'                            # 245 字符，见文件
tarball: https://github.com/ntesicn/dsh-screenshot-xn/releases/latest/download/dsh-screenshot-xn.tgz
```

- `category` 用 `vision`（官方合法取值之一）。截图工具原本也可填 `ui`；选不准不会被打回，维护者会直接改。
- `owner__repo` 的下划线是**两个**，文件名必须与仓库名一致。
- 描述含 `: ` 时必须加引号；`zh` 里所以用全角冒号规避。
- `tarball:` 指向本仓库已发布的 Release 资产，必须是 GitHub Release 托管的 https `.tgz`。贡献指南
  （`contributing.md:116-128`）给出两种等价格式：钉版 `releases/download/v1.2.0/name-1.2.0.tgz`，或
  稳定名 `releases/latest/download/name.tgz`；**我们用后者**，于是以后发版不必再动条目（见「发版流程」）。
- 描述必须**属实**、无营销词与最高级 —— 维护者会读目标仓库源码逐条核对。

## 编码事故（已修复）

第一版用 shell 传中文，`description.zh` 的汉字被压成了 **157 个字面 `?`**（文件里 non-ASCII 字节数为 0）。
同一个问题也让 PR 描述正文乱码。修复方式：

- 用 `write` 工具（而非命令行）重写条目文件为 UTF-8（LF、无 BOM、末尾换行，1463 字节、non-ASCII 480 字节）。
- 提交 `dc3987e Fix mojibake in the zh description for ntesicn/dsh-screenshot-xn`（提交信息用 ASCII）并推到同一分支。
- PR 描述正文通过 GitHub API 重写（`PATCH /repos/.../pulls/6538`）。

**教训**：向 git / GitHub 传中文一律走文件写入，绝不经 PowerShell 参数或管道拼接；提交信息保持 ASCII。

## 前置开关（新机器为什么会"退回旧行为"）

在一台**新机器**上从 git 安装后复现：点截图是"DSH 窗口里先出一张冻结帧、再在这张图上框选"，而不是整屏面板。

根因不在本插件，也不是版本不一致（两端 HEAD 都是 `7992ccc`）：DSH Desktop 的 webServer 上有一道闸门
（实测 2.0.15：`lib/webserver.js` 的 `permits()` 每请求现查 `desktopBrowserAccess`；
`lib/desktop-browser-access-*.js` 的 `decideDesktopBrowserAccess`）。`ordinaryBrowserEnabled`（即 `openBrowser`，默认 `false`）
为假时，**一切非 Electron 渲染器请求一律 `403` + 正文 `forbidden`**。而面板页恰恰是由普通浏览器（kiosk 窗口）加载的，
所以默认设置下必然被拒；插件预检命中 `desktop-browser-access-denied` 后按设计回退到 DSH 内覆盖层。
本机能用，只是因为本机 profile 补丁里手工开了这个开关。

评估过但**放弃**的架构改法，记在这里免得重走：
① 插件自带一个只绑 `127.0.0.1` 的回环 origin 来承载面板 —— 可行（面板里的请求全是绝对路径
`/api/dsh-screenshot/overlay/...`，换 origin 后**面板一行都不用改**），代价是多一个监听口；
② 插件在宿主上下文里调 `desktopBrowserAccess.setOrdinaryBrowserEnabled(true)` —— 可行且立即生效，
但等于**静默拆掉 DSH Desktop 的安全闸门**（把整个 DSH API 暴露给任意本机进程/网页），不做。

**用户决定：不改架构，如实补文档。** 已落地：README 的「安装 → 前置开关」小节、故障排查表新增 403 那一行、
「局限」第 2 条改写、「功能与交互」的可用性判定补充；市场条目 en/zh 描述各补一句
（DSH Desktop 默认不放行普通浏览器访问，整屏面板还需打开「允许在浏览器中打开」）。

## 本地自检

```sh
node E:/dshplugins/.market/validate.cjs
```

校验条目键名合法、`en`/`zh` 均以句号结尾、`category` 在白名单、`tarball` 匹配
`^https://github\.com/.+/releases/download/.+/.*\.tgz$`（用 `js-yaml` 解析 `E:/dshplugins/.market/ntesicn__dsh-screenshot-xn.yml`）。

## CI

| 检查 | 结果 |
| --- | --- |
| `Submission gate` | ✅ 首个提交 `2fb4338` 通过：`dsh.bundle` declared, repo old enough, enough commits |
| `check` | ✅ 修复提交 `dc3987e` 上通过（`success`）；此时 PR `mergeable_state = clean`、2 commits / +7 −0 |

CI 绿灯只是前置条件；维护者会读源码核对描述与分类，并检查 PR 是否动了无关条目。反馈以 PR 评论给出，改完推到同一分支即可。

## 当前状态（已完成 / 待办）

| 项 | 状态 |
| --- | --- |
| 公开仓库 | ✅ <https://github.com/ntesicn/dsh-screenshot-xn>（`main`，`dsh.bundle` + `cordis.patch.yml` 就位） |
| 预构建 Release | ✅ <https://github.com/ntesicn/dsh-screenshot-xn/releases/tag/v1.1.0>（资产 `dsh-screenshot-xn-1.1.0.tgz` 387680 字节 / 34 个文件，外加稳定名 `dsh-screenshot-xn.tgz`；`v1.0.1`、`v1.0.0` 亦在） |
| 市场截图 | ✅ `screenshots.json` + `assets/shot-*.png` |
| 提 PR 收录 | ✅ PR #6538 已开，等维护者 review / 合并 |
| npm 发布 | ⬜ 需要在能访问 npm 的网络/终端里 `npm adduser`（见下），然后 `npm publish` |

## 可选但推荐

- **发 npm**：市场会展示下载量并按下载量排序（收录与否不受影响）。发布时 `repository` 必须指回上面的仓库，
  映射由 registry 自动采集，**条目里不要写 `npm:` 字段**（会被校验拒绝）。
- **npm（本机网络受限）**：`www.npmjs.com` 在本机网络下返回 **403**（PowerShell 与浏览器一样），
  但 **registry 是通的**（`npm ping` → PONG）。所以注册/登录不能走网站，要走 CLI：

  ```sh
  npm adduser --registry=https://registry.npmjs.org/
  # 依次输入用户名 / 密码 / 邮箱，然后填邮箱里收到的一次性验证码
  npm whoami --registry=https://registry.npmjs.org/     # 确认登录成功
  ```

  登录成功后 token 会写进 `~/.npmrc`，之后直接 `npm publish` 即可（`package.json` 里的
  `publishConfig` 已把 registry 钉到官方源，避免本机默认的淘宝镜像把发布请求打回去）。

## 发版流程（每次都一样）

1. 改 `package.json` 的 `version`，提交（`Release X.Y.Z: ...`）并 `git push origin main`。
2. 打包：`npm pack --pack-destination ../dist` → `dsh-screenshot-xn-X.Y.Z.tgz`；再把同一份字节复制成稳定名
   `dsh-screenshot-xn.tgz`（市场条目用的固定地址）。
3. 建 Release，**两个资产都上传**：`dsh-screenshot-xn-X.Y.Z.tgz`（仓库惯例，与 v1.0.0/v1.0.1 一致）与稳定名
   `dsh-screenshot-xn.tgz`。走 API：
   `POST /repos/ntesicn/dsh-screenshot-xn/releases`（`tag_name: "vX.Y.Z"`、`target_commitish: "main"`），
   再 `POST https://uploads.github.com/repos/ntesicn/dsh-screenshot-xn/releases/<id>/assets?name=<文件名>`
   （`Content-Type: application/gzip`，二进制直传）。Release 正文沿用「`## 版本` + 每条中英对照 + 安装小节」的格式。
4. 核对：`https://github.com/ntesicn/dsh-screenshot-xn/releases/latest/download/dsh-screenshot-xn.tgz`
   返回 `200` 且字节数与本地一致。
5. **市场条目不用改**（条目指向 `latest/download/` 的稳定名）；只有从钉版格式切到稳定名时改一次。
   改了条目就推到 PR 分支，PR 自动更新，CI 会重跑。
6. 用户侧拿到新版：插件仓库 `git pull` + **重启 DSH Desktop**（宿主半只在进程启动时加载）。
   npm 发布是可选的另一条路（见上），条目里不要写 `npm:` 字段。

## 本地打包

```sh
npm pack --pack-destination ../dist     # 1.1.0 实测：387680 字节 / 34 个文件（1.0.1 是 33 个 / 287776 字节）
```

包里**不含** ONNX 模型与 `node_modules`：模型在首次使用 OCR 时按需下载并校验 SHA256（`lib/ocr-models.mjs`）。
`docs/` 不在 `package.json` 的 `files` 白名单里，改本文档不影响发布产物。
