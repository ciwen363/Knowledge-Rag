# 本地 RAG 与评测资料

SQL 只恢复 MySQL 记录，不能同时恢复 MinIO 文件和 Elasticsearch 向量。数据库显示 `VECTOR_STORED` 时，也要检查当前 ES 的 `know-engine-vector` 索引和实际向量数量。

## 完整评测集

- 默认运行文件：`src/main/resources/eval/datasets/eval-test.jsonl`，共 100 题。
- 朋友提供的原始 100 题参考：`src/main/resources/eval/datasets/eval-test-all.jsonl`。
- `eval-test1.jsonl` 保留原来的 5 题小集合；重新上传后，也需对齐其标注再使用。

题目、答案和案例 ID 保留原样。`groundTruthDocumentIds` 使用 `knowledge_document.doc_id`，`groundTruthChunkIds` 使用 `knowledge_segment.chunk_id`，不是分段表的自增 `id`。

## 重新生成本地标注

通过已启动系统完成六份测试文件的上传、转换、切片和向量化，再使用参考 SQL 中的分块文本精确匹配当前数据库的分块：

```powershell
node scripts/align-eval-dataset.mjs --sql target/classes/sql/know_engine.sql --dry-run
node scripts/align-eval-dataset.mjs --sql target/classes/sql/know_engine.sql
```

脚本读取运行服务的文档与分段接口，默认以原始 `eval-test-all.jsonl` 为参考，写入默认 `eval-test.jsonl`。可用 `--api-base`、`--input`、`--output` 指定其他服务或文件。

脚本仅在分块文本、父子类型和归属文档均精确匹配时写入；存在缺失或歧义会报错。若新切片策略改变分块边界，应重新逐题标注，不能只按顺序替换 ID。父分块也可作为标注，现有评测指标支持匹配 `parentChunkId`。

IDE 运行时需重新复制资源或重新构建，使 `target/classes/eval/datasets/eval-test.jsonl` 与源码一致。浏览器的“发起评测”默认读取这个 classpath 资源。

## 本地依赖与配置

`application.yml` 含本机配置与凭据，不纳入 Git。可从 `application-example.yml` 复制并设置其中的环境变量。570 MB 的 ONNX 模型和 tokenizer 保留在本地 `src/main/resources/model/bge-reranker-model/`，不纳入 Git。

PDF/Word 上传依赖配置中的 `file.parse.api.url`（当前为 `http://localhost:8000`）；该解析服务需要单独启动。分段向量化调用配置中的 DashScope Embedding API，生成的向量写入本地 ES。

解析客户端优先保留旧版 `/file_parse` ZIP 调用；该接口返回 404 时，使用新版 `/v1/parse/jobs` 创建任务、轮询并从 `/v1/files/{file_id}/content` 下载 ZIP。新版等级由 `file.parse.api.tier` 配置，默认 `basic`。整个任务轮询受 `file.parse.api.responseTimeout` 限制，失败会保留服务端原因。不会在引擎错误时自动改用其他解析等级。

本地 BGE 重排限制共享模型的同时推理数，并按“批次条数 × 最长文本字符数的平方”限制候选批次。短候选批次保留原样，长输入分批，普通分块仍使用完整正文；扩展后的父文通过同文档、同版本的真实子分块取最高相关性分，返回上下文保留父文全文。模型、8192 token 上限、-2.5 分数阈值、Top-5、RRF 融合及空结果回退规则保持原样。量化 ONNX 模型拆分批次会改变部分分数，因此需要根据完整评测报告检查结果；不以修改标注或截断正文来抬高指标。

## 本次本地恢复

2026-10-02 检查发现，六份资料的 SHA-256 与数据库一致，但 MinIO 知识库桶和 ES 向量索引缺失。选择保留原文档、版本及分块 ID，补齐存储，不删除重建知识数据。

- 六份原文件和三个独立的转换文件已写入本地 MinIO；原文件下载后的 SHA-256 与版本表一致。
- Word 转换采用新版服务实际生成且覆盖原内容的 Markdown；PDF 转换保留 SQL 中原父分块的完整文本。新版 PDF `basic` 引擎发生连接错误，`flash` 可提取文本，但结果与原分块不同，因此不用于替换现有知识内容。
- 97 个数据库分块保留原文本、元数据和 ID，其中 1 个父分块不参与向量化，96 个子分块/普通分块重新生成 1536 维向量。ES 中的文本与数据库逐一匹配。
- 100 题默认评测集的标注已与实际数据库核对；无需制造新 ID 或改变题目答案。重新上传时使用上面的对齐脚本重新检查。

此次运行的本地 ES 使用 `ES_JAVA_OPTS=-Xms1g -Xmx1g`，为同机重排模型留出内存；没有改写 ES 数据或安装目录的配置。后端与 MinIO 已按现有配置重启。

原样重复上传会被文件 SHA-256 去重拒绝。替换导入的样例数据前，应保存文档、版本与分段备份，并确认替换范围。完成本地上传后，不要再导入旧 SQL 覆盖本地新 ID。

2026-10-03 串行完整检索验收：100/100 成功，Hit@5=0.99、MRR=0.897、Recall@5=0.9566667。详细对照、剩余 BadCase 和测量范围见 [验收记录](validation/rag-quality-20261003.md)。
