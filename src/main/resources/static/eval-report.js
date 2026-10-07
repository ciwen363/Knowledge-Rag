
    const DEFAULT_DATASET = 'classpath:eval/datasets/eval-test.jsonl';
    let runsPage = 1;
    const runsSize = 20;
    let runsTotal = 0;

    const params = new URLSearchParams(location.search);
    const defaultRunId = params.get('runId');
    if (defaultRunId) {
        document.getElementById('runIdInput').value = defaultRunId;
        switchTab('report');
        loadReport();
    }

    function switchTab(tab) {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        document.querySelectorAll('.tab-panel').forEach(panel => {
            panel.classList.toggle('active', panel.id === 'panel-' + tab);
        });
        if (tab === 'runs') {
            loadRuns();
        }
    }

    function currentRunId() {
        return document.getElementById('runIdInput').value.trim();
    }

    function setError(id, message) {
        document.getElementById(id).textContent = message || '';
    }

    async function startEval() {
        const runBtn = document.getElementById('runBtn');
        const statusEl = document.getElementById('runStatus');
        setError('runError', '');
        statusEl.textContent = '';

        const fileInput = document.getElementById('datasetFile');
        let datasetPath = document.getElementById('datasetPath').value.trim() || DEFAULT_DATASET;

        runBtn.disabled = true;
        try {
            if (fileInput.files && fileInput.files.length > 0) {
                statusEl.textContent = '上传评测集中…';
                datasetPath = await uploadDataset(fileInput.files[0]);
                document.getElementById('datasetPath').value = datasetPath;
            }

            const body = {
                datasetPath,
                config: {
                    topK: Number(document.getElementById('topK').value) || 5,
                    concurrency: Number(document.getElementById('concurrency').value) || 1,
                    enableLlmJudge: document.getElementById('enableLlmJudge').checked,
                    reviewScoreThreshold: Number(document.getElementById('reviewScoreThreshold').value)
                }
            };
            if (Number.isNaN(body.config.reviewScoreThreshold)) {
                body.config.reviewScoreThreshold = 0.6;
            }

            statusEl.textContent = '评测中，请稍候…';
            const resp = await fetch('/eval/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const result = await resp.json();
            if (!result.success) {
                setError('runError', result.message || '评测失败');
                statusEl.textContent = '';
                return;
            }
            statusEl.textContent = '评测完成';
            document.getElementById('runIdInput').value = result.data.runId || '';
            switchTab('report');
            renderReport(result.data);
        } catch (e) {
            setError('runError', e.message || String(e));
            statusEl.textContent = '';
        } finally {
            runBtn.disabled = false;
        }
    }

    async function uploadDataset(file) {
        const form = new FormData();
        form.append('file', file);
        const resp = await fetch('/eval/dataset/upload', { method: 'POST', body: form });
        const result = await resp.json();
        if (!result.success) {
            throw new Error(result.message || '上传失败');
        }
        return result.data.datasetPath;
    }

    async function loadRuns() {
        setError('runsError', '');
        try {
            const resp = await fetch('/eval/runs?page=' + runsPage + '&size=' + runsSize);
            const result = await resp.json();
            if (!result.success) {
                setError('runsError', result.message || '加载失败');
                return;
            }
            const page = result.data || {};
            const records = page.records || [];
            runsTotal = result.total != null ? result.total : (page.total || 0);
            document.getElementById('runsMeta').textContent = '共 ' + runsTotal + ' 条';
            document.getElementById('runsPageInfo').textContent = '第 ' + runsPage + ' 页';
            document.getElementById('runsPrev').disabled = runsPage <= 1;
            document.getElementById('runsNext').disabled = runsPage * runsSize >= runsTotal;

            document.getElementById('runsRows').innerHTML = records.map(item => {
                const runId = escapeHtml(item.runId || '');
                return `<tr>
                    <td><button type="button" class="linkish" onclick="openReport('${escapeAttr(item.runId || '')}')">${runId}</button></td>
                    <td>${escapeHtml(formatDateTime(item.createdAt))}</td>
                    <td title="${escapeAttr(item.datasetPath || '')}">${escapeHtml(shortPath(item.datasetPath))}</td>
                    <td>${item.evaluatedCases ?? '-'}/${item.totalCases ?? '-'}</td>
                    <td>${formatNum(item.hitAtK)}</td>
                    <td>${formatNum(item.faithfulness)}</td>
                    <td>${formatNum(item.relevancy)}</td>
                    <td>${formatNum(item.answerCorrectness)}</td>
                    <td>${item.failedCount ?? 0}</td>
                    <td>${item.reviewCount ?? 0}</td>
                    <td>
                        <button type="button" class="linkish" onclick="setCompareRole('baseline', '${escapeAttr(item.runId || '')}')">baseline</button>
                        <button type="button" class="linkish" onclick="setCompareRole('candidate', '${escapeAttr(item.runId || '')}')">candidate</button>
                    </td>
                </tr>`;
            }).join('') || '<tr><td colspan="11" class="muted">暂无评测记录</td></tr>';
        } catch (e) {
            setError('runsError', e.message || String(e));
        }
    }

    function changeRunsPage(delta) {
        const next = runsPage + delta;
        if (next < 1) return;
        if (delta > 0 && (next - 1) * runsSize >= runsTotal) return;
        runsPage = next;
        loadRuns();
    }

    function openReport(runId) {
        document.getElementById('runIdInput').value = runId;
        switchTab('report');
        loadReport();
    }

    function setCompareRole(role, runId) {
        if (role === 'baseline') {
            document.getElementById('baselineRunId').value = runId;
        } else {
            document.getElementById('candidateRunId').value = runId;
        }
        switchTab('compare');
    }

    async function runCompare() {
        setError('compareError', '');
        const baseline = document.getElementById('baselineRunId').value.trim();
        const candidate = document.getElementById('candidateRunId').value.trim();
        if (!baseline || !candidate) {
            setError('compareError', '请填写 baseline 与 candidate runId');
            return;
        }
        try {
            const url = '/eval/compare?baseline=' + encodeURIComponent(baseline)
                + '&candidate=' + encodeURIComponent(candidate);
            const resp = await fetch(url);
            const result = await resp.json();
            if (!result.success) {
                setError('compareError', result.message || '对比失败');
                document.getElementById('compareResult').style.display = 'none';
                return;
            }
            renderCompare(result.data);
        } catch (e) {
            setError('compareError', e.message || String(e));
        }
    }

    function renderCompare(data) {
        document.getElementById('compareResult').style.display = 'block';
        const metrics = [
            ['Hit@K', data.hitAtK],
            ['MRR', data.mrr],
            ['Recall@K', data.recallAtK],
            ['Faithfulness', data.faithfulness],
            ['Relevancy', data.relevancy],
            ['Correctness', data.answerCorrectness],
            ['Ctx Precision', data.contextPrecision],
            ['Ctx Recall', data.contextRecall],
            ['Avg Latency', data.avgLatencyMs]
        ];
        document.getElementById('compareMetrics').innerHTML = metrics.map(([label, delta]) => {
            const d = delta || {};
            const deltaClass = d.delta == null ? '' : (d.delta >= 0 ? 'delta-pos' : 'delta-neg');
            return `<div class="metric">
                <div class="label">${label}</div>
                <div class="value" style="font-size:16px;line-height:1.5;">
                    B ${formatNum(d.baseline)}<br>
                    C ${formatNum(d.candidate)}<br>
                    <span class="${deltaClass}">Δ ${formatSigned(d.delta)}</span>
                </div>
            </div>`;
        }).join('');

        document.getElementById('improvedCases').textContent =
            (data.improvedCaseIds && data.improvedCaseIds.length)
                ? data.improvedCaseIds.join(', ') : '无';
        document.getElementById('regressedCases').textContent =
            (data.regressedCaseIds && data.regressedCaseIds.length)
                ? data.regressedCaseIds.join(', ') : '无';
    }

    async function loadReport() {
        const runId = currentRunId();
        setError('reportError', '');
        if (!runId) {
            setError('reportError', '请输入 runId');
            return;
        }
        try {
            const resp = await fetch('/eval/report/' + encodeURIComponent(runId));
            const result = await resp.json();
            if (!result.success) {
                setError('reportError', result.message || '加载失败');
                return;
            }
            renderReport(result.data);
        } catch (e) {
            setError('reportError', e.message || String(e));
        }
    }

    function renderReport(report) {
        document.getElementById('summaryCard').style.display = 'block';
        document.getElementById('casesCard').style.display = 'block';
        if (report.runId) {
            document.getElementById('runIdInput').value = report.runId;
        }

        renderRunMeta(report);

        const retrieval = report.retrieval || {};
        const generation = report.generation || {};
        const context = report.context || {};
        const metrics = [
            ['Hit@K', '(命中率)', formatNum(retrieval.hitAtK)],
            ['MRR', '(平均倒数排名)', formatNum(retrieval.mrr)],
            ['Recall@K', '(召回率)', formatNum(retrieval.recallAtK)],
            ['Faithfulness', '(忠实度)', formatNum(generation.faithfulness)],
            ['Relevancy', '(相关性)', formatNum(generation.relevancy)],
            ['Correctness', '(正确性)', formatNum(generation.answerCorrectness)],
            ['Context Precision', '(上下文精确率)', formatNum(context.contextPrecision)],
            ['Context Recall', '(上下文召回率)', formatNum(context.contextRecall)],
            ['P95 Latency', '(P95 延迟)', retrieval.p95LatencyMs ?? '-']
        ];
        document.getElementById('metrics').innerHTML = metrics.map(([label, zh, value]) =>
            `<div class="metric"><div class="label">${label} <span class="zh">${zh}</span></div><div class="value">${value}</div></div>`
        ).join('');

        const tbody = document.getElementById('caseRows');
        tbody.innerHTML = (report.caseResults || []).map(item => {
            const retrievalScores = item.retrievalScores || {};
            const generationScores = item.generationScores || {};
            return `<tr>
                <td>${escapeHtml(item.caseId)}</td>
                <td>${escapeHtml(item.question || '')}</td>
                <td>${retrievalScores.hitAtK === true ? 'Y' : (retrievalScores.hitAtK === false ? 'N' : '-')}</td>
                <td>${formatNum(retrievalScores.mrr)}</td>
                <td>${formatNum(retrievalScores.recallAtK)}</td>
                <td>${formatNum(generationScores.faithfulness)}</td>
                <td>${formatNum(generationScores.relevancy)}</td>
                <td>${formatNum(generationScores.answerCorrectness)}</td>
                <td>${formatNum(generationScores.contextPrecision)}</td>
                <td>${formatNum(generationScores.contextRecall)}</td>
                <td>${item.latencyMs ?? '-'}</td>
            </tr>`;
        }).join('');
    }

    function renderRunMeta(report) {
        const config = report.config || {};
        const items = [
            ['runId', '(运行ID)', report.runId],
            ['datasetPath', '(数据集)', report.datasetPath],
            ['topK', '(检索TopK)', config.topK],
            ['concurrency', '(并发数)', config.concurrency],
            ['enableLlmJudge', '(LLM评判)', config.enableLlmJudge],
            ['reviewScoreThreshold', '(复核阈值)', config.reviewScoreThreshold],
            ['totalCases', '(用例总数)', report.totalCases],
            ['evaluatedCases', '(已评测)', report.evaluatedCases],
            ['generationEvaluatedCases', '(生成评测)', report.generationEvaluatedCases],
            ['createdAt', '(创建时间)', formatDateTime(report.createdAt)]
        ];
        document.getElementById('runMeta').innerHTML = items
            .filter(([, , value]) => value != null && value !== '')
            .map(([key, zh, value]) =>
                `<span class="meta-item"><span class="meta-key">${key}${zh}</span>=<span class="meta-val">${escapeHtml(String(value))}</span></span>`
            ).join('');
    }

    function exportCsv() {
        const runId = currentRunId();
        if (!runId) return;
        window.open('/eval/report/' + encodeURIComponent(runId) + '/export.csv', '_blank');
    }

    function formatNum(value) {
        return value == null || Number.isNaN(value) ? '-' : Number(value).toFixed(4);
    }

    function formatSigned(value) {
        if (value == null || Number.isNaN(value)) return '-';
        const num = Number(value);
        const text = num.toFixed(4);
        return num > 0 ? '+' + text : text;
    }

    function formatDateTime(value) {
        if (value == null || value === '') return '-';
        const text = String(value);
        const match = text.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
        return match ? match[1].replace('T', ' ') : text;
    }

    function shortPath(path) {
        if (!path) return '-';
        const text = String(path);
        if (text.length <= 48) return text;
        return '…' + text.slice(-45);
    }

    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;');
    }

    function escapeAttr(text) {
        return String(text == null ? '' : text)
            .replaceAll('\\', '\\\\')
            .replaceAll("'", "\\'")
            .replaceAll('"', '&quot;');
    }
