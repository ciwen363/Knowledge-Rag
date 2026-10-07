/* One navigation definition for every standalone page. Static anchors remain available before scripts load. */
(() => {
    const pages = [
        ['/upload.html', '上传文档'], ['/document.html', '文档管理'],
        ['/chat.html', 'AI 对话'], ['/eval-report.html', 'RAG 评测'],
    ];
    function renderNavigation() {
        document.querySelectorAll('.app-nav-links').forEach(nav => {
            nav.setAttribute('aria-label', '页面导航');
            nav.replaceChildren(...pages.map(([href, label]) => {
                const link = document.createElement('a');
                link.href = href;
                link.textContent = label;
                link.className = 'nav-link';
                if (location.pathname === href) {
                    link.classList.add('is-active');
                    link.setAttribute('aria-current', 'page');
                }
                return link;
            }));
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderNavigation);
    else renderNavigation();
})();
