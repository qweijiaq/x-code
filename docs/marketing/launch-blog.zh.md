# X-Code 社区发布：博客写作方案与初稿

> 面向中文技术社区（V2EX、少数派、掘金、即刻/小红书）的发布稿。英文 HN / Reddit 版本见文末提纲。文中数字、限制和安装步骤均以 1.0.5 为准。

## 一、先定一句话定位

不要写成“Claude Code 的替代品”或“最强 AI 编程工具”。这两个说法会立刻把读者带进参数对比和立场争论，也容易招致反感。更准确、也更有辨识度的定位是：

> **一个本地优先、模型无关的开源 AI 编程工作台：桌面和终端共用同一套会话、技能、MCP 和记忆，模型和 Key 由你自己选。**

这句话包含三个差异点：模型自选、桌面 + 终端双形态、数据与扩展留在本机。文章所有内容都围绕这三点展开，不要平均用力介绍几十个功能。

## 二、标题备选

1. **我把 AI 编程助手做成了桌面工作台：模型自选，数据留在本机**
2. **不用绑定一家模型：开源一个本地优先的 AI 编程工作台**
3. **从终端到桌面：我做 X-Code 的取舍、踩坑和 1.0.5**
4. **一个模型无关的 Coding Agent，应该长什么样？**

前两个适合少数派/V2EX，第三个适合掘金，第四个适合技术讨论型社区。避免“吊打”“秒杀”“最强”“替代”等词。

## 三、文章结构（推荐 2500–4000 字）

1. **开场：一个具体的麻烦**
   - 你已经在用 AI 编程，但被模型、网络、终端和文档工具切得很碎。
   - 你想要的是“一个工作台”，而不是再装一个插件。
2. **它是什么，不是什么**
   - 是什么：开源桌面应用 + CLI，共享 `~/.x-code`，BYO model/key。
   - 不是什么：不是云端 SaaS，不托管你的代码，不捆绑某一家模型。
3. **三个真实场景**
   - 改一个真实 bug：读代码 → 提议 diff → 批准 → 跑检查。
   - 读一份 PDF/Word/Excel：本地解析/OCR → 提问 → 导出。
   - 跑长任务：后台 shell/子代理继续跑，前台继续提问，随时问进度。
4. **为什么做这三个取舍**
   - 模型无关：模型会变、价格会变、网络条件会变。
   - 桌面 + 终端：长任务需要窗口，自动化需要 CLI。
   - 本地优先：会话、附件、文档索引和密钥不离开本机，只把你选择的内容发给模型。
5. **工程上怎么做的（轻量）**
   - Electron 外壳 + 独立 runtime + 核心 agent loop；桌面和 CLI 共用同一套工具、权限、技能和会话。
   - 一张架构图即可，不要贴大段源码。
6. **质量与验证**
   - 2217 个单元/集成测试、119 项桌面 UI smoke、26 个真实 LLM E2E 场景。
   - 工作区切换实测冷启动约 100ms、热切换个位数毫秒。
   - 说明 E2E 只在 `deepseek-flash` 上跑过，不把它包装成“所有模型都验证过”。
7. **限制与路线**
   - macOS arm64 优先；Windows/Linux 有 CI 但未做真实设备验收。
   - 社区版 ad-hoc 签名，不公证；自动更新尚未启用。
   - 模型 API 由用户自付；本地模型需要自己跑 Ollama/LM Studio。
   - 后台任务状态不跨应用重启保留；复杂文档解析有格式边界。
8. **安装与上手**
   - 下载 dmg → 校验 SHA256 → 拖进 Applications → 首次打开按未签名指南放行。
   - 没 Key 也能用演示模型看界面；配好 Key 后切到真实模型。
9. **邀请反馈**
   - 明确你希望得到什么：Windows/Linux 验收、文档工作流、模型兼容性、真实使用场景。
   - GitHub Star / Issue / Discussion 的具体链接。

## 四、可直接改的初稿

### 我把 AI 编程助手做成了桌面工作台：模型自选，数据留在本机

过去一年，我几乎每天都在用 AI 写代码。终端里的 Agent 很好用，但用久了会碰到几个很具体的问题：

- 模型更新很快，今天好用的模型，明天可能涨价、限流，或者网络不通；
- 终端适合跑命令，不适合同时看 diff、PDF、Excel 和会话；
- 写作、科研、办公场景里的文档，和代码工具是两套东西；
- 会话、技能、MCP、记忆散在不同工具里，换一个入口就要重新配置。

