# ACoder

一个类似 **Claude Code** 的命令行（CLI）Coding Agent 演示项目，使用 **Node.js + TypeScript（ESM）** 实现。

它用最小但完整的代码，展示了现代 Coding Agent 的核心机制：

- 🧠 **多种推理模式**：ReAct（反应式）+ Plan-and-Execute（计划式）+ 自动选择
- 🔧 **工具调用框架（Tools）**：动态注册、参数校验，内置文件读写 / 目录列举 / 命令执行 / 代码分析
- 🎯 **技能系统（Skills）**：用 Markdown + frontmatter 定义技能，自动按触发词匹配
- 🤖 **子代理编排（Sub-Agents）**：把独立子任务委派给隔离上下文的子代理执行
- ✨ **效果增强机制**：会话记忆 / 上下文裁剪 / 反思自纠 / 步数预算控制
- 💻 **CLI 流式交互**：彩色、流式地展示思考、计划、子代理、工具调用与结果
- 📴 **离线 Mock 模式**：未配置 API Key 也能完整运行体验

> 这是一个用于学习与演示的 MVP。配置真实模型后即可接入 OpenAI 兼容接口。

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2.（可选）配置真实模型；不配置则自动使用离线 Mock 模型
cp .env.example .env
# 编辑 .env 填入 OPENAI_API_KEY

# 3. 启动交互式 CLI（开发模式，无需构建）
npm run dev

# 或：构建后运行
npm run build
npm start
```

启动后进入 REPL，直接输入开发任务，或使用内置命令：

```
/help               显示帮助
/tools              列出可用工具
/skills             列出可用技能
/mode [react|plan|auto]   查看或切换运行模式
/exit               退出
```

### 一键体验（非交互单次任务）

```bash
npm run demo:react      # 演示 ReAct 模式
npm run demo:plan       # 演示 Plan 模式
npm run demo:subagent   # 演示子代理编排
```

### 全局安装（任意目录调用）

把 `mca` 命令安装到全局，即可在你电脑的**任意目录**下直接调用：

```bash
npm run link        # = npm run build && npm link，将 mca 链接到全局 bin

# 之后在任何目录：
cd ~/any/project
mca                                 # 进入交互式 REPL
mca --once "列出当前目录并总结结构"   # 单次任务
mca --mode plan --once "重构这个模块" # 指定模式

npm run unlink      # 卸载全局 mca
```

- **工作目录（沙箱根）默认为你运行 `mca` 时的当前目录 `cwd`**，Agent 的文件读写/命令执行都限定在该目录内，就像真正的 Coding Agent 操作当前项目。可用 `WORKDIR` 环境变量覆盖。
- 全局运行时，配置（如 DeepSeek API Key）会按「当前目录 `.env` 优先、项目根 `.env` 兜底」的顺序加载，因此在项目根配置一次即可全局生效。

---

## 上下文压缩（核心功能）

为支持长对话与多步任务，项目实现了一套**可配置的极致上下文压缩管线**，在调用模型**之前**自动把较早的历史压成一条结构化摘要，最大限度减少 token 同时保留可继续任务的关键信息。

### 压缩策略（`COMPRESS_MODE`）

| 策略 | 说明 |
|------|------|
| `hybrid`（默认） | **LLM 语义摘要为主、本地确定性压缩为辅**；离线/Mock/异常时自动回退本地，保证始终可用 |
| `llm` | 仅用模型做语义摘要（保留关键事实、文件路径、决策、待办） |
| `local` | 纯本地确定性压缩：抽取「用户意图 / 工具调用序列 / 工具结果要点 / 已得结论」，去重并截断，零额外 API 调用 |

### 触发与保留机制

- **双阈值触发**：非 system 消息条数超过 `CONTEXT_LIMIT`，**或** 估算 token 超过 `COMPRESS_TOKEN_THRESHOLD`。
- **保留**：始终保留 system 提示、最近 `COMPRESS_KEEP_RECENT` 条原文、以及会话关键事实。
- **安全**：压缩后保证 `tool` 消息不悬空（始终有配对的 `assistant.tool_calls`），不破坏 OpenAI 消息格式。
- **可观测**：每次压缩在终端输出 `🗜 上下文压缩 mode=hybrid 1932→461 tokens (-76%) 丢弃 N 条`。

### 配置项

| 变量 | 默认 | 说明 |
|------|------|------|
| `COMPRESS_MODE` | `hybrid` | 压缩策略：hybrid / llm / local |
| `COMPRESS_TOKEN_THRESHOLD` | `1200` | 触发压缩的 token 阈值 |
| `COMPRESS_KEEP_RECENT` | `6` | 保留最近 N 条原文 |
| `COMPRESS_MAX_SUMMARY_CHARS` | `600` | 摘要体积上限（控制压缩比） |
| `CONTEXT_LIMIT` | `24` | 触发压缩的消息条数阈值 |

### 验证

```bash
npm test
```

测试覆盖触发条件、压缩比（本地实测 ratio≈0.24，即 **-76%**）、关键事实/最近窗口保留、消息序列合法性、hybrid 回退路径与 `Memory.maybeCompact` 集成。

---

## 架构概览

```
┌──────────────────────────────────────────────────────────┐
│                        CLI (src/cli.ts)                    │
│   REPL · 内置命令 · 单次模式      渲染器 (src/ui/render.ts) │
└───────────────┬──────────────────────────────────────────┘
                │ AgentEvent 流（thinking/plan/tool/subagent/…）
