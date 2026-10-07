import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.KNOW_ENGINE_URL || 'http://127.0.0.1:8009';
const output = path.resolve(process.argv[2] || path.join(project, 'target', 'frontend-verification'));
const inventory = JSON.parse(fs.readFileSync(path.join(project, 'docs/frontend-feature-inventory.json'), 'utf8'));
fs.mkdirSync(output, { recursive: true });
const browserProfile = path.join(output, 'browser-profile-' + Date.now());
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--user-data-dir=' + browserProfile,
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
const checks = [];
const blockedWrites = [];
const dependencyRoot = process.env.KNOW_ENGINE_TEST_DEPENDENCIES;
const dependencies = dependencyRoot ? JSON.parse(fs.readFileSync(path.join(dependencyRoot, 'manifest.json'), 'utf8')) : [];
let socket;
let closeBrowser;
let startupError;
let stderrEndpoint;
browser.on('error', error => { startupError = error; });
browser.stderr.on('data', chunk => {
    const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) stderrEndpoint = match[1];
});
try {
    const endpoint = await (async () => {
        const deadline = Date.now() + 30000;
        const portFile = path.join(browserProfile, 'DevToolsActivePort');
        while (Date.now() < deadline) {
            if (startupError) throw startupError;
            if (stderrEndpoint) return stderrEndpoint;
            // Edge's Windows launcher can exit successfully while its child owns CDP.
            if (fs.existsSync(portFile)) {
                const [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
                if (Number(port) > 0 && browserPath?.startsWith('/devtools/browser/')) {
                    return 'ws://127.0.0.1:' + port + browserPath;
                }
            }
            if (browser.exitCode !== null && browser.exitCode !== 0) {
                throw new Error('Browser exited with code ' + browser.exitCode);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Browser startup timeout');
    })();
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    let requestFailure;
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            const task = pending.get(message.id);
            pending.delete(message.id);
            clearTimeout(task.timeout);
            message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
        }
        if (message.method === 'Fetch.requestPaused') intercept(message.params).catch(error => { requestFailure = error; });
        if (message.method === 'Page.javascriptDialogOpening') cdp('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
    function send(method, params = {}, sessionId) {
        return new Promise((resolve, reject) => {
            const id = ++sequence;
            const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
            pending.set(id, { resolve, reject, timeout });
            socket.send(JSON.stringify({ id, method, params, sessionId }));
        });
    }
    closeBrowser = () => send('Browser.close');
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const cdp = (method, params) => send(method, params, sessionId);
    await cdp('Page.enable');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: base + '/*', requestStage: 'Request' },
        ...dependencies.map(item => ({ urlPattern: item.url, requestStage: 'Request' })),
    ] });

    // All mutations are intercepted before transmission, including GET-based chat actions.
    // The real knowledge corpus, conversations and evaluation reports remain read-only.
    async function intercept({ requestId, request }) {
        const dependency = dependencies.find(item => item.url === request.url);
        if (dependency) {
            const filename = path.join(dependencyRoot, dependency.name);
            return cdp('Fetch.fulfillRequest', {
                requestId, responseCode: fs.existsSync(filename) ? 200 : 404,
                responseHeaders: [{ name: 'Content-Type', value: filename.endsWith('.css') ? 'text/css' : 'text/javascript' }],
                body: (fs.existsSync(filename) ? fs.readFileSync(filename) : Buffer.from('')).toString('base64'),
            });
        }
        const url = new URL(request.url);
        const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
            || /^\/chat\/(?:send|conversation\/(?:create|delete))/.test(url.pathname);
        if (!mutation) return cdp('Fetch.continueRequest', { requestId });
        blockedWrites.push({ method: request.method, path: url.pathname, query: url.search, body: request.postData });
        let payload = true;
        let type = 'application/json';
        if (url.pathname === '/api/document/upload' || url.pathname === '/api/document/upload-version') {
            payload = { docId: 9999, docTitle: '浏览器回归样例', currentVersionId: 9999, status: 'UPLOADED' };
        } else if (/^\/api\/document\/split\//.test(url.pathname)) {
            payload = { docId: 9999, status: 'VECTOR_STORED' };
        } else if (url.pathname === '/chat/send') {
            type = 'text/event-stream';
            payload = 'data: [PROGRESS]:正在检索知识库内容...\n\ndata: 浏览器流式回归检查\n\ndata: [DONE]\n\n';
        } else if (/^\/chat\/conversation\/delete/.test(url.pathname)) {
            payload = { success: true, data: true };
        } else if (/^\/chat\/conversation\/create/.test(url.pathname)) {
            payload = { success: true, data: '00000000-0000-4000-8000-000000000099' };
        } else if (url.pathname === '/eval/dataset/upload') {
            payload = { success: true, data: { datasetPath: 'classpath:eval/datasets/eval-test.jsonl' } };
        } else if (url.pathname === '/eval/run') {
            payload = { success: false, message: 'Browser test intercepted the evaluation; no model request was sent.' };
        }
        await cdp('Fetch.fulfillRequest', {
            requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: type }],
            body: Buffer.from(typeof payload === 'string' && type !== 'application/json' ? payload : JSON.stringify(payload)).toString('base64'),
        });
    }
    async function evaluate(expression) {
        if (requestFailure) throw requestFailure;
        const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    }
    async function wait(expression) {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            if (await evaluate(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Page wait timeout: ' + expression);
    }
    async function navigate(page) {
        await cdp('Page.navigate', { url: base + '/' + page + '.html' });
        await wait('document.readyState === "complete" && location.pathname === ' + JSON.stringify('/' + page + '.html'));
    }
    async function click(selector) {
        await evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
    }
    async function file(selector, suffix) {
        const directory = path.join(project, suffix === '.jsonl' ? 'src/main/resources/eval/datasets' : 'src/main/resources/testFile');
        const name = fs.readdirSync(directory).find(name => name.endsWith(suffix));
        assert(name, 'Missing test file for ' + suffix);
        const { root } = await cdp('DOM.getDocument');
        const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector });
        await cdp('DOM.setFileInputFiles', { nodeId, files: [path.join(directory, name)] });
    }
    function pass(name) { checks.push(name); console.log('PASS ' + name); }
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (const page of inventory.pages) {
        await navigate(page.page);
        const ids = [...new Set(page.ids.filter(id => !id.includes('${')))];
        const missing = await evaluate('(' + JSON.stringify(ids) + ').filter(id => !document.getElementById(id))');
        assert.deepEqual(missing, [], page.page + ' lost controls');
        const missingFunctions = await evaluate('(' + JSON.stringify(page.functions) + ').filter(name => typeof window[name] !== "function")');
        assert.deepEqual(missingFunctions, [], page.page + ' lost workflow functions');
        const nav = await evaluate('Array.from(document.querySelectorAll(".app-nav .nav-link")).map(a => ({path:new URL(a.href).pathname,active:a.classList.contains("is-active")}))');
        assert.equal(nav.length, 4);
        assert.deepEqual(nav.filter(a => a.active).map(a => a.path), ['/' + page.page + '.html']);
        pass(page.page + ': all original controls, workflow functions and navigation');
        const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(output, page.page + '-desktop.png'), Buffer.from(screenshot.data, 'base64'));
    }

    await navigate('upload');
    await file('#file', '.md');
    await evaluate('document.getElementById("title").value="浏览器回归样例"');
    await click('#uploadBtn');
    await wait('document.getElementById("result").classList.contains("success") && document.getElementById("documentId").value === "9999"');
    for (const [mode, expected] of [['LENGTH', 'overlapGroup'], ['TITLE', 'titleLevelGroup'], ['REGEX', 'regexGroup'], ['SEPARATOR', 'separatorGroup']]) {
        await evaluate('(()=>{const select=document.getElementById("splitType");select.value=' + JSON.stringify(mode) + ';select.dispatchEvent(new Event("change"))})()');
        assert(await evaluate('getComputedStyle(document.getElementById(' + JSON.stringify(expected) + ')).display !== "none"'));
    }
    assert(await evaluate('Array.from(document.getElementById("splitType").options).some(option=>option.value==="SMART")'));
    pass('upload: upload response, four parameter modes and the existing SMART option');
    await navigate('upload');
    await file('#file', '.csv');
    await evaluate('document.getElementById("title").value="表格回归样例"');
    await click('#uploadBtn');
    await wait('document.getElementById("tableSplitNotice").classList.contains("is-visible")');
    assert(await evaluate('getComputedStyle(document.getElementById("splitParamsPanel")).display === "none"'));
    pass('upload: CSV fixed row splitting keeps irrelevant controls hidden');

    await navigate('document');
    await wait('document.querySelector("#docTableBody tr input[type=checkbox]")');
    const docId = await evaluate('Number(document.querySelector("#docTableBody tr input[type=checkbox]").value)');
    await evaluate('openEditModal(' + docId + ')');
    await wait('document.getElementById("editModal").classList.contains("show")');
    assert(await evaluate('document.getElementById("editStatus").disabled'));
    await evaluate('closeModal("editModal");viewVersions(' + docId + ')');
    await wait('document.getElementById("versionListContent").textContent.includes("1.0.0")');
    await evaluate('closeModal("versionListModal");viewSegments(' + docId + ')');
    await wait('document.querySelector("#segmentList .segment-item")');
    await click('#segmentList .segment-toggle');
    assert(await evaluate('document.querySelector("#segmentList .segment-item-text").classList.contains("expanded")'));
    await evaluate('closeModal("segmentModal");openVersionSplitModal({docId:9999,docTitle:"回归样例"},"sample.csv")');
    assert(await evaluate('document.getElementById("versionTableSplitNotice").classList.contains("is-visible")'));
    pass('document: edit restrictions, version history, segments, expansion and table version splitting');

    await evaluate('closeModal("versionSplitModal");openEditModal(' + docId + ')');
    await wait('document.getElementById("editDocId").value === ' + JSON.stringify(String(docId)));
    await evaluate('document.getElementById("editTitle").value="回归编辑样例";saveDocument()');
    await wait('!document.getElementById("editModal").classList.contains("show")');
    const edit = blockedWrites.find(r => r.method === 'PUT' && r.path === '/api/document');
    assert(edit);
    assert.equal(JSON.parse(edit.body).docTitle, '回归编辑样例');
    assert(!Object.hasOwn(JSON.parse(edit.body), 'status'), 'Editing must preserve read-only status');
    await wait('document.querySelector("#docTableBody tr input[type=checkbox]")');
    await click('#selectAll');
    assert(await evaluate('selectedIds.size === document.querySelectorAll("#docTableBody input[type=checkbox]").length'));
    await evaluate('batchDelete()');
    assert(blockedWrites.some(r => r.method === 'DELETE' && r.path === '/api/document/batch'));
    await evaluate('openVersionModal(' + docId + ')');
    await wait('document.getElementById("versionModal").classList.contains("show")');
    await file('#versionFile', '.csv');
    await evaluate('document.getElementById("versionNumber").value="2.0.0";document.getElementById("versionChangelog").value="回归检查";submitVersion()');
    await wait('document.getElementById("versionSplitModal").classList.contains("show")');
    assert(blockedWrites.some(r => r.path === '/api/document/upload-version'));
    assert(await evaluate('document.getElementById("versionTableSplitNotice").classList.contains("is-visible")'));
    await evaluate('closeModal("versionSplitModal");viewSegments(' + docId + ')');
    await wait('document.querySelector("#segmentList .segment-actions")');
    const segmentId = await evaluate('Number(document.querySelector("#segmentList .segment-actions button[onclick^=editSegment]").getAttribute("onclick").match(/\\d+/)[0])');
    await evaluate('editSegment(' + segmentId + ')');
    await wait('document.getElementById("segmentEditModal").classList.contains("show")');
    await evaluate('document.getElementById("segEditText").value+="\\n浏览器模拟编辑";saveSegment()');
    await wait('!document.getElementById("segmentEditModal").classList.contains("show")');
    assert(blockedWrites.some(r => r.method === 'PUT' && r.path === '/api/segment'));
    await evaluate('deleteSegment(' + segmentId + ')');
    assert(blockedWrites.some(r => r.method === 'DELETE' && r.path === '/api/segment/' + segmentId));
    await evaluate('viewSegmentMeta(' + segmentId + ')');
    await wait('document.getElementById("segmentMetaContent").textContent.trim().length > 0');
    pass('document: edit payload, batch selection/deletion, version upload, segment editing/deletion and metadata');

    await navigate('chat');
    await wait('document.querySelector(".conversation-item")');
    const historyId = await evaluate('document.querySelector(".conversation-item").dataset.id');
    assert(await evaluate('document.querySelector(".conversation-item .time").textContent.trim().length > 0'));
    await click('.conversation-item');
    await wait('currentConversationId === ' + JSON.stringify(historyId) + ' && document.querySelector(".message")');
    assert(await evaluate('document.querySelector(".message-time").textContent.trim().length > 0'));
    pass('chat: actual conversation history, message recall and database timestamps');
    await click('#newChatBtn');
    assert(await evaluate('!document.getElementById("messageInput").disabled && !document.getElementById("sendBtn").disabled'));
    await evaluate('renderCardPrompt(appendMessage("assistant",""),"卡片回归检查")');
    assert(await evaluate('document.getElementById("messagesContainer").textContent.includes("卡片回归检查")'));
    await evaluate('messageInput.value="浏览器回归检查";sendBtn.click()');
    await wait('document.getElementById("messagesContainer").textContent.includes("浏览器流式回归检查")');
    pass('chat: new conversation, card prompt and streamed answer handling');
    assert(await evaluate('renderMarkdown("**加粗**\\n\\n- 列表").includes("<strong>加粗</strong>")'));
    assert(await evaluate('!renderMarkdown("<img src=x onerror=alert(1)>").includes("onerror")'));
    await evaluate('(()=>{const m=appendMessage("assistant", "引用检查");renderReferences(m,[{documentTitle:"知识库来源",url:"http://127.0.0.1:9090/know-engine/sample.md"}]);renderWarnMessage(appendMessage("assistant", ""),"警告回归检查")})()');
    assert(await evaluate('document.querySelector(".reference-item").textContent.includes("知识库来源") && messagesContainer.textContent.includes("警告回归检查")'));
    await evaluate('deleteConversation({stopPropagation(){}},"00000000-0000-4000-8000-000000000099")');
    assert(blockedWrites.some(r => r.path === '/chat/conversation/delete'));
    pass('chat: Markdown sanitation, references, warnings and conversation deletion');
    if (await evaluate('Array.from(document.scripts).some(script=>script.src.includes("/vendor/"))')) {
        assert(await evaluate('!!(window.marked && window.DOMPurify && window.hljs)'));
        assert(await evaluate('renderMarkdown("```javascript\\nconst answer = 42;\\n```").includes("hljs-keyword")'));
        assert(await evaluate('renderMarkdown("| 字段 | 值 |\\n| --- | --- |\\n| 问题 | 回答 |").includes("<table>")'));
        pass('chat: local dependencies, actual code highlighting and Markdown tables');
    }

    await navigate('eval-report');
    await click('[data-tab="runs"]');
    await wait('document.querySelector("#runsRows button")');
    await click('#runsRows button');
    await wait('document.querySelectorAll("#caseRows tr").length > 0');
    assert(await evaluate('document.getElementById("summaryCard").style.display !== "none"'));
    await click('[data-tab="compare"]');
    assert(await evaluate('document.getElementById("panel-compare").classList.contains("active")'));
    pass('evaluation: history, report details and comparison panel');
    await evaluate('baselineRunId.value="20260911-014300-7afe0a4b";candidateRunId.value="20261002-223703-c8484647";runCompare()');
    await wait('document.getElementById("compareResult").style.display === "block"');
    assert(await evaluate('document.getElementById("compareMetrics").textContent.includes("MRR")'));
    await evaluate('window.open=(url)=>{window.lastExport=url};exportCsv()');
    const exportPath = await evaluate('window.lastExport');
    assert.match(exportPath, /^\/eval\/report\/[^/]+\/export\.csv$/);
    const csv = await fetch(base + exportPath);
    assert.equal(csv.status, 200);
    assert((await csv.text()).includes('aurora-'));
    await click('[data-tab="run"]');
    await evaluate('topK.value="7";concurrency.value="2";enableLlmJudge.checked=false;reviewScoreThreshold.value="0.7";startEval()');
    await wait('document.getElementById("runError").textContent.includes("intercepted")');
    const run = JSON.parse(blockedWrites.find(r => r.path === '/eval/run').body);
    assert.deepEqual(run.config, { topK: 7, concurrency: 2, enableLlmJudge: false, reviewScoreThreshold: 0.7 });
    await file('#datasetFile', '.jsonl');
    await evaluate('datasetPath.value="ignored-when-uploading.jsonl";startEval()');
    await wait('document.getElementById("runError").textContent.includes("intercepted") && !document.getElementById("runBtn").disabled');
    assert(blockedWrites.some(r=>r.path === '/eval/dataset/upload'));
    assert.equal(JSON.parse(blockedWrites.filter(r=>r.path === '/eval/run').at(-1).body).datasetPath, 'classpath:eval/datasets/eval-test.jsonl');
    pass('evaluation: real report comparison/CSV export and mocked evaluation configuration/error feedback');

    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    for (const page of inventory.pages) {
        await navigate(page.page);
        const navFits = await evaluate('Array.from(document.querySelectorAll(".app-nav .nav-link")).every(a=>{const r=a.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth})');
        assert(navFits, page.page + ' navigation is clipped at mobile width');
        assert(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), page.page + ' overflows the mobile viewport');
        if (page.page === 'chat' && await evaluate('Array.from(document.scripts).some(script=>script.src.includes("/vendor/"))')) {
            assert(await evaluate('document.querySelector(".chat-main").getBoundingClientRect().width >= innerWidth - 40'), 'Mobile conversation list squeezed the chat');
        }
        const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(output, page.page + '-mobile.png'), Buffer.from(screenshot.data, 'base64'));
    }
    pass('all four pages: mobile navigation remains visible');
    if (requestFailure) throw requestFailure;
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, blockedWrites: blockedWrites.map(({body,...request})=>request) }, null, 2));
    console.log('PASS ' + checks.length + ' browser workflow groups; ' + blockedWrites.length + ' mutations mocked before transmission.');
} finally {
    if (socket?.readyState === WebSocket.OPEN) {
        try { await closeBrowser?.(); } catch {}
    }
    socket?.close();
    if (browser.exitCode === null) browser.kill();
}
