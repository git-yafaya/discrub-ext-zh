# Discrub 简体中文本地版

> Discrub 的非官方简体中文本地化版本，供个人本地使用。
>
> 当前汉化基于 **Discrub 2.1.7**，覆盖现代 Discrub 2.x 界面与扩展启动器；**Discrub Classic 旧版界面仍为英文**。

## 简介

Discrub 是一个用于浏览、搜索、筛选、导出和管理 Discord 消息的浏览器扩展与 Web 应用。

本地汉化补丁增加了完整的简体中文界面，包括：

- 服务器、频道、私信、讨论串与论坛帖子
- 消息搜索、二次筛选与批量加载
- HTML、纯文本、CSV、JSON 和媒体导出
- 批量编辑、删除消息、处理附件与表情回应
- Discord 数据包导入、浏览、联机补全与分析
- 设置、快捷键、新手引导、状态日志与错误提示
- 扩展启动器与简体中文日期格式
- `zh-CN`、`zh-Hans`、`zh-SG` 等浏览器语言自动识别

## 适用版本

| 项目 | 版本 |
|---|---|
| Discrub | 2.1.7 |
| 汉化补丁 | 1.0.1 |
| 基准提交 | `95d5f765d6b8e15ee1a4566d388185a63b460d9e` |
| 支持界面 | 现代 Discrub 2.x、扩展启动器 |
| 暂不支持 | Discrub Classic |

## 环境要求

建议准备以下环境：

- Git
- Node.js 20 或更高版本
- npm
- Chrome、Chromium、Edge，或其他兼容 Chromium 扩展的浏览器
- 至少 16 GB 内存；构建时建议启用 Swap

检查版本：

```bash
git --version
node --version
npm --version
```

## 应用汉化补丁

假设目录结构如下：

```text
~/App/
├── discrub/
└── Discrub-zh-CN-localization-v1.0.1/
```

进入汉化包目录：

```bash
cd ~/App/Discrub-zh-CN-localization-v1.0.1
```

应用补丁：

```bash
./scripts/apply-local.sh ../discrub
```

脚本会自动完成：

1. 检查目标仓库是否匹配；
2. 校验中文语言包；
3. 应用完整汉化补丁；
4. 检查翻译键、插值变量、富文本标签和首尾空格；
5. 识别并修复已经应用过的 1.0.0 版本。

正常结束时会看到中文语言包校验通过的提示。

## 安装依赖

进入 Discrub 项目：

```bash
cd ~/App/discrub
```

Discrub 当前存在已知的 npm peer dependency 声明冲突，因此必须使用：

```bash
npm ci --legacy-peer-deps
```

不要直接运行普通的：

```bash
npm ci
```

否则可能出现：

```text
npm error ERESOLVE could not resolve
```

如果上一次安装失败，可以先清理再安装：

```bash
rm -rf node_modules
npm ci --legacy-peer-deps --include=dev
```

## 构建 Chrome / Chromium 扩展

普通构建命令：

```bash
npm run build:extension:chrome
```

构建成功后，扩展目录位于：

```text
dist-extension-chrome/
```

### 低资源构建

全量测试和构建可能占用较多内存。16 GB 内存的电脑建议使用资源限制命令：

```bash
systemd-run --user --scope \
  -p MemoryMax=6G \
  -p MemorySwapMax=4G \
  -p CPUQuota=250% \
  bash -lc '
    cd ~/App/discrub &&
    NODE_OPTIONS=--max-old-space-size=4096 \
    nice -n 10 \
    npm run build:extension:chrome
  '
```

如果系统不支持 `systemd-run --user --scope`，使用简化版本：

```bash
cd ~/App/discrub

NODE_OPTIONS=--max-old-space-size=4096 \
nice -n 10 \
npm run build:extension:chrome
```

本地只想使用汉化版时，**不需要运行整个项目的 `npm test`**。全量 Vitest 会启动多个测试 worker，在内存较小的电脑上可能造成桌面卡顿甚至系统无响应。

## 安装到浏览器

1. 打开浏览器扩展管理页：

   ```text
   chrome://extensions
   ```