所以我做了 **X-Code**：一个本地优先、模型无关的开源 AI 编程工作台。它有 macOS 桌面应用，也保留了 CLI；两边共享同一套 `~/.x-code`，会话、技能、MCP、插件、Hooks 和记忆都是同一份。

项目地址：https://github.com/qweijiaq/x-code

#### 它不是什么

先说清楚，避免误解：

- 它不是云端 SaaS。代码、文档、附件和密钥留在你的机器上；只有你选择的内容会发给你配置的模型、搜索服务或 MCP 服务。
- 它不绑定某一家模型。Claude、GPT、Gemini、DeepSeek、Qwen、Kimi、GLM、Grok、本地 Ollama / LM Studio，或者任何 OpenAI-compatible 端点，都可以在顶栏切换。
- 它不是“又一个聊天框”。工具调用、文件 diff、shell 命令、下载和文档改动都有可审阅的卡片和权限控制。

#### 三个我会实际使用的场景

**1. 改一个真实 bug**

打开仓库，描述问题。Agent 会先读相关文件，给出精确 diff，而不是整文件重写。你可以逐条批准、拒绝，或者在 diff 卡片上直接撤销这一次编辑。改完可以运行项目检查；失败输出可以直接交回给 Agent 继续修。

**2. 读一份 PDF / Word / Excel**

把文档拖进窗口，或者用文档面板打开。PDF 支持分页渲染、提取文本和本地 OCR；Excel 以工作表展示；Word 和 Markdown 有对应的阅读视图。文档解析在本机完成，只有提取出的文本或页面图像会发给模型。看完可以直接让 Agent 总结、按页提问，或者导出成 PDF/DOCX/XLSX。

**3. 让长任务在后台跑，前台继续问**

长命令超过等待会进入后台任务面板。当前回复不会再死死占着输入框；我可以继续问下一个问题。后台子代理也会在独立上下文里跑，面板显示状态、耗时、工具调用数和结果；我直接问“现在到哪了”，模型可以查询后台任务状态和输出尾部。

这不是“同一个会话里并行两个模型 turn”，而是把长任务从当前 turn 里剥离出来。这个边界很重要，也决定了它的行为是可解释的。

#### 为什么是“桌面 + 终端”

终端适合自动化、脚本和远程机器；桌面适合同时看会话、diff、文档、终端和文件树。X-Code 没有把两者做成两个产品，而是让它们共享同一个 runtime 和数据目录。你可以在终端里开始一个会话，回到桌面继续；也可以在桌面里打开分支 worktree，在独立窗口里跑另一条任务。

#### 工程上做了什么

架构不复杂：

- Electron 主进程负责窗口、更新、系统能力和文件对话框；
- 每个窗口有独立的 runtime 进程，避免一个长任务卡住所有窗口；
- 核心 agent loop、工具、权限、provider、技能、MCP 在 `@x-code-cli/core`；
- 桌面和 CLI 只是两个 UI 表面，共用同一套工具和数据。

我没有把“支持多少模型”当成唯一目标，而是把“换模型不换工作流”当成约束。provider 元数据集中在一张表里，新增一个 provider 主要是加一条 catalog 和构造分支；桌面端不关心底层是哪家模型。

#### 质量不是靠感觉

这个项目有 2217 个单元/集成测试、119 项桌面 UI smoke 和 26 个真实 LLM E2E 场景。后者目前只在 `deepseek-flash` 上跑过，我不会把它说成“所有 provider 都验证过”。

最近还做了一轮性能修复：切换最近工作区时，MCP 关闭最多等 1.5 秒，旧会话后台落盘，本地模型发现缓存 30 秒。本地样本里冷切换约 100ms，热切换个位数毫秒。

#### 它现在还不完美

- 桌面版优先支持 macOS arm64；Windows/Linux 有 CI 构建，但还没有在真实设备上完成验收。
- 社区版是 ad-hoc 签名、不公证，首次打开需要按系统提示放行。
- 自动更新还没有启用，需要手动下载安装。
- 模型 API 费用由你自己承担；本地模型要自己跑 Ollama / LM Studio。
- 后台任务状态不跨应用重启保留；复杂文档格式仍有解析边界。

这些限制都写进了用户手册和 Release Notes，不藏在功能列表后面。

#### 安装

1. 打开 GitHub Releases，下载 `X-Code-1.0.5-arm64.dmg`；
2. 用 `SHA256SUMS` 校验；
3. 拖进 Applications；首次打开如果被 Gatekeeper 拦截，按未签名安装指南放行。

没有 API Key 也可以先用演示模型看界面；配置 Key 后在设置 → 模型与密钥里测试连接。

