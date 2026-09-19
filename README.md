# pi-issue

Pi 的轻量项目待办插件。随手记录问题和想法，在对话中选择一项处理，完成后保存结果与 Git 提交引用。

## 功能

- **记录待办**：通过自然语言或命令添加 issue，支持优先级和补充说明。
- **补充上下文**：使用 `/issues add` 时，自动尝试从最近对话中提取背景信息；模型不可用时仍会保存标题。
- **浏览与搜索**：查看未解决项、搜索关键词，或通过交互菜单选择 issue。
- **开始处理**：将 issue 交给当前对话中的 agent，保留处理会话记录，方便后续查阅。
- **记录结果**：标记完成、填写解决说明，并关联本地 Git commit。
- **本地存储**：待办保存在项目的 `.pi/issues.md`，方便阅读和纳入 Git 版本管理。

## 安装

需要 Node.js 22.19.0 或更高版本。开发验证使用 Pi `0.85.1`（`@earendil-works/pi-coding-agent`）。

从 GitHub 安装：

```sh
pi install git@github.com:Delthin/pi-issue.git
```

也可以安装本地目录：

```sh
pi install /absolute/path/to/pi-issue
```

安装后，在已有会话中运行 `/reload`。

## 使用

可以直接对 agent 说：

> 先记一下：登录接口的错误码需要统一，以后处理。

之后让 agent 列出待办、更新说明或记录完成结果，也可以使用以下命令：

| 命令 | 作用 |
| --- | --- |
| `/issues` | 查看未解决项 |
| `/issues add 补充部署文档` | 添加待办，并尝试补充对话上下文 |
| `/issues browse` | 交互浏览、搜索和选择 issue |
| `/issues show 3` | 查看详情、提交引用和处理会话记录 |
| `/issues search 登录` | 按关键词搜索 |
| `/issues start 3` | 在当前对话开始处理 #3 |
| `/issues done 3` | 标记为已解决 |
| `/issues link 3 a83f129` | 关联本地 Git commit，可填写多个 SHA |
| `/issues all` | 查看全部条目 |
| `/issues resume 3` | 查看处理会话历史和打开指引，别名为 `continue` |
| `/issues retry 3` | 启动失败后，确认并重新提交任务 |
| `/issues remove 3` | 确认后删除一条 issue |
| `/issues clear` | 确认后清理所有已解决项 |

`start` 会使用当前配置的模型开始工作。希望在新对话中处理时，先通过 Pi 新建对话，再执行 `/issues start <id>`。同一 issue 在当前对话启动后，继续聊天即可。

agent 可通过 `add_issue`、`list_issues`、`update_issue` 和 `resolve_issue` 管理待办。解决说明和补充信息支持多行文本。

## 数据存储

插件使用最近的 Git 仓库根目录；非 Git 项目使用当前工作目录。

- `.pi/issues.md`：待办、补充信息、解决说明和提交引用，可提交到 Git。
- `.pi/issues.local.json`：本机处理会话记录，包含本地路径，应加入 `.gitignore`。

建议将本地记录和临时文件加入 `.gitignore`：

```gitignore
.pi/issues.local.json
.pi/issues.local.json.lock
.pi/.issues.local.json.*.tmp
.pi/issues.md.lock
.pi/.issues.md.*.tmp
```

## 开发

```sh
npm ci --include=dev --ignore-scripts
npm run check
```

检查包含 TypeScript 类型检查、自动化测试和离线 smoke test。GitHub Actions 覆盖 Linux、macOS、Windows 上的 Node.js 22 / 24。

发布步骤见 [RELEASING.md](./RELEASING.md)。

## 许可证

[MIT](./LICENSE)
