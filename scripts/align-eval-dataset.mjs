import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
const root = process.cwd();
const referenceSql = option('--sql', path.join(root, 'src/main/resources/sql/know_engine.sql'));
const input = option('--input', path.join(root, 'src/main/resources/eval/datasets/eval-test-all.jsonl'));
const output = option('--output', path.join(root, 'src/main/resources/eval/datasets/eval-test.jsonl'));
const apiBase = option('--api-base', 'http://127.0.0.1:8009').replace(/\/$/, '');
const dryRun = args.includes('--dry-run');

function parseValues(text) {
    const values = [];
    const escapes = { n: '\n', r: '\r', t: '\t', '0': '\0', Z: '\x1a' };
    let position = 0;
    while (position < text.length) {
        while (/\s/.test(text[position] || '') || text[position] === ',') position++;
        if (position >= text.length) break;
        if (text[position] === "'") {
            position++;
            let value = '';
            let closed = false;
            while (position < text.length) {
                const character = text[position++];
                if (character === '\\') {
                    if (position >= text.length) throw new Error('Incomplete SQL escape');
                    const escaped = text[position++];
                    value += escapes[escaped] ?? escaped;
                } else if (character === "'") {
                    if (text[position] === "'") { value += "'"; position++; }
                    else { closed = true; break; }
                } else value += character;
            }
            if (!closed) throw new Error('Unclosed SQL string');
            values.push(value);
        } else {
            const end = text.indexOf(',', position);
            const value = text.slice(position, end < 0 ? text.length : end).trim();
            values.push(value === 'NULL' ? null : value);
            position = end < 0 ? text.length : end;
        }
        while (/\s/.test(text[position] || '')) position++;
        if (position < text.length && text[position] !== ',') throw new Error('Unexpected SQL value separator');
    }
    return values;
}

function readTable(sql, table) {
    const declaration = sql.indexOf('CREATE TABLE `' + table + '`');
    if (declaration < 0) throw new Error('SQL table missing: ' + table);
    const end = sql.indexOf(') ENGINE', declaration);
    const columns = [...sql.slice(declaration, end).matchAll(/^\s*`([^`]+)`/gm)].map(match => match[1]);
    const prefix = 'INSERT INTO `' + table + '` VALUES (';
    return sql.split(/\r?\n/).filter(line => line.startsWith(prefix)).map(line => {
        if (!line.endsWith(');')) throw new Error('Unsupported SQL INSERT for ' + table);
        const values = parseValues(line.slice(prefix.length, -2));
        if (values.length !== columns.length) throw new Error('SQL column count mismatch for ' + table);
        return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
    });
}

async function getPage(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + url);
    return response.json();
}

const sql = fs.readFileSync(referenceSql, 'utf8').replace(/^\uFEFF/, '');
const referenceDocuments = new Map(readTable(sql, 'knowledge_document').map(document => [document.doc_id, document]));
const referenceSegments = new Map(readTable(sql, 'knowledge_segment').map(segment => [segment.chunk_id, segment]));
const cases = fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const documents = [];
for (let current = 1; ; current++) {
    const page = await getPage(apiBase + '/api/document/page?current=' + current + '&size=100');
    documents.push(...page.records);
    if (current >= (page.pages || 1)) break;
}
const localSegments = new Map();
const title = value => String(value).normalize('NFKC').trim();
const text = value => String(value).normalize('NFKC').replace(/\s+/g, '').trim();
const documentMap = new Map();
for (const oldId of new Set(cases.flatMap(item => item.groundTruthDocumentIds || []))) {
    const reference = referenceDocuments.get(String(oldId));
    if (!reference) throw new Error('Reference document not found: ' + oldId);
    const matches = documents.filter(document => title(document.docTitle) === title(reference.doc_title));
    if (matches.length !== 1) throw new Error('Expected one local document for ' + reference.doc_title + '; found ' + matches.length);
    const document = matches[0];
    documentMap.set(String(oldId), String(document.docId));
    const segments = [];
    for (let current = 1; ; current++) {
        const page = await getPage(apiBase + '/api/segment/page-by-document?documentId=' + document.docId + '&documentVersion=' + document.currentVersionId + '&current=' + current + '&size=1000');
        segments.push(...page.records);
        if (current >= (page.pages || 1)) break;
    }
    localSegments.set(String(document.docId), segments);
}

const mappings = new Map();
const unresolved = [];
for (const oldId of new Set(cases.flatMap(item => item.groundTruthChunkIds || []))) {
    const reference = referenceSegments.get(String(oldId));
    if (!reference) { unresolved.push({ chunkId: oldId, reason: 'missing from reference SQL' }); continue; }
    const documentId = documentMap.get(reference.document_id);
    const candidates = (localSegments.get(documentId) || []).filter(segment => segment.skipEmbedding === Number(reference.skip_embedding) && text(segment.text) === text(reference.text));
    if (candidates.length !== 1) { unresolved.push({ chunkId: oldId, documentId, reason: 'expected one exact text match', matches: candidates.length }); continue; }
    const match = candidates[0];
    if (match.skipEmbedding !== 1 && match.status !== 'VECTOR_STORED') { unresolved.push({ chunkId: oldId, documentId, reason: 'local segment has not been embedded' }); continue; }
    mappings.set(String(oldId), String(match.chunkId));
}
if (unresolved.length) {
    console.error(JSON.stringify({ cases: cases.length, unresolved }, null, 2));
    process.exitCode = 1;
} else {
    const aligned = cases.map(item => ({ ...item,
        groundTruthChunkIds: (item.groundTruthChunkIds || []).map(id => mappings.get(String(id))),
        groundTruthDocumentIds: (item.groundTruthDocumentIds || []).map(id => documentMap.get(String(id)))
    }));
    for (const item of aligned) {
        for (const chunkId of item.groundTruthChunkIds) {
            if (!item.groundTruthDocumentIds.some(id => localSegments.get(id)?.some(segment => String(segment.chunkId) === chunkId))) throw new Error('Chunk/document mismatch: ' + item.id);
        }
    }
    const changedCases = aligned.filter((item, index) => JSON.stringify(item.groundTruthChunkIds) !== JSON.stringify(cases[index].groundTruthChunkIds) || JSON.stringify(item.groundTruthDocumentIds) !== JSON.stringify(cases[index].groundTruthDocumentIds)).length;
    if (!dryRun) fs.writeFileSync(output, aligned.map(item => JSON.stringify(item)).join('\n') + '\n');
    console.log(JSON.stringify({ cases: aligned.length, mappedDocuments: documentMap.size, mappedChunks: mappings.size, changedCases, dryRun, output }));
}
