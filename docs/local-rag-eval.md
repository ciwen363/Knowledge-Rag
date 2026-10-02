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

原样重复上传会被文件 SHA-256 去重拒绝。替换导入的样例数据前，应保存文档、版本与分段备份，并确认替换范围。完成本地上传后，不要再导入旧 SQL 覆盖本地新 ID。