2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择：

   ```text
   /home/yafaya/App/discrub/dist-extension-chrome
   ```

5. 打开 Discord。
6. 启动 Discrub，并选择现代版本。
7. 进入：

   ```text
   设置 → 显示 → 语言 → 简体中文
   ```

如果浏览器语言本身是简体中文，并且 Discrub 尚未保存过语言设置，应用也会自动识别。

## 更新汉化后的代码

修改中文语言包后，只需要重新构建：

```bash
cd ~/App/discrub
npm run build:extension:chrome
```

随后回到：

```text
chrome://extensions
```

找到已加载的 Discrub，点击“重新加载”按钮即可。

## 可选：只运行汉化相关测试

不建议在普通本地使用场景中运行全量测试。需要检查汉化时，可限制为单 worker，只测试国际化模块：

```bash
cd ~/App/discrub

NODE_OPTIONS=--max-old-space-size=2048 \
npx vitest run \
  src/i18n/language.test.ts \
  src/i18n/localeParity.test.ts \
  src/i18n/coreMessages.test.ts \
  --maxWorkers=1 \
  --minWorkers=1
```

也可以单独运行语言包校验工具：

```bash
node ../Discrub-zh-CN-localization-v1.0.1/scripts/validate-zh-CN.mjs .
```

## 常见问题

### `npm error ERESOLVE could not resolve`

安装依赖时缺少兼容参数。重新运行：

```bash
rm -rf node_modules
npm ci --legacy-peer-deps --include=dev
```

### `vite: not found`

这通常表示前面的 npm 安装已经失败，所以 `vite` 并未安装。先成功执行：

```bash
npm ci --legacy-peer-deps --include=dev
```

然后再构建。

### 构建时电脑卡死

先不要运行全量：

```bash
npm test
```

检查内存与 Swap：

```bash
free -h
swapon --show
```

然后使用本 README 中的“低资源构建”命令。

### 界面仍然显示英文

依次检查：

```bash
grep -n "简体中文" src/i18n/language.ts
grep -n "zh-CN" src/i18n/index.ts
```

确认输出后，重新构建扩展，并在扩展管理页点击“重新加载”。再进入 Discrub 设置手动切换语言。

### Classic 仍然是英文

这是正常现象。Classic 是单独打包的旧应用，本汉化仅覆盖现代 Discrub 2.x 与启动器。

### 上游更新后补丁无法应用

汉化补丁以固定提交为基准。上游修改语言键或目录结构后，可能需要手动合并更新，不能保证旧补丁始终可直接应用。

## 撤销汉化

在 Discrub 仓库中执行：

```bash
git apply -R ../Discrub-zh-CN-localization-v1.0.1/discrub-zh-CN.patch
```

如果仓库还有其他未提交修改，先检查：

```bash
git status --short
```

不要直接运行 `git reset --hard`，除非你明确知道它会删除哪些本地改动。

## 安全说明

- 不要向他人发送或截图展示 Discord Token。
- 只在自己信任的本地设备和浏览器配置中使用。
- 批量删除、批量编辑和移除表情回应等操作不可逆，执行前务必确认目标范围。
- 长时间导出或清理时，请保留合理的请求间隔，避免频繁触发 Discord 限流。

## 已知限制

- Discrub Classic 尚未汉化。
- 少量第三方内容、公告或服务端返回文本可能仍显示英文。
- 中文文案基于当前版本制作，未来功能新增后可能出现缺失条目。
- 本项目为本地非官方汉化，不代表 Discrub 官方版本。

## 目录说明

汉化相关的主要文件：

```text
src/i18n/locales/zh-CN.json    简体中文语言包
src/i18n/index.ts              注册 zh-CN 资源
src/i18n/language.ts           语言列表与浏览器语言识别
src/i18n/dateLocale.ts         简体中文日期格式
src/i18n/language.test.ts      语言识别测试
src/i18n/localeParity.test.ts  语言键一致性测试
public/launcher.html           扩展启动器界面
public/launcher.js             启动器中文逻辑
```

## 声明

Discrub 的名称、图标和原始代码归其原作者所有。本地汉化仅用于个人学习与使用，不包含对原项目的所有权声明。
