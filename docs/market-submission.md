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
   description:
     en: 'Full-screen screenshot panel for DSH: marquee select, annotate, then insert, copy or save as, with offline OCR and translation.'
     zh: 'DSH 整屏截图面板：框选、标注，一键插入对话 / 复制 / 另存为，并支持离线 OCR 识别与翻译。'
   ```

   - `category` 取值来自官方列表；截图类工具用 `ui`（UI 增强）。若你更想突出识别能力，`vision` 也在表里。
   - `owner__repo` 的下划线是**两个**，文件名必须与仓库名一致。

3. **开 PR**，标题例如 `Add ntesicn/dsh-screenshot-xn`。CI 会依次检查：条目数（≤3）→ 你仓库的 `dsh.bundle`
   → 仓库年龄（≥1 天）→ `awesome-lint` 与站点构建。失败时 PR 评论会指出要改什么，改完推到同一分支即可。

## 可选但推荐

- **发 npm**：市场会展示下载量并按下载量排序（收录与否不受影响）。发布时 `repository` 必须指回上面的仓库，
  映射由 registry 自动采集，**条目里不要写 `npm:` 字段**（会被校验拒绝）。
- **截图**：已在本仓库放好 `screenshots.json` + `assets/shot-*.png`（市场详情页会展示 App Store 风格截图）。
  之后换图只要推自己的仓库，下一次构建自动生效。
- **预构建 tarball**：若你的仓库无法从源码安装，需要把 `.tgz` 挂到 GitHub Release 并在条目里用
  `tarball: https://github.com/ntesicn/dsh-screenshot-xn/releases/latest/download/dsh-screenshot-xn-1.0.0.tgz`
  指向它。本插件可以从源码安装（`dsh plugin add`），所以这一项不是必需的 ——
  但注意 `onnxruntime-node` 的 postinstall 需要下载原生库，从源码安装时 DSH 会要求**批准构建脚本**；
  发布 npm 包可以免掉这一步。

## 本地打包

```sh
npm pack --pack-destination ../dist     # 产出 dsh-screenshot-xn-1.0.0.tgz（约 0.27MB，只含白名单文件）
```

包里**不含** ONNX 模型与 `node_modules`：模型在首次使用 OCR 时按需下载并校验 SHA256（`lib/ocr-models.mjs`）。
