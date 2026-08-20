# DSH-Windows桌面版 v0.1.0-rc.7

> ⚠️ **非官方声明**：本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**第三方 Windows 桌面封装**，并非 DeepSeek 官方产品，与深度求索（杭州）公司无任何关联。

## 这是什么

DSH-Windows桌面版 把 DeepSeek Harness（一个开源的 AI 编码智能体框架）包装成独立的 Windows 桌面应用：无需命令行、无需安装 Node.js，双击即用，像普通软件一样工作。应用内展示的版本号始终跟随 Harness 本体版本（本次发布对应 Harness `0.1.0-rc.7`）。

## 功能特性

- 🖥️ **零依赖**：内置 Node 运行时与 DeepSeek Harness 本体，目标机器无需安装任何环境
- 👥 **多账号隔离**：每个 API Key 一个独立账号，聊天记录彼此物理隔离、互不可见
- 🔄 **一键更新（带失败保护）**：菜单「检查更新」一键升级 Harness 本体，并自动同步升级第三方插件；
  更新前自动备份运行时，安装后先做完整性校验（版本一致 + 试启动 + 补丁语法检查），失败自动回滚到更新前版本，
  不会再出现「更新后打不开」的情况
- 🐋 **桌面精灵**：桌面悬浮鲸鱼娘，实时显示时间，支持闹钟与倒计时
- 📁 **原生工作区选择**：设置工作区时弹出 Windows 原生文件夹选择框（绕开部分机器上会崩溃的 koffi 组件）
- ⏰ **高峰时段提示条**：界面顶部提示高峰时段 token 价格贵、提醒节省 token（可临时关闭）
- 🧩 **查看已装 Skills**：菜单一键列出本机已安装技能的名称、功能描述与来源路径，支持搜索
- 🛡️ **定制自动重打**：垃圾箱删除保护、Full access 高风险警告、目录选择器等定制在每次启动和每次升级后自动重新应用；
  帮助窗口内置「当前版本相对原版 Harness 的差异清单」，逐项实测显示是否生效

## 安装

1. 下载本页下方的 `DSH-Windows桌面版 Setup 0.1.0-rc.7.exe`（或按构建产物实际命名）
2. 双击安装（默认装到用户目录，无需管理员权限）
3. 首次启动输入你的 DeepSeek API Key 登录（没有的话点登录页的「申请 API」去注册）

## 使用

- 登录后即可开始对话，让 AI 帮你编程、读写文件、执行任务
- 顶部 `Harness` 菜单 / 托盘右键菜单提供：检查更新、切换账号、注销账户、桌面精灵、查看已装 Skills、帮助等

## 从源码构建

1. 克隆本仓库（`dsh-runtime/`、`update-tools/`、`node_modules/` 已被 .gitignore 排除，需自行准备，详见 README）
2. 双击 `dist.bat`：自动检查 Node.js → 若本机已安装的桌面版运行时更新，自动镜像进打包目录 → 打包成安装包到 `dist/`

## 许可证与免责声明

- 本项目（外壳）基于 [Electron](https://github.com/electron/electron)（MIT）构建，内置 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT），详见仓库内 `THIRD-PARTY-NOTICES.md`
- 本客户端仅适用于 Windows；logo 与精灵形象由即梦 AI 辅助生成（图片内嵌国家要求的 AIGC 内容标注），并经作者人工编辑
- 仓库自带上传隐私自检钩子（pre-commit / pre-push），提交或推送时自动拦截 API Key、凭据文件等敏感内容
- 详见应用内「帮助 → 免责声明」

## 关注

对生命对科学感兴趣吗？请关注微信公众号【网柄菌】谢谢喵~
