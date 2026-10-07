
        const fileInput = document.getElementById('file');
        const fileName = document.getElementById('fileName');
        const fileWrapper = document.getElementById('fileWrapper');
        const uploadForm = document.getElementById('uploadForm');
        const uploadBtn = document.getElementById('uploadBtn');
        const progressContainer = document.getElementById('progressContainer');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const result = document.getElementById('result');
        const resultTitle = document.getElementById('resultTitle');
        const resultContent = document.getElementById('resultContent');
        const uploadGrid = document.getElementById('uploadGrid');
        const splitFormEl = document.getElementById('splitForm');
        const tableSplitNotice = document.getElementById('tableSplitNotice');
        const splitParamsPanel = document.getElementById('splitParamsPanel');
        const TABLE_SPLIT_DEFAULTS = { splitType: 'LENGTH', chunkSize: '500', overlap: '0' };
        let pendingSplitFileName = '';
        let isTableSplitMode = false;

        function getFileExtension(fileName) {
            if (!fileName) return '';
            const idx = fileName.lastIndexOf('.');
            return idx >= 0 ? fileName.substring(idx + 1).toLowerCase() : '';
        }

        function isTableFile(fileName) {
            const ext = getFileExtension(fileName);
            return ext === 'xlsx' || ext === 'xls' || ext === 'csv';
        }

        function applySplitUiMode(fileName) {
            isTableSplitMode = isTableFile(fileName);
            tableSplitNotice.classList.toggle('is-visible', isTableSplitMode);
            splitParamsPanel.style.display = isTableSplitMode ? 'none' : 'block';

            const splitTypeEl = document.getElementById('splitType');
            const chunkSizeEl = document.getElementById('chunkSize');
            if (isTableSplitMode) {
                splitTypeEl.value = TABLE_SPLIT_DEFAULTS.splitType;
                chunkSizeEl.value = TABLE_SPLIT_DEFAULTS.chunkSize;
                document.getElementById('overlap').value = TABLE_SPLIT_DEFAULTS.overlap;
                document.getElementById('titleLevel').value = '';
                document.getElementById('regex').value = '';
                document.getElementById('separator').value = '';
                updateParamVisibility();
            }
        }

        function showSplitPanel(visible) {
            splitFormEl.classList.toggle('is-visible', visible);
            uploadGrid.classList.toggle('has-split', visible);
            splitFormEl.style.display = visible ? 'block' : 'none';
            if (visible) {
                applySplitUiMode(pendingSplitFileName);
            } else {
                isTableSplitMode = false;
                pendingSplitFileName = '';
                tableSplitNotice.classList.remove('is-visible');
                splitParamsPanel.style.display = 'block';
            }
        }

        fileInput.addEventListener('change', function() {
            if (this.files && this.files[0]) {
                const file = this.files[0];
                const fullName = file.name;
                fileName.textContent = fullName;
                const lastDotIdx = fullName.lastIndexOf('.');
                const baseName = lastDotIdx > 0 ? fullName.substring(0, lastDotIdx) : fullName;
                const titleInput = document.getElementById('title');
                const descInput = document.getElementById('description');
                if (!titleInput.value.trim()) {
                    titleInput.value = baseName;
                }
                if (!descInput.value.trim()) {
                    descInput.value = baseName;
                }
            }
        });

        fileWrapper.addEventListener('dragover', (e) => {
            e.preventDefault();
            fileWrapper.classList.add('is-dragover');
        });

        fileWrapper.addEventListener('dragleave', () => {
            fileWrapper.classList.remove('is-dragover');
        });

        fileWrapper.addEventListener('drop', (e) => {
            e.preventDefault();
            fileWrapper.classList.remove('is-dragover');

            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                fileInput.files = e.dataTransfer.files;
                const fullName = e.dataTransfer.files[0].name;
                fileName.textContent = fullName;
                const lastDotIdx = fullName.lastIndexOf('.');
                const baseName = lastDotIdx > 0 ? fullName.substring(0, lastDotIdx) : fullName;
                const titleInput = document.getElementById('title');
                const descInput = document.getElementById('description');
                if (!titleInput.value.trim()) {
                    titleInput.value = baseName;
                }
                if (!descInput.value.trim()) {
                    descInput.value = baseName;
                }
            }
        });

        uploadForm.addEventListener('submit', async function(e) {
            e.preventDefault();

            const file = fileInput.files[0];
            if (!file) {
                showResult('error', '请选择要上传的文件');
                return;
            }

            const formData = new FormData();
            formData.append('file', file);
            formData.append('title', document.getElementById('title').value);
            formData.append('description', document.getElementById('description').value);

            result.className = 'result';
            progressContainer.style.display = 'block';
            uploadBtn.disabled = true;
            uploadBtn.textContent = '上传中...';

            try {
                const xhr = new XMLHttpRequest();

                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        const percent = Math.round((e.loaded / e.total) * 100);
                        progressFill.style.width = percent + '%';
                        progressText.textContent = percent + '%';
                    }
                });

                xhr.addEventListener('load', () => {
                    progressContainer.style.display = 'none';
                    uploadBtn.disabled = false;
                    uploadBtn.textContent = '开始上传';

                    if (xhr.status === 200) {
                        const response = JSON.parse(xhr.responseText);
                        pendingSplitFileName = file.name;
                        showResult('success', '上传成功！', `
                            <strong>文档ID：</strong>${response.docId}<br>
                            <strong>文档标题：</strong>${response.docTitle}<br>
                            <strong>版本ID：</strong>${response.currentVersionId ?? '-'}<br>
                            <strong>状态：</strong>${response.status}
                        `);
                        document.getElementById('documentId').value = response.docId;
                        showSplitPanel(true);
                        uploadForm.reset();
                        fileName.textContent = '';
                    } else {
                        let errorMsg = '服务器返回错误：' + xhr.status;
                        try {
                            const respText = xhr.responseText.trim();
                            if (respText) errorMsg = respText;
                        } catch (err) {}
                        showResult('error', '上传失败', errorMsg);
                    }
                });

                xhr.addEventListener('error', () => {
                    progressContainer.style.display = 'none';
                    uploadBtn.disabled = false;
                    uploadBtn.textContent = '开始上传';
                    showResult('error', '上传失败', '网络请求出错，请检查网络连接');
                });

                xhr.open('POST', '/api/document/upload');
                xhr.send(formData);

            } catch (error) {
                progressContainer.style.display = 'none';
                uploadBtn.disabled = false;
                uploadBtn.textContent = '开始上传';
                showResult('error', '上传失败', error.message);
            }
        });

        function showResult(type, title, content = '') {
            result.className = 'result ' + type;
            resultTitle.textContent = title;
            resultContent.innerHTML = content;
        }

        const splitTypeSelect = document.getElementById('splitType');
        const splitConfigForm = document.getElementById('splitConfigForm');
        const splitBtn = document.getElementById('splitBtn');

        function updateParamVisibility() {
            const splitType = splitTypeSelect.value;
            document.getElementById('overlapGroup').classList.remove('show');
            document.getElementById('titleLevelGroup').classList.remove('show');
            document.getElementById('regexGroup').classList.remove('show');
            document.getElementById('separatorGroup').classList.remove('show');

            if (splitType === 'LENGTH' || splitType === 'TITLE') {
                document.getElementById('overlapGroup').classList.add('show');
            }
            if (splitType === 'TITLE') {
                document.getElementById('titleLevelGroup').classList.add('show');
            }
            if (splitType === 'REGEX') {
                document.getElementById('regexGroup').classList.add('show');
            }
            if (splitType === 'SEPARATOR') {
                document.getElementById('separatorGroup').classList.add('show');
            }
        }

        splitTypeSelect.addEventListener('change', updateParamVisibility);

        splitConfigForm.addEventListener('submit', async function(e) {
            e.preventDefault();

            const documentId = document.getElementById('documentId').value;
            let splitType = document.getElementById('splitType').value;
            let chunkSize = document.getElementById('chunkSize').value;
            let overlap = document.getElementById('overlap').value || 0;
            let titleLevel = document.getElementById('titleLevel').value || '';
            let regex = document.getElementById('regex').value || '';
            let separator = document.getElementById('separator').value || '';
            let splitModeLabel = splitType;

            if (isTableSplitMode) {
                splitType = TABLE_SPLIT_DEFAULTS.splitType;
                chunkSize = TABLE_SPLIT_DEFAULTS.chunkSize;
                overlap = TABLE_SPLIT_DEFAULTS.overlap;
                titleLevel = '';
                regex = '';
                separator = '';
                splitModeLabel = '表格固定处理（逐行键值对）';
            } else {
                if (!splitType) {
                    showResult('error', '请选择切片方式');
                    return;
                }
                if (!chunkSize || chunkSize < 1) {
                    showResult('error', '请输入有效的最大分段长度');
                    return;
                }
            }

            const params = new URLSearchParams();
            params.append('splitType', splitType);
            params.append('chunkSize', chunkSize);
            params.append('overlap', overlap);
            params.append('titleLevel', titleLevel);
            params.append('regex', regex);
            params.append('separator', separator);

            splitBtn.disabled = true;
            splitBtn.textContent = '切片中...';

            try {
                const response = await fetch(`/api/document/split/${documentId}?${params.toString()}`, {
                    method: 'POST'
                });

                if (response.ok) {
                    const resultData = await response.json();
                    showResult('success', '切片完成！', `
                        <strong>文档ID：</strong>${documentId}<br>
                        <strong>切片方式：</strong>${splitModeLabel}<br>
                        <strong>切片数量：</strong>${resultData} 个片段
                    `);
                    showSplitPanel(false);
                    setTimeout(() => { window.location.href = '/document.html'; }, 1500);
                } else {
                    const errorText = await response.text();
                    showResult('error', '切片失败', errorText || '服务器返回错误：' + response.status);
                }
            } catch (error) {
                showResult('error', '切片失败', error.message);
            } finally {
                splitBtn.disabled = false;
                splitBtn.textContent = '开始切片';
            }
        });
