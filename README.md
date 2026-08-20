# DSH-Windows桌面版

> ⚠️ **非官方声明**：本项目是开源项目 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**第三方 Windows 桌面封装**（Electron 外壳），
> **并非 DeepSeek 官方产品**，与 DeepSeek / 深度求索（杭州）公司**没有任何关联**，官方未参与、审核或背书本项目。
> "DeepSeek" 及相关名称、标识的权利归其各自权利人所有。使用前请自行确认相关服务条款。

把 DeepSeek Harness 的 Web 界面套进一个原生桌面窗口，体验接近独立软件：
无地址栏/浏览器边框、单实例、关闭窗口最小化到系统托盘、自动拉起 `dsh web`。

> 与 `../DSH-Desktop.bat` 的区别：那个复用 Edge 的 `--app` 窗口；这个用 Electron 自带内核，
> 可打包成 `DSH-Windows桌面版.exe`，有独立应用图标和托盘。

## 开源许可证

本项目（壳子）基于 [Electron](https://github.com/electron/electron)（MIT）构建，内置
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）本体。详见
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

## 运行前提

- **打包后的 exe 零依赖**：Node 运行时复用 Electron 内置的 Node（`ELECTRON_RUN_AS_NODE`），
  dsh 则随安装包一起分发（`dsh-runtime/`，经 `extraResources` 打进 resources）。
  目标机器**无需安装 Node.js 或 dsh**，双击即可用。
- **开发模式（`npm start` / `start.bat`）**仍需本机有 Node.js 和 `@deepseek-ai/dsh`
  （在 npx 缓存或全局安装），找不到会回退弹窗提示。

## 运行

- **双击 `start.bat`**（推荐，绕过 PowerShell 执行策略），或：
```powershell
cd <你的项目目录>\electron
npm.cmd start          # 用 npm.cmd 避免 .ps1 执行策略报错
```

> 若坚持用 `npm start`，先放行脚本：`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`

## 打包成 exe

- **双击 `dist.bat`**（推荐），自动装 electron-builder 并打包；或：
```powershell
cd <你的项目目录>\electron
npm.cmd install --save-dev electron-builder   # 首次打包前
npm.cmd run dist
```

产物在 `dist/`：NSIS 安装包（`.exe`）等。安装包体积较大（约 200MB+），
因为内置了 dsh 的完整运行时（约 246MB，打包后经 LZMA 压缩）。

> 打包前需保证 `dsh-runtime\node_modules\...` 已就位（`dist.bat` 会自动检查）。
> 首次搭建时用：
> `robocopy "%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules" "dsh-runtime\node_modules" /E`

## 从源码构建（给开发者）

`.gitignore` 排除了体积大 / 含第三方包的内容，clone 源码后需自行准备以下目录才能打包：

1. **装依赖**：
   ```powershell
   cd electron
   npm install
   ```

2. **准备 `dsh-runtime/`（DeepSeek Harness 完整运行时）**：
   ```powershell
   mkdir dsh-runtime
   cd dsh-runtime
   npm init -y
   npm install @deepseek-ai/dsh@0.1.0-rc.6
   cd ..
   ```
   这会在 `dsh-runtime/node_modules` 装好 dsh 及其全部依赖，并生成 `package.json`。

3. **准备 `update-tools/npm/`（内置 npm CLI，供"检查更新"用）**：
   ```powershell
   robocopy "D:\你的Node安装目录\node_modules\npm" "update-tools\npm" /E
   ```
   （路径换成你本机 Node 安装目录下的 `node_modules\npm`）

4. **打包**：双击 `dist.bat`，产物在 `dist/`。

## 行为说明

- 启动时若 `127.0.0.1:3080` 未运行，自动以隐藏方式拉起 `dsh web`（日志写在 `dsh-server.log`）；
- 关闭窗口 = 最小化到托盘，服务继续跑；托盘「退出」才真正退出（并停掉它自己拉起的服务）；
- 外部链接一律交给默认浏览器，不会在壳内打开。

## 顶部 Harness 菜单

窗口顶部常驻 `Harness` 菜单（托盘右键菜单同款）：

| 菜单项 | 作用 |
|---|---|
| `DeepSeek Harness x.y.z` | 显示当前 Harness 版本（灰显） |
| 检查更新 | 查 npm 上 `@deepseek-ai/dsh` 新版，可一键更新，并同步升级 profile 中的第三方插件（失败自动回滚） |
| 切换账号（API Key） | 切到登录页（预填当前 key），登录后加载该账号数据 |
| 注销账户 | 退出当前账号并回到登录页（窗口不关闭），聊天记录保留在该账号下 |
| 申请 API（注册账户） | 用默认浏览器打开 DeepSeek 开放平台 `https://platform.deepseek.com/` |
| 桌面精灵 | 桌面悬浮鲸鱼娘：实时时间、闹钟、倒计时 |
| 查看已装 Skills | 弹出独立窗口，列出本机已装 skills 的名称、功能描述与来源路径（带搜索框） |

登录页（未登录状态下的主窗口界面）提供：API Key 输入框、登录按钮、以及「申请 API（注册账户）」链接。

## 多账号隔离

- 每个 API Key 对应一个独立账号，数据根目录为 `~/.dsh-accounts/<key哈希前16位>/`，
  会话记录、凭据、设置彼此**物理隔离**；
- 注销后回到登录页（窗口不关闭）；再次登录同一 key 恢复该账号的记录，登录其他 key 看不到别的账号数据；
- 首次用旧 `~/.dsh` 里的 key 登录时，会自动把旧数据（sessions/storages/settings）迁移到对应账号目录。

## 目录选择器修复

- Windows 上 dsh 默认用 native 文件夹选择器（koffi + Win32 对话框 worker），在部分机器上
  koffi 原生崩溃（[官方 discussion #197](https://github.com/deepseek-ai/deepseek-harness/discussions/197)），
  导致设置工作区时报 `win32 folder dialog worker exited before reporting a result`；
- 本壳已把 native 选择器的 Win32 实现**改用 PowerShell 的 FolderBrowserDialog**（绕开 koffi），
  默认初始目录为 exe 安装位置（经 `DSH_APP_DIR` 传入）；每次更新 dsh 后 `applyNativePickerPatch` 会自动重打补丁。

## 自动更新

- **检测对象**：npm 上的 `@deepseek-ai/dsh`（即 Harness 本体）新版本；
- **时机**：仅手动 —— 托盘菜单「Check for Updates」点击后检查（不做定时自动检查）；
- **流程**：发现新版 → 弹窗询问 → 点「Update Now」→ 停服务、把运行时复制到 `%APPDATA%\dsh-windows-desktop\dsh-runtime`、
  用内置 Node 跑打包的 npm 安装新版 → 同步升级第三方插件 → 自动重启服务并刷新页面；
- **第三方插件同步**：通过 dsh CLI 的 pnpm 转发器（`dsh plugin --profile web update <插件>`）把 profile
  `package.json` 里同时声明在 `dsh.profile.bundles` 的插件升级到最新（自动写入 `minimumReleaseAge: 0`，避免 pnpm 11
  对新发布版本静默跳过）；Harness 已是最新时点「检查更新」也会单独同步插件。插件同步失败不影响 Harness 本体更新，会在结果弹窗中提示；
- **失败保护**：更新前自动把当前运行时备份为 `%APPDATA%\dsh-windows-desktop\dsh-runtime.prev`；安装后先校验完整性
  （bin.js 存在、版本一致、能在随机端口试启动、补丁文件语法合法），任一环节失败自动回滚到更新前版本并重启服务；
- **版本号**：应用展示的版本（窗口标题/托盘/菜单）始终跟随 Harness 版本，更新后自动变化；
  `dist.bat` 打包前也会把 `package.json` 的 version 同步成 dsh 版本，使 exe 文件属性版本号一致；
- **打包前自动同步**：`dist.bat` 打包前会对比「已安装应用里的运行时」与「打包用的 `dsh-runtime`」版本，
  已安装的更新时自动镜像进来（`runtime-refresh-check.js`），因此更新 Harness 后直接打包即可携带新版本；
- **前提**：更新需要能访问 `registry.npmjs.org`。更新后运行时落在 userData 目录（可写），不碰安装目录。

## 文件

| 文件 | 作用 |
|---|---|
| `main.js` | 主进程：单实例锁、拉起服务、窗口、托盘、自动更新 |
| `runtime-refresh-check.js` | `dist.bat` 辅助：比较已安装运行时与打包运行时的新旧 |
| `refresh-runtime.bat` | 把已安装应用里「更新后、已打补丁」的运行时镜像到 `dsh-runtime/`（dist.bat 打包前也会自动做） |
| `gen-icon.ps1` | 用 .NET 生成 `assets/icon.png`、`assets/tray.png` 图标 |
| `convert-logo.ps1` | 把源图转成 `icon.png`/`tray.png` |
| `electron-builder.yml` | 打包配置（afterPack 钩子复制 dsh-runtime 与 update-tools） |
| `after-pack.js` | afterPack 钩子：绕过 electron-builder 对 node_modules 的排除，复制完整运行时 |
| `dsh-runtime/` | dsh 完整运行时（打包进 exe；`package.json` 供 npm 更新） |
| `update-tools/npm/` | 内置 npm CLI（更新时用） |