┌───────────────▼──────────────────────────────────────────┐
│                   Agent 引擎 (src/agent)                   │
│   agent.ts    统一入口 · 自动模式选择 · 技能注入           │
│   react.ts    ReAct 反应式循环                             │
│   plan.ts     Plan-and-Execute（生成计划→逐步执行→汇总）   │
│   loop.ts     共享 think→tool→observe 循环 + 反思自纠       │
│   orchestrator.ts  子代理委派（隔离上下文/工具/预算）      │
└───────┬───────────────┬───────────────┬──────────────────┘
        │               │               │
┌───────▼─────┐ ┌───────▼──────┐ ┌──────▼───────┐ ┌──────────┐
│ Tools       │ │ Skills       │ │ Memory       │ │ LLM      │
│ (src/tools) │ │ (src/skills) │ │ (src/memory) │ │ (src/llm)│
│ 注册表+工具 │ │ 加载+匹配    │ │ 记忆+预算    │ │ OpenAI / │
│             │ │              │ │ +上下文裁剪  │ │ Mock     │
└─────────────┘ └──────────────┘ └──────────────┘ └──────────┘
```

### 项目结构

```
.
├── src/
│   ├── cli.ts                  # CLI 入口：REPL、内置命令、启动装配
│   ├── config.ts               # 环境变量与配置
│   ├── llm/                    # LLM 接入层
│   │   ├── types.ts            #   统一接口（Message/ToolCall/Provider）
│   │   ├── openai.ts           #   OpenAI 兼容 provider（流式+function calling）
│   │   ├── mock.ts             #   离线 Mock provider
│   │   └── index.ts            #   provider 工厂
│   ├── tools/                  # 工具调用框架
│   │   ├── types.ts            #   Tool 抽象 + zod→JSON-Schema
│   │   ├── registry.ts         #   注册表（注册/校验/执行/子集）
│   │   ├── file-tools.ts       #   read_file / write_file
│   │   ├── list-dir-tool.ts    #   list_dir
│   │   ├── run-command-tool.ts #   run_command（超时保护）
│   │   ├── analyze-code-tool.ts#   analyze_code（检索+结构统计）
│   │   └── safe-path.ts        #   工作目录沙箱
│   ├── skills/                 # 技能系统
│   │   ├── loader.ts           #   扫描 + frontmatter 解析
│   │   └── registry.ts         #   注册 + 触发匹配
│   ├── memory/                 # 记忆与预算
│   │   ├── memory.ts           #   会话记忆 + 上下文裁剪/摘要
│   │   └── budget.ts           #   步数/token 预算计量器
│   ├── agent/                  # 推理引擎
│   │   ├── agent.ts            #   统一入口 + 自动模式选择
│   │   ├── react.ts            #   ReAct
│   │   ├── plan.ts             #   Plan-and-Execute
│   │   ├── loop.ts             #   核心循环 + 反思
│   │   ├── orchestrator.ts     #   子代理委派
│   │   ├── orchestration-tools.ts # spawn_subagent / update_plan
│   │   └── types.ts            #   AgentEvent 事件流
│   └── ui/render.ts            # 彩色流式渲染
├── skills/                     # 技能定义（Markdown）
│   ├── code-review.md
│   └── explain-code.md
├── demo-workspace/             # Agent 的沙箱工作目录（运行时创建）
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## 核心概念

### 1. 推理模式（Modes）

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `react` | 「思考 → 调用工具 → 观察」反应式循环 | 探索型 / 轻量任务 |
| `plan` | 先生成 TODO 计划，再逐步执行并汇总，可在执行中 `update_plan` 修正 | 复杂多步任务 |
| `auto` | 按任务复杂度启发式自动选择 react / plan | 默认 |

切换：`/mode plan` 或启动参数 `--mode plan`。

### 2. 工具（Tools）

| 工具 | 功能 |
|------|------|
| `read_file` | 读取工作目录内文件 |
| `write_file` | 写入工作目录内文件 |
| `list_dir` | 列出目录 |
| `run_command` | 执行 shell 命令（带超时保护） |
| `analyze_code` | 检索关键字/符号并统计代码结构 |
| `spawn_subagent` | 委派子任务给子代理 |
| `update_plan` | （Plan 模式）修正后续计划 |

