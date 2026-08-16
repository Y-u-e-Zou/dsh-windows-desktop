# DSH 上传隐私自检（privacy guard）

`pre-commit` 与 `pre-push` 两个 git 钩子会在每次 `git commit` / `git push` 之前，
自动扫描**即将进入版本库 / 即将推送到 GitHub** 的内容，发现个人隐私即阻止并逐条报告位置。

## 检测内容

| 级别 | 检测项 | 处理 |
| --- | --- | --- |
| 拦截 | API Key / Token：DeepSeek/OpenAI 风格长密钥（sk- 开头）、GitHub PAT（ghp_ / github_pat_）、AWS AKIA 等 | 阻止，报告 文件:行 |
| 拦截 | 带字面值的密码（password: "..."） | 阻止，报告 文件:行 |
| 拦截 | 隐私文件：`.credentials.yaml`、`.env*`、`account-state.json`、`pet-chat-history.json`、`pet-persona.json`、`pet-backend.json`、`pet-schedule.json`、`sessions/`、`storages/`、`settings.yaml`、`*.log`、`.npmrc`、SSH 私钥、`.dsh/`、`.dsh-accounts/` | 阻止，报告文件名 |
| 警告 | 个人邮箱、本地绝对路径（如 `C:\Users\<name>` 或你的项目盘路径） | 提示，不阻止；`-Strict` 可升级为拦截 |
| 警告 | 图片内嵌创作元数据（Photoshop XMP / AIGC 生成标记） | 提示，不阻止 |

## 使用

- 本机当前仓库已启用。
- 新克隆 / 换机器：**双击 `dist.bat` 构建时会自动启用**，无需手动配置；
  兜底命令：`git config core.hooksPath .githooks`
- 紧急放行（自担风险）：`git commit --no-verify` / `git push --no-verify`
- 手动试跑：`pwsh -NoProfile -File .githooks/guard.ps1 -Mode commit`

## 局限

- 只拦截通过 `git` 命令行进行的提交/推送；网页拖拽上传、直接复制文件到其他仓库不受保护。
- 基于模式匹配，无法识别语义层面的「个人习惯」内容；请结合人工确认。
