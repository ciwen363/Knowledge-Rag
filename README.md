# Knowledge RAG · 通用知识问答

一个以 Java 21 和 Spring Boot 构建的 RAG 实践项目。它把异构文档转换为可检索的知识片段，结合语义与关键词召回、重排及流式生成完成问答，并提供文档版本管理和离线评测页面。

> 当前仓库适合本地学习与功能验证。默认用户、MinIO 对象读取策略等仍是演示实现；接入真实业务数据前应补齐身份认证、权限控制、私有存储及部署安全配置。

## 能做什么

- **知识入库**：上传 PDF、Word、Excel、Markdown、TXT、CSV；PDF/Word 调用兼容 MinerU 的外部解析接口转成 Markdown，原文件与转换结果保存在 MinIO。按长度、标题、正则、智能或分隔符策略切片，向量写入 Elasticsearch。
- **知识问答**：识别问题意图、结合对话历史改写查询；向量 KNN 与全文检索双路召回，经 RRF 合并后使用本地 BGE ONNX 模型重排。SSE 持续推送处理进度、引用和回答。
- **版本与恢复**：维护文档版本及启停状态，支持切换版本、重新向量化；通过分布式锁和补偿任务降低重复处理与中断带来的数据不一致风险。
- **质量评测**：使用 JSONL 测试集批量运行问答，统计 Hit@K、MRR、Recall@K，以及基于 LLM 的答案与上下文质量指标；支持报告查看、两次运行对比和 CSV 导出。

核心链路：`文档上传 → 解析/切片 → 向量化 → Elasticsearch`；`提问 → 意图识别/改写 → 双路召回 → RRF + BGE 重排 → 带引用的流式回答`。

## 技术组成

| 层面 | 主要组件 |
| --- | --- |
| 应用与编排 | Spring Boot 3.5.6、LangChain4j 1.11、Java 21 |
| 数据与检索 | MySQL、Redis/Redisson、Elasticsearch、MinIO |
| 模型与解析 | DashScope 兼容 OpenAI 的聊天/Embedding API、本地 BGE ONNX Reranker、MinerU 兼容解析服务 |
| 页面 | Spring Boot 静态页面，无需单独构建前端 |

## 本地运行

1. 安装 JDK 21、Maven、Git LFS，并准备 MySQL、Redis、Elasticsearch、MinIO，以及 MinerU 兼容文档解析服务。客户端兼容旧版 `POST /file_parse` 与新版 `/v1/parse/jobs`。聊天与向量化需要可用的 DashScope API Key。
2. 克隆仓库后运行 `git lfs pull`，再在 PowerShell 中执行 `./scripts/restore-reranker-model.ps1`。模型以 Git LFS 分片分发，脚本会校验并还原 `model_quantized.onnx`；未还原前应用无法加载重排模型。
3. 在 MySQL 中创建 `know_engine` 数据库（`utf8mb4`），导入 [`src/main/resources/sql/know_engine.sql`](src/main/resources/sql/know_engine.sql)。SQL 含演示文档、分块及历史记录；已有数据库应先备份。导入 SQL 只恢复 MySQL，MinIO 文件与 Elasticsearch 向量需要另外入库，详见 [本地恢复与评测说明](docs/local-rag-eval.md)。
4. 将 [`application-example.yml`](src/main/resources/application-example.yml) 复制为同目录的 `application.yml`，设置模板列出的 `KNOW_ENGINE_*` 环境变量，包括 DashScope、数据库、Redis 与 MinIO 凭据。按本机环境调整连接地址；Redis 的 Spring 与 Redisson 两处配置应一致。实际运行配置忽略提交。
5. 在项目根目录执行 `mvn spring-boot:run`。默认端口为 `8009`。

启动后可访问：

| 页面 | 地址 |
| --- | --- |
| 上传文档 | `http://localhost:8009/upload.html` |
| 文档管理 | `http://localhost:8009/document.html` |
| AI 对话 | `http://localhost:8009/chat.html` |
| 评测报告 | `http://localhost:8009/eval-report.html` |

首次使用时，先上传并切分文档，等待向量化完成后再提问。仓库的 [`testFile`](src/main/resources/testFile) 提供多格式演示文档。PDF/Word 解析依赖外部服务；其它格式按对应处理器处理。

## API 与评测

- `POST /api/document/upload`：上传文件（`file`、`title`、`description`，可选 `version`）。上传与切分是两个步骤。
- `POST /api/document/split/{documentId}`：指定 `splitType`、`chunkSize` 等参数切分，并触发后续向量化。
- `POST /chat/send`：传入 `content`，可选 `conversationId`，响应为 SSE。
- `POST /eval/run`：请求体指定 `datasetPath` 与可选 `config`；`GET /eval/report/{runId}`、`GET /eval/compare` 查看结果。

评测集为每行一个 JSON 对象的 JSONL 文件；字段包括 `question`、可选标准答案 `groundTruthAnswer`，以及相关片段/文档 ID 列表。内置示例位于 [`eval/datasets`](src/main/resources/eval/datasets)，可用 `classpath:eval/datasets/eval-test.jsonl` 引用。全新数据库重新入库后，片段 ID 可能变化，做检索评测前应重新核对标注。评测分数依赖数据集、模型与运行环境，不代表固定的线上效果。

## 仓库说明

- 大文件模型由 Git LFS 管理，分片位于 `src/main/resources/model/bge-reranker-model/parts`。`model_quantized.onnx` 是本地重组产物，不提交到 Git；源码压缩包通常只有 LFS 指针，请使用 Git 克隆并执行 `git lfs pull`。
- 配置文件不包含可用密钥；请通过环境变量注入，勿提交真实凭据。
- 当前上传逻辑会为新建 MinIO bucket 设置公共读策略，且接口使用默认用户；在非隔离环境部署前必须审查并调整。
- 本仓库未包含 MinerU 服务端、MySQL/Redis/Elasticsearch/MinIO 的部署编排文件，需自行准备这些依赖。

## 已验证的版本

`main` 已合入原 `master` 的 RAG 修复、四页统一导航及前端重构。2026-10-03 完整评测为 100/100 成功、Hit@5=0.99、MRR=0.897、Recall@5=0.9566667；2026-10-07 通过 6 个真实对话问题、历史持久化与刷新检查，以及 15 组前端浏览器回归。测量范围和剩余案例见 [检索验收](docs/validation/rag-quality-20261003.md)、[真实对话验证](docs/validation/live-chat-20261007.md)。
