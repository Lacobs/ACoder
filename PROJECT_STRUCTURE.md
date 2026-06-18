# ACoder 项目完整目录结构

> 记录时间：2025-01

## 根目录

```
ACoder/
├── LICENSE                          (1.0 KB)
├── README.md                        (14.1 KB)
├── package.json                     (1.2 KB)
├── package-lock.json                (34.0 KB)
├── tsconfig.json                    (454 B)
├── demo-workspace/                  ← 演示工作区
├── dist/                            ← 编译产物 (JavaScript)
├── node_modules/                    ← 依赖（略）
├── skills/                          ← 技能定义 (Markdown)
└── src/                             ← 源码 (TypeScript)
```

---

## src/ — TypeScript 源码

```
src/
├── cli.ts                           (6.1 KB)    CLI 入口
├── config.ts                        (2.9 KB)    配置模块
│
├── agent/                           (9 文件)    代理核心
│   ├── index.ts                     (244 B)     导出入口
│   ├── types.ts                     (1.7 KB)    类型定义
│   ├── agent.ts                     (3.3 KB)    主代理
│   ├── loop.ts                      (6.6 KB)    主循环
│   ├── orchestrator.ts              (2.2 KB)    编排器
│   ├── orchestration-tools.ts       (2.2 KB)    编排工具
│   ├── plan.ts                      (7.3 KB)    计划模块
│   ├── prompts.ts                   (2.6 KB)    提示词
│   └── react.ts                     (1.2 KB)    ReAct 模式
│
├── llm/                             (4 文件)    LLM 集成
│   ├── index.ts                     (412 B)     导出入口
│   ├── types.ts                     (1.4 KB)    类型定义
│   ├── openai.ts                    (3.1 KB)    OpenAI 适配器
│   └── mock.ts                      (7.0 KB)    Mock 适配器
│
├── memory/                          (5 文件)    记忆/压缩
│   ├── index.ts                     (774 B)     导出入口
│   ├── types.ts                     (321 B)     类型定义
│   ├── memory.ts                    (4.1 KB)    记忆管理
│   ├── compressor.ts                (7.9 KB)    压缩器
│   └── budget.ts                    (759 B)     预算管理
│
├── tools/                           (8 文件)    工具系统
│   ├── index.ts                     (667 B)     导出入口
│   ├── types.ts                     (2.5 KB)    类型定义
│   ├── registry.ts                  (1.9 KB)    工具注册表
│   ├── file-tools.ts                (1.7 KB)    文件读写工具
│   ├── list-dir-tool.ts             (1.4 KB)    目录列表工具
│   ├── analyze-code-tool.ts         (3.0 KB)    代码分析工具
│   ├── run-command-tool.ts          (1.9 KB)    命令执行工具
│   └── safe-path.ts                 (753 B)     路径安全校验
│
├── skills/                          (4 文件)    技能系统
│   ├── index.ts                     (101 B)     导出入口
│   ├── types.ts                     (560 B)     类型定义
│   ├── loader.ts                    (2.4 KB)    技能加载器
│   └── registry.ts                  (1.2 KB)    技能注册表
│
├── ui/                              (1 文件)    终端 UI
│   └── render.ts                    (4.4 KB)    渲染输出
│
└── test/                            (1 文件)    测试
    └── compression.test.ts          (6.0 KB)    压缩器测试
```

---

## dist/ — 编译产物 (JavaScript)

```
dist/
├── cli.js                           (6.4 KB)
├── config.js                        (2.4 KB)
├── agent/                           (9 文件)
│   ├── index.js / types.js / agent.js / loop.js
│   ├── orchestrator.js / orchestration-tools.js
│   ├── plan.js / prompts.js / react.js
├── llm/                             (4 文件)
│   ├── index.js / types.js / openai.js / mock.js
├── memory/                          (5 文件)
│   ├── index.js / types.js / memory.js / compressor.js / budget.js
├── tools/                           (8 文件)
│   ├── index.js / types.js / registry.js
│   ├── file-tools.js / list-dir-tool.js
│   ├── analyze-code-tool.js / run-command-tool.js / safe-path.js
├── skills/                          (4 文件)
│   ├── index.js / types.js / loader.js / registry.js
├── ui/                              (1 文件)
│   └── render.js
└── test/                            (1 文件)
    └── compression.test.js
```

---

## skills/ — 技能定义 (Markdown)

```
skills/
├── code-review.md                   (931 B)     代码审查技能
└── explain-code.md                  (844 B)     代码解释技能
```

---

## demo-workspace/ — 演示工作区

```
demo-workspace/
├── README.md                        (92 B)
├── a.txt                            (70 B)
└── hello.txt                        (52 B)
```

---

## 统计摘要

| 指标 | src/ | dist/ | 合计 |
|------|------|-------|------|
| TypeScript 文件 | 33 | — | 33 |
| JavaScript 文件 | — | 33 | 33 |
| Markdown 技能定义 | 2 (skills/) | — | 2 |
| 配置文件 (root) | 4 | — | 4 |
| 演示文件 | 3 (demo-workspace/) | — | 3 |

- **核心模块**: agent, llm, memory, tools, skills, ui
- **测试**: 仅 1 个测试文件 (`compression.test.ts`)
- **技能定义**: 2 个 Markdown 文件 (`code-review`, `explain-code`)