项目：https://github.com/qweijiaq/x-code

如果你也在用 DeepSeek、Qwen、Kimi 或本地模型写代码，欢迎试试，告诉我哪里不顺手。比起 Star，我更想看到真实的失败场景：哪个 provider 不兼容、哪类文档解析不对、Windows/Linux 上哪里坏了。

## 五、配图和 GIF 清单

至少准备这些素材，博客的转化率主要靠它们：

1. **头图**：聊天区 + 右侧 Inspector + 顶栏模型选择，3:2 或 16:10，深色/浅色各一张。
2. **15 秒 GIF**：拖入 PDF → 文档面板打开 → 提问 → 回答里引用页码。
3. **15 秒 GIF**：让 Agent 改代码 → diff 卡片 → 批准 → 项目检查通过。
4. **10 秒 GIF**：后台任务面板 + 前台继续提问 + 问进度。
5. **一张设置页**：provider 列表和“测试连接”，Key 打码。
6. **一张架构图**：Electron main → window runtime → core agent loop → providers/tools/skills/MCP → `~/.x-code`。
7. **一张 CLI + 桌面共享会话**：终端里开始，桌面里继续。

GIF 里不要出现真实 API Key、私人路径、公司仓库名。用示例仓库和虚构项目名。

## 六、分渠道写法

### V2EX / 分享创造

- 标题用“我做了一个……”，正文以技术取舍和踩坑为主。
- 先讲问题和限制，再放功能；不要一上来贴下载链接。
- 评论区会问“和 Claude Code / Cursor / Codex 有什么区别”，提前准备一段不贬低对手的对比：模型自选、桌面+CLI、本地文档、开源可改。
- 不要多个节点重复发。

### 少数派

- 用“我的工作流”叙事，场景和截图优先，架构放后半部分。
- 强调文档、PDF/OCR、写作/科研/办公，不只讲程序员。
- 标题可以更生活化：“我把 AI 编程助手变成了一个桌面工作台”。

### 掘金

- 以架构和工程细节为主：agent loop、工具权限、runtime 隔离、provider 抽象、测试体系。
- 代码片段只放关键的几段，完整实现链接到 GitHub。
- 标题用“从终端到桌面：……”。

### 即刻 / 小红书

- 一条短图文：一个问题 + 三张图 + 一句“开源、模型自选、macOS”。
- 不要放长安装教程，评论区引导到 GitHub。
- 视频版 30–60 秒：拖文档、改代码、后台任务三个镜头。

### Hacker News / Reddit（英文）

HN 用 **Show HN**，标题简洁、不夸大：

> Show HN: X-Code – a model-agnostic, local-first coding agent with a desktop UI

正文 3–5 段：为什么做、和现有工具的区别、技术栈、限制、安装。明确写“I built this”，不要在评论区伪装成普通用户。Reddit 先看 r/LocalLLaMA、r/ClaudeAI 等板块的 self-promotion 规则；LocalLLaMA 的角度应是本地模型、Ollama/LM Studio、数据和离线工作流，而不是“替代某个商业产品”。

## 七、发布前检查清单

- [ ] GitHub README 首屏能看懂：一句话定位、截图、下载按钮、macOS 限制。
- [ ] Release 资产完整：dmg、zip、SHA256SUMS、RELEASE.json、latest-mac.yml。
- [ ] 安装指南链接可达，Gatekeeper 步骤和 `xattr` 兜底写清楚。
- [ ] 文中每个数字都能在仓库或 Release Notes 里找到依据。
- [ ] 截图无密钥、无私人路径、无客户代码。
- [ ] 明确写出“模型 API 自费”“Windows/Linux 未验收”“未签名”三个限制。
- [ ] 准备 3 条常见反对意见的回复：为什么不接云端、为什么不用现成 IDE 插件、为什么只支持 macOS。
- [ ] 发布后 24 小时内回复评论；把真实 bug 记进 Issue，不要在评论区和人争论排名。

## 八、英文版提纲

1. The problem: model lock-in, fragmented desktop/terminal/document workflows.
2. What X-Code is: open-source desktop + CLI sharing `~/.x-code`, BYO model/key.
3. Three demos: code diff, document/PDF, background task.
4. Design choices: model-agnostic provider table, per-window runtime, local-first data.
5. Verification and limits: 2217 tests, 119 UI smoke, 26 E2E on one provider; macOS arm64 only, unsigned, manual updates.
6. Install and feedback: dmg, SHA256, unsigned guide, GitHub Issues.