所有文件/命令操作都被限制在 `demo-workspace/` 沙箱内，路径越界会被拒绝。

**动态注册新工具**：

```ts
import { z } from 'zod';
import { createBaseRegistry } from './src/tools/index.js';

const registry = createBaseRegistry();
registry.register({
  name: 'word_count',
  description: '统计文本的单词数',
  parameters: z.object({ text: z.string() }),
  async execute(args) {
    return { ok: true, output: `${args.text.split(/\s+/).length} 个单词` };
  },
});
```

### 3. 技能（Skills）

技能是带 frontmatter 的 Markdown 文件，放在 `skills/` 目录：

```markdown
---
name: code-review
description: 对代码进行结构化审查
trigger: [审查, review, 代码质量]
tools: [read_file, list_dir, analyze_code]
---

你是一名资深代码审查专家，请按以下流程……
```

当用户任务命中 `trigger` 关键词时，技能的指令会被注入系统提示，并可限制可用工具集。

### 4. 子代理（Sub-Agents）

主代理可调用 `spawn_subagent` 把独立子任务交给一个**隔离上下文**的子代理：

- 独立的消息历史（不污染主上下文）
- 受限的工具集（由委派时声明）
- 独立的步数预算（`SUBAGENT_MAX_STEPS`）
- 失败 / 预算耗尽被隔离，不会拖垮主流程

### 5. 效果增强

- **会话记忆**：跨任务复用关键事实与历史结论
- **上下文裁剪**：超过阈值时压缩较早消息，避免上下文溢出
- **反思自纠**：工具失败时注入反思提示并有限次重试
- **预算控制**：主/子代理共用步数与 token 预算计量

---

## 配置项（.env）

| 变量 | 默认 | 说明 |
|------|------|------|
| `OPENAI_API_KEY` | 空 | 留空则使用离线 Mock 模型 |
| `OPENAI_BASE_URL` | 官方 | OpenAI 兼容接口地址 |
| `MODEL` | `gpt-4o-mini` | 模型名 |
| `MAX_STEPS` | `12` | 主代理最大步数 |
| `SUBAGENT_MAX_STEPS` | `6` | 子代理最大步数 |
| `MAX_REFLECT_RETRIES` | `1` | 工具失败反思重试次数 |
| `CONTEXT_LIMIT` | `24` | 触发上下文压缩的消息条数阈值 |
| `COMMAND_TIMEOUT_MS` | `15000` | 命令执行超时 |
| `DEFAULT_MODE` | `auto` | 默认运行模式 |
| `WORKDIR` | 当前目录 `cwd` | 沙箱工作目录（可覆盖） |
| `COMPRESS_MODE` | `hybrid` | 上下文压缩策略：hybrid / llm / local |
| `COMPRESS_TOKEN_THRESHOLD` | `1200` | 触发压缩的 token 阈值 |
| `COMPRESS_KEEP_RECENT` | `6` | 压缩时保留最近 N 条原文 |
| `COMPRESS_MAX_SUMMARY_CHARS` | `600` | 摘要体积上限 |

---

## 效果展示（Mock 模式）

```
> 读取 README.md 并总结内容

◆ 模式 REACT (用户指定 ReAct 模式)
🧠 思考: 思考：下一步调用 read_file 来推进任务。
🔧 调用工具 read_file {"path":"README.md"}
  ✓ 结果 [read_file]
    文件 README.md（…字符）: …
✅ 最终结果:
  任务「读取 README.md 并总结内容」已完成。…
```

子代理编排示例（节选）：

```
> 调研项目结构并审查代码质量，拆分为多个子任务并行处理
ℹ 匹配到技能：code-review
🧠 思考: 下一步调用 spawn_subagent 来推进任务。
│ ╭─ 🤖 子代理启动 调研当前项目的目录结构 [tools: list_dir, read_file, analyze_code]
│ 🔧 调用工具 list_dir {"path":"."}
│ ╰─ 🤖 子代理完成: …
```

---

## 路线图（未来扩展）

- [x] 全局可用（`mca` 任意目录调用，沙箱根 = cwd）
- [x] 极致上下文压缩（hybrid/llm/local + 压缩比统计 + 验证测试）
- [ ] 向量检索 / RAG 增强的代码理解
- [ ] 持久化磁盘记忆（跨会话）
- [ ] 真正的并行子代理调度器
- [ ] 更丰富的内置工具（git、测试运行、补丁应用）
- [ ] 工具调用的人工确认（human-in-the-loop）
- [ ] 更多单元测试与 CI

---

## License

[MIT](./LICENSE) © 2026
