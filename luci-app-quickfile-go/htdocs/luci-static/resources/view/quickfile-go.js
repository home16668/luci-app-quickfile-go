'use strict';
'require view';
'require ui';

const QF_VERSION = '2.0.1-r73';
function qfResource(url) { return url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(QF_VERSION); }

const API_BASE = (() => {
    const h = window.location.hostname;
    const host = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
    const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const qfPort = new URLSearchParams(window.location.search).get('qfport') || localStorage.getItem('quickfileGoPort') || '8989';
    if (/^\d{1,5}$/.test(qfPort)) localStorage.setItem('quickfileGoPort', qfPort);
    return `${proto}//${host}:${qfPort}`;
})();
const API = API_BASE + '/api';

function apiUrl(action, params) {
    const u = new URL(API);
    u.searchParams.set('action', action);
    Object.keys(params || {}).forEach(k => u.searchParams.set(k, params[k]));
    return u.toString();
}


function luciSession() {
    if (window.L && L.env && L.env.sessionid) return L.env.sessionid;
    const m = document.cookie.match(/(?:^|;\s*)sysauth(?:_[^=;]+)?=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
}

function downloadUrl(path) {
    const params = { path: path };
    const sid = luciSession();
    if (sid) params.sid = sid;
    return apiUrl('download', params);
}

function terminalUrl(path, cols, rows) {
    const wsBase = API_BASE.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    const u = new URL(wsBase + '/term');
    u.searchParams.set('path', path || '/');
    u.searchParams.set('cols', String(cols || 100));
    u.searchParams.set('rows', String(rows || 30));
    const sid = luciSession();
    if (sid) u.searchParams.set('sid', sid);
    return u.toString();
}

function loadScriptOnce(url, opts) {
    opts = opts || {};
    window.__qfScriptPromises = window.__qfScriptPromises || {};
    const key = url;
    if (opts.force) {
        delete window.__qfScriptPromises[key];
        document.querySelectorAll('script[data-qf-src="' + url + '"]').forEach(el => el.remove());
    } else if (window.__qfScriptPromises[key]) {
        return window.__qfScriptPromises[key];
    }
    const p = new Promise((resolve, reject) => {
        const old = document.querySelector('script[data-qf-src="' + url + '"]');
        if (old) {
            if (old.dataset.loaded === '1') return resolve();
            if (old.dataset.error === '1') {
                old.remove();
            } else {
                const timer = setTimeout(() => {
                    old.dataset.error = '1';
                    old.remove();
                    delete window.__qfScriptPromises[key];
                    reject(new Error('加载脚本超时: ' + url));
                }, opts.timeout || 8000);
                old.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
                old.addEventListener('error', () => { clearTimeout(timer); old.dataset.error = '1'; delete window.__qfScriptPromises[key]; reject(new Error('加载脚本失败: ' + url)); }, { once: true });
                return;
            }
        }
        const s = document.createElement('script');
        const timer = setTimeout(() => {
            s.dataset.error = '1';
            s.remove();
            delete window.__qfScriptPromises[key];
            reject(new Error('加载脚本超时: ' + url));
        }, opts.timeout || 8000);
        s.src = url;
        s.async = true;
        s.dataset.qfSrc = url;
        s.onload = () => { clearTimeout(timer); s.dataset.loaded = '1'; resolve(); };
        s.onerror = () => { clearTimeout(timer); s.dataset.error = '1'; s.remove(); delete window.__qfScriptPromises[key]; reject(new Error('加载脚本失败: ' + url)); };
        document.head.appendChild(s);
    });
    window.__qfScriptPromises[key] = p;
    return p;
}

function loadScriptWithRetry(urls, idx) {
    idx = idx || 0;
    if (idx >= urls.length) return Promise.reject(new Error('本地脚本资源加载失败'));
    const force = idx > 0;
    return loadScriptOnce(urls[idx], { force: force, timeout: 8000 }).catch(() => loadScriptWithRetry(urls, idx + 1));
}

function loadCSSOnce(url) {
    if (document.querySelector('link[data-qf-href="' + url + '"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = url;
    l.dataset.qfHref = url;
    document.head.appendChild(l);
}

function loadXtermLocal() {
    if (window.Terminal) return Promise.resolve(window.Terminal);
    const base = '/luci-static/resources/quickfile-go/xterm/';
    loadCSSOnce(qfResource(base + 'xterm.css'));
    const bust = String(Date.now());
    const xtermUrls = [
        qfResource(base + 'xterm.js'),
        base + 'xterm.js',
        qfResource(base + 'xterm.js') + '&retry=' + bust
    ];
    const fitUrls = [
        qfResource(base + 'fit.js'),
        base + 'fit.js',
        qfResource(base + 'fit.js') + '&retry=' + bust
    ];
    return loadScriptWithRetry(xtermUrls).then(() => {
        if (!window.Terminal) throw new Error('本地 xterm.js 未加载');
        return loadScriptWithRetry(fitUrls).catch(() => null).then(() => {
            if (window.fit && window.fit.apply) {
                try { window.fit.apply(window.Terminal); } catch (_) {}
            }
            return window.Terminal;
        });
    });
}

function promiseWithTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            reject(new Error(message || '操作超时'));
        }, ms);
        promise.then(value => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(value);
        }, err => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(err);
        });
    });
}

function loadMonacoEditor() {
    if (window.monaco && window.monaco.editor) return Promise.resolve(window.monaco);
    const candidates = [
        { loader: qfResource('/luci-static/resources/quickfile-go/monaco/vs/loader.js'), base: '/luci-static/resources/quickfile-go/monaco/vs' }
    ];
    const tryOne = idx => {
        if (idx >= candidates.length) return Promise.reject(new Error('Monaco Editor 未加载，已使用内置编辑器'));
        const c = candidates[idx];
        return loadScriptOnce(c.loader).then(() => new Promise((resolve, reject) => {
            if (!window.require) return reject(new Error('Monaco loader 不可用'));
            window.require.config({ paths: { vs: c.base } });
            window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
        })).catch(() => tryOne(idx + 1));
    };
    return tryOne(0);
}

function detectEditorLanguage(path) {
    const name = String(path || '').toLowerCase();
    const ext = name.split('.').pop();
    const map = {
        js: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', html: 'html', htm: 'html', css: 'css',
        go: 'go', sh: 'shell', bash: 'shell', zsh: 'shell', lua: 'lua', py: 'python', rb: 'ruby', php: 'php',
        xml: 'xml', yml: 'yaml', yaml: 'yaml', md: 'markdown', sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
        ini: 'ini', conf: 'ini', cfg: 'ini', log: 'plaintext', txt: 'plaintext'
    };
    if (name.endsWith('/makefile') || name.endsWith('makefile')) return 'makefile';
    return map[ext] || 'plaintext';
}


function bytesToText(data) {
    if (typeof data === 'string') return Promise.resolve(data);
    if (data instanceof Blob) return data.arrayBuffer().then(buf => new TextDecoder().decode(new Uint8Array(buf)));
    if (data instanceof ArrayBuffer) return Promise.resolve(new TextDecoder().decode(new Uint8Array(data)));
    return Promise.resolve(String(data || ''));
}

function formData(values) {
    const fd = new FormData();
    Object.keys(values || {}).forEach(k => fd.append(k, values[k]));
    return fd;
}

function apiFetch(action, options, params) {
    const opts = Object.assign({ credentials: 'include' }, options || {});
    const sid = luciSession();
    if (sid) {
        opts.headers = Object.assign({}, opts.headers || {}, { 'X-LuCI-Session': sid });
    }
    return fetch(apiUrl(action, params), opts).then(async r => {
        const body = await r.json().catch(() => ({ code: r.status, msg: r.statusText || '请求失败' }));
        if (!r.ok || (body.code && body.code >= 400)) {
            throw new Error(body.data || body.msg || '请求失败');
        }
        return body;
    });
}

function notifyError(err) {
    ui.addNotification(null, E('p', {}, String(err && err.message ? err.message : err)), 'danger');
}

function friendlyUploadError(status, body, fallback) {
    const raw = String((body && (body.data || body.msg)) || fallback || '').trim();
    const lower = raw.toLowerCase();
    if (status === 413 || lower.includes('too large') || lower.includes('超过') || lower.includes('maxbytesreader'))
        return raw.includes('超过') ? raw : '上传失败：文件超过最大上传限制';
    if (lower.includes('no space left') || lower.includes('空间不足'))
        return '上传失败：目标磁盘空间不足，请换到 /mnt 下空间更大的目录';
    if (lower.includes('permission denied') || lower.includes('operation not permitted') || lower.includes('权限'))
        return '上传失败：权限不足，无法写入当前目录';
    if (lower.includes('no such file') || lower.includes('not a directory') || lower.includes('目标目录不存在'))
        return '上传失败：目标目录不存在或不是目录';
    if (lower.includes('unexpected eof') || lower.includes('connection reset') || lower.includes('broken pipe') || lower.includes('network'))
        return '上传失败：连接中断或浏览器上传未完成';
    if (lower.includes('file exists'))
        return '上传失败：目标文件已存在或无法覆盖';
    return raw || '上传失败：未知错误';
}

function validName(name) {
    return !!name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

return view.extend({
    icons: {
        folder: '<svg viewBox="0 0 1024 1024" width="56" height="56"><path d="M928 256H599.168L501.76 158.592A64 64 0 0 0 456.448 140.8H96a64 64 0 0 0-64 64v614.4a64 64 0 0 0 64 64h832a64 64 0 0 0 64-64V320a64 64 0 0 0-64-64z" fill="#ff9800"/></svg>',
        file: '<svg viewBox="0 0 1024 1024" width="52" height="52"><path d="M854.6 288.6L639.4 73.4c-6-6-14.1-9.4-22.6-9.4H192c-17.7 0-32 14.3-32 32v832c0 17.7 14.3 32 32 32h640c17.7 0 32-14.3 32-32V311.3c0-8.5-3.4-16.7-9.4-22.7zM790.2 326H602V137.8L790.2 326zm1.8 562H232V136h302v216a42 42 0 0 0 42 42h216v494z" fill="#9e9e9e"/></svg>'
    },
    currentPath: '/',
    viewMode: 'grid',
    clipboard: null,
    theme: 'dark',
    fileInput: null,
    selectedFiles: new Set(),
    toolbarRefs: null,
    sortBy: 'name',
    sortDir: 'asc',
    settingsRefs: null,

    injectCSS: function() {
        if (document.getElementById('qf-custom-css')) return;
        const css = `
        .qf-app { background: #202124; color: #cfd3dc; font-family: "Helvetica Neue", Helvetica, sans-serif; border: 0; box-shadow: none; border-radius: 0; min-height: 0; position: relative; padding: 0; margin: 0; font-size: 14px; transition: 0.3s; }
        .qf-app.drag-over { outline: 2px dashed #409eff; background: rgba(64,158,255,0.05); }
        .qf-header { display: flex; justify-content: space-between; align-items: center; padding: 15px 20px; margin-bottom: 15px; background: #202124; border: 0; border-radius: 4px; }
        .qf-logo { font-size: 18px; font-weight: 600; color: #fff; display: flex; align-items: center; gap: 8px; }
        .qf-header-right { font-size: 13px; color: #a3a6ad; cursor: pointer; display: flex; gap: 15px; user-select: none; }
        .qf-header-right span:hover { color: #409eff; }
        .qf-card { background: #202124; border: 0; border-radius: 4px; box-shadow: none; margin-bottom: 15px; transition: 0.3s; }
        .qf-card:last-child { margin-bottom: 0; }
        .qf-breadcrumb { padding: 15px 20px; color: #cfd3dc; display: flex; align-items: center; flex-wrap: wrap; font-size: 13px; }
        .qf-breadcrumb span.qf-bc-link:hover { color: #409eff; text-decoration: underline; cursor: pointer; }
        .qf-toolbar { display: flex; gap: 8px; padding: 14px 16px; flex-wrap: wrap; border-bottom: 0; align-items: center; transition: 0.3s; }
        .qf-btn { display: inline-flex; align-items: center; gap: 6px; line-height: 1; cursor: pointer; background: #363637; border: 1px solid #414243; color: #cfd3dc; text-align: center; box-sizing: border-box; outline: none; margin: 0; transition: .15s; font-weight: 600; padding: 8px 14px; font-size: 12px; border-radius: 4px; min-height: 32px; }
        .qf-btn:hover { color: #409eff; border-color: #409eff; background-color: rgba(64,158,255,0.1); }
        .qf-btn-primary { color: #fff; background-color: #2f7df6; border-color: #2f7df6; }
        .qf-btn-primary:hover { background: #4a8ef7; border-color: #4a8ef7; color: #fff; }
        .qf-btn-danger-text { color: #f56c6c; border-color: transparent; background: transparent; }
        .qf-btn-danger-text:hover { background: rgba(245,108,108,0.1); border-color: transparent; }
        .qf-btn:disabled, .qf-btn.disabled { cursor: not-allowed; opacity: .55; color: #909399 !important; border-color: #4a4b4c !important; background: #303133 !important; }
        .qf-btn:disabled:hover, .qf-btn.disabled:hover { color: #909399 !important; border-color: #4a4b4c !important; background: #303133 !important; }
        .qf-btn-icon { font-size: 13px; display: inline-flex; align-items: center; justify-content: center; min-width: 12px; }
        .qf-search-box { margin-left: auto; display: flex; align-items: center; background: #1a1a1a; border: 1px solid #414243; border-radius: 4px; }
        .qf-search-box input { background: transparent; border: none; color: #cfd3dc; padding: 8px 12px; outline: none; font-size: 12px; }

        .qf-settings-panel { padding: 18px; background: #202124; color: #cfd3dc; }
        .qf-settings-note { color: #909399; font-size: 12px; margin-bottom: 14px; }
        .qf-settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; }
        .qf-settings-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #a3a6ad; }
        .qf-settings-field span { font-weight: 600; }
        .qf-settings-field input, .qf-settings-field select { width: 100%; box-sizing: border-box; background: #111214; border: 1px solid #3b3f45; color: #d7dce5; border-radius: 6px; padding: 9px 12px; min-height: 38px; line-height: 20px; outline: none; transition: .15s; }
        .qf-settings-field select { appearance: auto; -webkit-appearance: menulist; padding-right: 34px; }
        .qf-settings-field option { background: #111214; color: #d7dce5; }
        .qf-settings-field input:focus, .qf-settings-field select:focus { border-color: #409eff; box-shadow: 0 0 0 2px rgba(64,158,255,.15); }
        .qf-settings-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; padding-top: 16px; margin-top: 16px; border-top: 1px solid #34383e; }
        .qf-diagnose-output { display: none; background: #0f1012; border: 1px solid #34383e; color: #cfd3dc; border-radius: 6px; padding: 12px; white-space: pre-wrap; max-height: 240px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; margin-top: 14px; }
        .qf-settings-dialog { width: 620px; max-width: min(92vw, 620px); background: #202124; border: 1px solid #34383e; }
        .qf-settings-dialog .qf-dialog-header { background: #202124; color: #f0f3f8; border-bottom: 1px solid #34383e; }
        .qf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 15px; padding: 20px; padding-bottom: 50px; }
        .qf-grid.qf-list-view { display: flex; flex-direction: column; gap: 0; padding: 10px; }
        .qf-item { display: flex; flex-direction: column; align-items: center; padding: 15px 10px; border-radius: 4px; cursor: pointer; transition: 0.2s; border: 1px solid transparent; user-select: none; position: relative; }
        .qf-item:hover { background-color: rgba(255,255,255,0.05); }
        .qf-item.selected { background-color: rgba(64,158,255,0.1) !important; border-color: #409eff; }
        .qf-item.context-target { background-color: rgba(64,158,255,0.08) !important; border-color: #409eff; }
        .qf-item-name { margin-top: 10px; font-size: 13px; color: #cfd3dc; text-align: center; word-break: break-all; }
        .qf-item-icon { min-height: 58px; display: flex; align-items: center; justify-content: center; }
        .qf-thumb { width: 72px; height: 58px; max-width: 88px; object-fit: cover; border-radius: 6px; border: 1px solid #414243; background: #111214; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
        .qf-thumb-svg { object-fit: contain; background: #fff; padding: 4px; box-sizing: border-box; }
        .qf-item-meta { display: none; margin-left: auto; color: #909399; font-size: 12px; }
        .qf-grid.qf-list-view .qf-item { flex-direction: row; justify-content: flex-start; padding: 10px 15px 10px 35px; border-bottom: 1px solid #363637; border-radius: 0; }
        .qf-grid.qf-list-view .qf-item svg { width: 30px; height: 30px; margin-right: 15px; }
        .qf-grid.qf-list-view .qf-item-name { margin-top: 0; }
        .qf-grid.qf-list-view .qf-item-meta { display: block; }
        .qf-checkbox { position: absolute !important; top: 8px !important; left: 8px !important; width: 16px !important; height: 16px !important; cursor: pointer !important; opacity: 0 !important; pointer-events: none !important; z-index: 10 !important; margin: 0 !important; box-shadow: none !important; }
        .qf-grid.qf-list-view .qf-checkbox { top: 50% !important; transform: translateY(-50%) !important; left: 10px !important; }
        .qf-item:hover .qf-checkbox, .qf-item.selected .qf-checkbox { opacity: 1 !important; pointer-events: auto !important; }
        .qf-empty { padding: 40px; color: #909399; text-align: center; }
        .qf-context-menu { position: absolute; background: #202124; border: 1px solid #414243; border-radius: 4px; box-shadow: 0 2px 12px 0 rgba(0,0,0,0.5); z-index: 1000; padding: 5px 0; min-width: 150px; font-size: 13px; color: #cfd3dc; }
        .qf-menu-item { padding: 8px 20px; cursor: pointer; transition: 0.2s; display: flex; align-items: center; gap: 8px; }
        .qf-menu-item:hover { background: #414243; color: #409eff; }
        .qf-menu-separator { height: 1px; background: #414243; margin: 5px 0; }
        .qf-menu-item.disabled { color: #666; cursor: not-allowed; }
        .qf-menu-item.disabled:hover { background: transparent; color: #666; }
        /* List view: real columns, directory-first friendly layout */
        .qf-grid.qf-list-view { display: block; padding: 0 14px 18px 14px; }
        .qf-list-header { display: grid; grid-template-columns: 44px minmax(260px, 1fr) 110px 170px 130px; column-gap: 14px; align-items: center; min-height: 38px; padding: 0 16px 0 36px; border-bottom: 1px solid #3a3a3a; color: #aeb6c2; font-size: 12px; font-weight: 700; position: sticky; top: 0; background: #202124; z-index: 5; }
        .qf-list-header span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .qf-list-header span[data-sort] { cursor: pointer; user-select: none; }
        .qf-list-header span[data-sort]:hover { color: #409eff; }
        .qf-grid.qf-list-view .qf-item { display: grid; grid-template-columns: 44px minmax(260px, 1fr) 110px 170px 130px; column-gap: 14px; align-items: center; min-height: 58px; padding: 8px 16px 8px 36px; border-bottom: 1px solid #363637; border-radius: 0; }
        .qf-grid.qf-list-view .qf-item-icon { grid-column: 1; display: flex; align-items: center; justify-content: center; min-width: 34px; }
        .qf-grid.qf-list-view .qf-item-icon svg { width: 30px; height: 30px; margin: 0; }
        .qf-grid.qf-list-view .qf-thumb { width: 34px; height: 30px; max-width: 34px; border-radius: 4px; }
        .qf-grid.qf-list-view .qf-item-name { grid-column: 2; margin-top: 0; text-align: left; word-break: normal; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; color: #e5eaf3; }
        .qf-grid.qf-list-view .qf-item-meta { grid-column: 3 / 6; display: grid; grid-template-columns: 110px 170px 130px; column-gap: 14px; margin: 0; color: #aeb6c2; font-size: 12px; min-width: 0; }
        .qf-grid.qf-list-view .qf-item-meta span { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .qf-grid.qf-list-view .qf-col-size { color: #cdd6e3; }
        .qf-grid.qf-list-view .qf-col-time, .qf-grid.qf-list-view .qf-col-mode { color: #9aa4b2; }
        .qf-grid.qf-list-view .qf-item.qf-parent-row .qf-item-name { color: #dce8ff; }
        .qf-grid.qf-list-view .qf-item.qf-parent-row .qf-col-size { color: #f0c674; }
        @media (max-width: 1100px) {
            .qf-list-header, .qf-grid.qf-list-view .qf-item { grid-template-columns: 40px minmax(180px, 1fr) 90px 140px 100px; column-gap: 10px; }
            .qf-grid.qf-list-view .qf-item-meta { grid-template-columns: 90px 140px 100px; column-gap: 10px; }
        }
        .qf-app.qf-light { background: #ffffff; color: #606266; }
        .qf-app.qf-light .qf-logo { color: #303133; }
        .qf-app.qf-light .qf-header-right { color: #606266; }
        .qf-app.qf-light .qf-card { background: #fff; border-color: transparent; box-shadow: none; }
        .qf-app.qf-light .qf-breadcrumb { color: #606266; }
        .qf-app.qf-light .qf-toolbar, .qf-app.qf-light .qf-grid.qf-list-view .qf-item { border-color: #ebeef5; }
        .qf-app.qf-light .qf-btn { background: #f5f7fa; border-color: #e4e7ed; color: #606266; }
        .qf-app.qf-light .qf-btn:hover { color: #409eff; border-color: #c6e2ff; background-color: #ecf5ff; }
        .qf-app.qf-light .qf-btn-primary { color: #fff; background-color: #2f7df6; border-color: #2f7df6; }
        .qf-app.qf-light .qf-btn:disabled, .qf-app.qf-light .qf-btn.disabled { background: #f5f7fa !important; border-color: #ebeef5 !important; color: #c0c4cc !important; }

        .qf-app.qf-light .qf-settings-panel { background: #fff; color: #303133; }
        .qf-app.qf-light .qf-settings-note { color: #909399; }
        .qf-app.qf-light .qf-settings-field { color: #606266; }
        .qf-app.qf-light .qf-settings-field input, .qf-app.qf-light .qf-settings-field select { background: #fff; border-color: #dcdfe6; color: #606266; }
        .qf-app.qf-light .qf-diagnose-output { background: #f8f8f8; border-color: #ebeef5; color: #303133; }
        .qf-app.qf-light .qf-search-box { background: #fff; border-color: #dcdfe6; }
        .qf-app.qf-light .qf-search-box input { color: #606266; }
        .qf-app.qf-light .qf-item:hover { background-color: #f5f7fa; }
        .qf-app.qf-light .qf-item.selected { background-color: #e6f7ff !important; border-color: #93c9ff; }
        .qf-app.qf-light .qf-item.context-target { background-color: #eef7ff !important; border-color: #93c9ff; }
        .qf-app.qf-light .qf-item-name { color: #303133; }
        .qf-app.qf-light .qf-context-menu { background: #fff; border-color: #ebeef5; color: #606266; box-shadow: 0 2px 12px 0 rgba(0,0,0,0.1); }
        .qf-app.qf-light .qf-list-header { border-color: #ebeef5; color: #909399; background: #fff; }
        .qf-app.qf-light .qf-grid.qf-list-view .qf-item-name { color: #303133; }
        .qf-app.qf-light .qf-grid.qf-list-view .qf-item-meta, .qf-app.qf-light .qf-grid.qf-list-view .qf-col-time, .qf-app.qf-light .qf-grid.qf-list-view .qf-col-mode { color: #606266; }
        .qf-app.qf-light .qf-menu-item:hover { background: #ecf5ff; color: #66b1ff; }
        .qf-app.qf-light .qf-menu-separator { background: #ebeef5; }
        /* Complete light-mode coverage for main UI and floating UI */
        .qf-app.qf-light .qf-header { background: #fff; border-color: transparent; }
        .qf-app.qf-light .qf-breadcrumb span[style] { color: #909399 !important; }
        .qf-app.qf-light .qf-toolbar { background: #fff; border-color: transparent; }
        .qf-app.qf-light .qf-empty { color: #909399; }
        .qf-app.qf-light .qf-grid.qf-list-view .qf-col-size { color: #606266; }
        .qf-app.qf-light .qf-grid.qf-list-view .qf-item.qf-parent-row .qf-item-name { color: #303133; }
        .qf-app.qf-light .qf-grid.qf-list-view .qf-item.qf-parent-row .qf-col-size { color: #909399; }
        .qf-app.qf-light .qf-list-header span[data-sort]:hover { color: #409eff; }
        .qf-quickfile-light .qf-overlay { background: rgba(245,247,250,.72); }
        .qf-quickfile-light .qf-dialog { box-shadow: 0 14px 42px rgba(0,0,0,.16); }
        .qf-quickfile-light .qf-dialog .qf-btn { background: #f5f7fa; border-color: #dcdfe6; color: #606266; }
        .qf-quickfile-light .qf-dialog .qf-btn:hover { color: #409eff; border-color: #c6e2ff; background-color: #ecf5ff; }
        .qf-quickfile-light .qf-dialog .qf-btn-primary { color: #fff; background-color: #2f7df6; border-color: #2f7df6; }
        .qf-quickfile-light .qf-dialog .qf-btn:disabled,
        .qf-quickfile-light .qf-dialog .qf-btn.disabled { background: #f5f7fa !important; border-color: #ebeef5 !important; color: #c0c4cc !important; }
        .qf-quickfile-light .qf-settings-dialog,
        .qf-quickfile-light .qf-confirm-dialog { background: #fff; color: #303133; border-color: #ebeef5; }
        .qf-quickfile-light .qf-settings-dialog .qf-dialog-header,
        .qf-quickfile-light .qf-confirm-dialog .qf-dialog-header { background: #fff; color: #303133; border-bottom-color: #ebeef5; }
        .qf-quickfile-light .qf-confirm-dialog .qf-dialog-body { color: #606266; }
        .qf-quickfile-light .qf-confirm-message { color: #303133; }
        .qf-quickfile-light .qf-confirm-target { background: #f8f8f8; border-color: #ebeef5; color: #606266; }
        .qf-quickfile-light .qf-confirm-dialog .qf-dialog-footer { background: #fff; border-top-color: #ebeef5; }
        .qf-quickfile-light .qf-confirm-cancel { background: #f5f7fa; border-color: #dcdfe6; color: #606266; }
        .qf-quickfile-light .qf-confirm-cancel:hover { background: #ecf5ff; border-color: #c6e2ff; color: #409eff; }
        .qf-quickfile-light .qf-settings-panel { background: #fff; color: #303133; }
        .qf-quickfile-light .qf-settings-note { color: #909399; }
        .qf-quickfile-light .qf-settings-field { color: #606266; }
        .qf-quickfile-light .qf-settings-field input,
        .qf-quickfile-light .qf-settings-field select { background: #fff; border-color: #dcdfe6; color: #606266; }
        .qf-quickfile-light .qf-settings-field option { background: #fff; color: #606266; }
        .qf-quickfile-light .qf-settings-actions { border-top-color: #ebeef5; }
        .qf-quickfile-light .qf-diagnose-output { background: #f8f8f8; border-color: #ebeef5; color: #303133; }
        .qf-quickfile-light .qf-context-menu { background: #fff; border-color: #ebeef5; color: #606266; box-shadow: 0 2px 12px rgba(0,0,0,.12); }
        .qf-quickfile-light .qf-menu-item:hover { background: #ecf5ff; color: #409eff; }
        .qf-quickfile-light .qf-menu-separator { background: #ebeef5; }
        .qf-quickfile-light .qf-editor-dialog { background: #fff; color: #303133; border-color: #ebeef5; }
        .qf-quickfile-light .qf-editor-dialog .qf-dialog-header,
        .qf-quickfile-light .qf-editor-dialog .qf-dialog-footer { background: #fff; color: #303133; border-color: #ebeef5; }
        .qf-quickfile-light .qf-editor-host,
        .qf-quickfile-light .qf-editor { background: #fff; color: #303133; }
        .qf-quickfile-light .qf-editor-status { color: #606266; }
        .qf-quickfile-light .qf-terminal-dialog { background: #fff; color: #303133; border-color: #ebeef5; }
        .qf-quickfile-light .qf-terminal-dialog .qf-dialog-header { background: #fff; color: #303133; border-color: #ebeef5; }
        .qf-quickfile-light .qf-terminal-status { background: #f5f7fa; border-top-color: #ebeef5; color: #606266; }
        .qf-quickfile-light .qf-terminal-action { background: #f5f7fa; border-color: #dcdfe6; color: #606266; }
        .qf-quickfile-light .qf-terminal-action:hover { background: #ecf5ff; border-color: #c6e2ff; color: #409eff; }
        .qf-quickfile-light .qf-task-row { background: #fff; border-color: #ebeef5; }
        .qf-quickfile-light .qf-task-title { color: #303133; }
        .qf-quickfile-light .qf-task-meta { color: #606266; }
        .qf-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.52); z-index: 999999; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
        .qf-dialog { border-radius: 6px; box-shadow: 0 16px 48px rgba(0,0,0,.42); display: flex; flex-direction: column; overflow: hidden; font-family: sans-serif; }
        .qf-dialog-header { height: 46px; padding: 0 14px; display: flex; justify-content: space-between; align-items: center; box-sizing: border-box; font-weight: 700; }
        .qf-dialog-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .qf-dialog-close { color: #9aa4b2; cursor: pointer; font-size: 24px; text-decoration: none; width: 30px; height: 30px; text-align: center; line-height: 28px; border-radius: 4px; }
        .qf-dialog-close:hover { color: #f56c6c; background: rgba(245,108,108,.10); }
        .qf-dialog-body { padding: 0; flex: 1; display: flex; flex-direction: column; position: relative; min-height: 0; }
        .qf-dialog-footer { min-height: 58px; padding: 12px 16px; display: flex; align-items: center; justify-content: flex-end; gap: 10px; box-sizing: border-box; }
        .qf-confirm-dialog { width: min(92vw, 440px); background: #202124; color: #d7dce5; border: 1px solid #34383e; }
        .qf-confirm-dialog .qf-dialog-header { background: #202124; color: #f0f3f8; border-bottom: 1px solid #34383e; }
        .qf-confirm-dialog .qf-dialog-body { padding: 18px; display: block; line-height: 1.65; color: #cfd3dc; }
        .qf-confirm-icon { width: 38px; height: 38px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-right: 12px; background: rgba(64,158,255,.12); color: #409eff; font-size: 18px; flex: none; }
        .qf-confirm-icon.danger { background: rgba(245,108,108,.12); color: #f56c6c; }
        .qf-confirm-content { display: flex; align-items: flex-start; }
        .qf-confirm-main { flex: 1; min-width: 0; }
        .qf-confirm-message { font-size: 14px; color: #e5e7eb; margin-bottom: 8px; }
        .qf-confirm-target { color: #9aa4b2; font-size: 12px; word-break: break-all; white-space: pre-wrap; background: #111827; border: 1px solid #2a3441; border-radius: 6px; padding: 8px 10px; }
        .qf-confirm-dialog .qf-dialog-footer { background: #202124; border-top: 1px solid #2a3441; }
        .qf-confirm-cancel { border: 1px solid #3b3f45; background: #2b2f36; color: #d7dce5; border-radius: 6px; padding: 8px 16px; cursor: pointer; font-weight: 600; }
        .qf-confirm-ok { border: 1px solid #2f7df6; background: #2f7df6; color: #fff; border-radius: 6px; padding: 8px 16px; cursor: pointer; font-weight: 600; }
        .qf-confirm-ok.danger { border-color: #f56c6c; background: #f56c6c; }
        .qf-confirm-cancel:hover { background: #343a43; }
        .qf-confirm-ok:hover { filter: brightness(1.08); }
        .qf-form-row { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
        .qf-form-label { color: #aeb6c2; font-size: 12px; font-weight: 700; }
        .qf-form-input { width: 100%; box-sizing: border-box; background: #111214; border: 1px solid #3b3f45; color: #e5eaf3; border-radius: 6px; padding: 10px 12px; min-height: 38px; outline: none; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; }
        .qf-form-input:focus { border-color: #409eff; box-shadow: 0 0 0 2px rgba(64,158,255,.14); }
        .qf-form-help { color: #8f98a6; font-size: 12px; line-height: 1.5; margin-top: 8px; }
        .qf-form-error { color: #f56c6c; font-size: 12px; min-height: 18px; margin-top: 8px; }
        .qf-download-dialog { width: min(92vw, 560px); }
        .qf-download-path { color: #9aa4b2; font-size: 12px; word-break: break-all; background: #111827; border: 1px solid #2a3441; border-radius: 6px; padding: 8px 10px; margin-top: 8px; }
        .qf-download-grid { display: grid; grid-template-columns: 1fr; gap: 14px; margin-top: 12px; }
        .qf-download-tip { display: flex; align-items: flex-start; gap: 8px; color: #8f98a6; font-size: 12px; line-height: 1.6; background: rgba(64,158,255,.06); border: 1px solid rgba(64,158,255,.16); border-radius: 6px; padding: 9px 10px; }
        .qf-download-tip strong { color: #cfd7e6; }
        .qf-copy-path-value { user-select: text; -webkit-user-select: text; }
        .qf-quickfile-light .qf-form-label { color: #606266; }
        .qf-quickfile-light .qf-form-input { background: #fff; border-color: #dcdfe6; color: #303133; }
        .qf-quickfile-light .qf-form-help { color: #909399; }
        .qf-quickfile-light .qf-form-error { color: #f56c6c; }
        .qf-quickfile-light .qf-download-path { background: #f8f8f8; border-color: #ebeef5; color: #606266; }
        .qf-quickfile-light .qf-download-tip { background: #f4f8ff; border-color: #d9ecff; color: #606266; }
        .qf-quickfile-light .qf-download-tip strong { color: #303133; }
        .qf-install-dialog { width: min(92vw, 820px); max-height: min(86vh, 760px); background: #202124; color: #d7dce5; border: 1px solid #34383e; }
        .qf-install-dialog .qf-dialog-header { background: #202124; color: #f0f3f8; border-bottom: 1px solid #34383e; }
        .qf-install-dialog .qf-dialog-body { padding: 16px; gap: 12px; display: flex; flex-direction: column; }
        .qf-install-dialog .qf-dialog-footer { background: #202124; border-top: 1px solid #2a3441; }
        .qf-install-status-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .qf-install-status { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; color: #d7dce5; }
        .qf-install-dot { width: 10px; height: 10px; border-radius: 50%; background: #409eff; box-shadow: 0 0 0 5px rgba(64,158,255,.12); }
        .qf-install-status.success { color: #67c23a; }
        .qf-install-status.success .qf-install-dot { background: #67c23a; box-shadow: 0 0 0 5px rgba(103,194,58,.12); }
        .qf-install-status.fail { color: #f56c6c; }
        .qf-install-status.fail .qf-install-dot { background: #f56c6c; box-shadow: 0 0 0 5px rgba(245,108,108,.12); }
        .qf-install-meta { display: grid; grid-template-columns: 88px minmax(0,1fr); gap: 7px 10px; background: #111827; border: 1px solid #2a3441; border-radius: 8px; padding: 10px 12px; font-size: 12px; }
        .qf-install-meta-label { color: #8f98a6; font-weight: 700; }
        .qf-install-meta-value { color: #d7dce5; word-break: break-all; user-select: text; -webkit-user-select: text; }
        .qf-install-warning { background: rgba(245,108,108,.08); border: 1px solid rgba(245,108,108,.22); color: #f3b4b4; border-radius: 8px; padding: 10px 12px; line-height: 1.55; font-size: 12px; }
        .qf-install-log { height: min(46vh, 380px); min-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word; background: #0b1018; color: #d1d5db; border: 1px solid #2a3441; border-radius: 8px; padding: 12px; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; line-height: 1.45; user-select: text; -webkit-user-select: text; }
        .qf-install-actions-left { margin-right: auto; color: #9aa4b2; font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .qf-quickfile-light .qf-install-dialog { background: #fff; color: #303133; border-color: #ebeef5; }
        .qf-quickfile-light .qf-install-dialog .qf-dialog-header,
        .qf-quickfile-light .qf-install-dialog .qf-dialog-footer { background: #fff; color: #303133; border-color: #ebeef5; }
        .qf-quickfile-light .qf-install-status { color: #303133; }
        .qf-quickfile-light .qf-install-status.success { color: #529b2e; }
        .qf-quickfile-light .qf-install-status.fail { color: #c45656; }
        .qf-quickfile-light .qf-install-meta { background: #f8f8f8; border-color: #ebeef5; }
        .qf-quickfile-light .qf-install-meta-label { color: #606266; }
        .qf-quickfile-light .qf-install-meta-value { color: #303133; }
        .qf-quickfile-light .qf-install-warning { background: #fff7f7; border-color: #f5d6d6; color: #9f3a3a; }
        .qf-quickfile-light .qf-install-log { background: #f8f8f8; color: #303133; border-color: #ebeef5; }
        .qf-quickfile-light .qf-install-actions-left { color: #606266; }
        .qf-editor-dialog { width: min(86vw, 1280px); height: min(82vh, 820px); background: #111827; color: #e5e7eb; border: 1px solid #2a3441; }
        .qf-editor-dialog.qf-editor-fullscreen { width: calc(100vw - 24px); height: calc(100vh - 24px); max-width: none; max-height: none; border-radius: 6px; }
        .qf-editor-dialog .qf-dialog-header { background: #202124; color: #f9fafb; border-bottom: 1px solid #2a3441; }
        .qf-editor-dialog .qf-dialog-footer { background: #202124; border-top: 1px solid #2a3441; }
        .qf-editor { width: 100%; height: 100%; resize: none; background: #0b1018; color: #d1d5db; border: 0; padding: 12px; box-sizing: border-box; outline: none; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; line-height: 1.45; }
        .qf-editor-host { width: 100%; flex: 1; min-height: 0; background: #0b1018; position: relative; }
        .qf-editor-status { margin-right: auto; font-size: 12px; color: #9aa4b2; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .qf-terminal-dialog { width: min(58vw, 960px); min-width: 720px; height: min(66vh, 620px); background: #202124; color: #e5e7eb; }
        .qf-terminal-dialog.qf-terminal-fullscreen { width: calc(100vw - 24px); height: calc(100vh - 24px); min-width: 0; max-width: none; max-height: none; border-radius: 6px; }
        .qf-terminal-dialog .qf-dialog-header { background: #202124; color: #f9fafb; border-bottom: 1px solid #2a3441; }
        .qf-terminal-host { width: 100%; flex: 1; min-height: 0; background: #000; color: #ddd; overflow: hidden; border: 1px solid #111827; border-left: 0; border-right: 0; }
        .qf-terminal-fallback { height: 100%; overflow: auto; white-space: pre; outline: none; padding: 12px; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 14px; line-height: 1.35; background: #000; color: #eee; user-select: text; -webkit-user-select: text; caret-color: transparent; tab-size: 8; }
        .qf-terminal-actions { margin-left: auto; display: inline-flex; gap: 8px; align-items: center; }
        .qf-terminal-action { border: 1px solid #2a3441; background: #1f2937; color: #cbd5e1; border-radius: 4px; padding: 4px 9px; cursor: pointer; font-size: 12px; line-height: 1; }
        .qf-terminal-action:hover { background: #334155; color: #fff; border-color: #475569; }
        .qf-terminal-status { height: 38px; line-height: 38px; font-size: 12px; color: #9aa4b2; padding: 0 12px; border-top: 1px solid #2a3441; background: #202124; box-sizing: border-box; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
        .qf-terminal-host .terminal { height: 100%; padding: 10px; box-sizing: border-box; }
        .qf-task-list { max-height: 55vh; overflow: auto; padding: 12px; }
        .qf-task-row { border: 1px solid #374151; background: #1f242c; border-radius: 8px; padding: 10px; margin-bottom: 10px; }
        .qf-task-title { font-weight: 700; color: #e5e7eb; margin-bottom: 8px; display: flex; justify-content: space-between; gap: 12px; }
        .qf-task-meta { color: #a6adbb; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
        @media (max-width: 900px) { .qf-terminal-dialog, .qf-editor-dialog { width: 94vw; min-width: 0; height: 78vh; } }
        `;
        document.head.appendChild(E('style', { id: 'qf-custom-css' }, css));
    },

    load: function() {
        this.injectCSS();
        return this.fetchList(this.currentPath);
    },

    fetchList: function(path) {
        this.selectedFiles.clear();
        this.updateSelectionUI();
        return apiFetch('list', {}, { path: path }).then(res => res.data || []).catch(err => {
            notifyError(err);
            return [];
        });
    },

    refresh: function(newPath) {
        this.currentPath = newPath || '/';
        return this.fetchList(this.currentPath).then(files => {
            const app = document.querySelector('.qf-app');
            if (!app || !app.parentNode) return;
            const container = app.parentNode;
            container.innerHTML = '';
            container.appendChild(this.render(files));
        });
    },

    makeIcon: function(svgHTML) {
        const div = document.createElement('div');
        div.innerHTML = svgHTML;
        return div;
    },

    formatSize: function(size) {
        if (size < 1024) return size + ' B';
        if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
        return (size / 1024 / 1024).toFixed(1) + ' MB';
    },


    formatTime: function(ts) {
        if (!ts) return '-';
        const d = new Date(ts * 1000);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    sortFiles: function(files) {
        const arr = Array.from(files || []);
        let key = this.sortBy || 'name';
        if (key === 'owner') key = 'name';
        const dir = this.sortDir === 'desc' ? -1 : 1;
        const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
        arr.sort((a, b) => {
            // Directories are always grouped first, but sorting still applies inside the directory group.
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;

            const getTime = v => {
                if (typeof v === 'number') return v;
                if (typeof v === 'string') {
                    const n = Number(v);
                    if (!Number.isNaN(n)) return n;
                    const t = Date.parse(v);
                    return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
                }
                return 0;
            };

            let result = 0;
            if (key === 'name') {
                result = byName(a, b);
            } else if (key === 'size') {
                result = Number(a.size || 0) - Number(b.size || 0);
            } else if (key === 'time') {
                result = getTime(a.time || a.mtime) - getTime(b.time || b.mtime);
            } else if (key === 'mode') {
                result = String(a[key] || '').localeCompare(String(b[key] || ''), undefined, { numeric: true, sensitivity: 'base' });
            } else {
                result = byName(a, b);
            }
            if (result === 0) result = byName(a, b);
            return result * dir;
        });
        return arr;
    },

    setSort: function(key) {
        if (this.sortBy === key) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        else { this.sortBy = key; this.sortDir = key === 'name' ? 'asc' : 'desc'; }
        this.refresh(this.currentPath);
    },

    sortLabel: function(key, label) {
        return label + (this.sortBy === key ? (this.sortDir === 'asc' ? ' ↑' : ' ↓') : '');
    },

    confirmAction: function(opts) {
        opts = opts || {};
        return new Promise(resolve => {
            const overlay = E('div', { class: 'qf-overlay' });
            const close = value => {
                overlay.remove();
                document.removeEventListener('keydown', onKey);
                resolve(!!value);
            };
            const onKey = ev => {
                if (ev.key === 'Escape') close(false);
                if (ev.key === 'Enter') close(true);
            };
            const danger = opts.type === 'danger';
            const dialog = E('div', { class: 'qf-dialog qf-confirm-dialog' }, [
                E('div', { class: 'qf-dialog-header' }, [
                    E('span', { class: 'qf-dialog-title' }, opts.title || '确认操作'),
                    E('a', { class: 'qf-dialog-close', click: () => close(false) }, '×')
                ]),
                E('div', { class: 'qf-dialog-body' }, [
                    E('div', { class: 'qf-confirm-content' }, [
                        E('span', { class: 'qf-confirm-icon' + (danger ? ' danger' : '') }, danger ? '!' : 'i'),
                        E('div', { class: 'qf-confirm-main' }, [
                            E('div', { class: 'qf-confirm-message' }, opts.message || '确定继续操作吗？'),
                            opts.target ? E('div', { class: 'qf-confirm-target' }, opts.target) : E('span', {})
                        ])
                    ])
                ]),
                E('div', { class: 'qf-dialog-footer' }, [
                    E('button', { class: 'qf-confirm-cancel', click: () => close(false) }, opts.cancelText || '取消'),
                    E('button', { class: 'qf-confirm-ok' + (danger ? ' danger' : ''), click: () => close(true) }, opts.okText || '确定')
                ])
            ]);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            setTimeout(() => document.addEventListener('keydown', onKey), 0);
        });
    },

    inputDialog: function(opts) {
        opts = opts || {};
        return new Promise(resolve => {
            const overlay = E('div', { class: 'qf-overlay' });
            const input = E('input', { class: 'qf-form-input', value: opts.value || '', placeholder: opts.placeholder || '', input: () => { err.textContent = ''; } });
            const err = E('div', { class: 'qf-form-error' }, '');
            const close = value => {
                overlay.remove();
                document.removeEventListener('keydown', onKey);
                resolve(value);
            };
            const submit = () => {
                const value = String(input.value || '').trim();
                if (typeof opts.validate === 'function') {
                    const msg = opts.validate(value);
                    if (msg) {
                        err.textContent = msg;
                        input.focus();
                        return;
                    }
                }
                close(value);
            };
            const onKey = ev => {
                if (ev.key === 'Escape') close(null);
                if (ev.key === 'Enter') submit();
            };
            const dialog = E('div', { class: 'qf-dialog qf-confirm-dialog' }, [
                E('div', { class: 'qf-dialog-header' }, [
                    E('span', { class: 'qf-dialog-title' }, opts.title || '输入'),
                    E('a', { class: 'qf-dialog-close', click: () => close(null) }, '×')
                ]),
                E('div', { class: 'qf-dialog-body' }, [
                    E('div', { class: 'qf-confirm-content' }, [
                        E('span', { class: 'qf-confirm-icon' }, opts.icon || 'i'),
                        E('div', { class: 'qf-confirm-main' }, [
                            E('div', { class: 'qf-confirm-message' }, opts.message || ''),
                            opts.target ? E('div', { class: 'qf-confirm-target' }, opts.target) : E('span', {}),
                            E('div', { class: 'qf-form-row' }, [
                                opts.label ? E('div', { class: 'qf-form-label' }, opts.label) : E('span', {}),
                                input,
                                opts.help ? E('div', { class: 'qf-form-help' }, opts.help) : E('span', {}),
                                err
                            ])
                        ])
                    ])
                ]),
                E('div', { class: 'qf-dialog-footer' }, [
                    E('button', { class: 'qf-confirm-cancel', click: () => close(null) }, opts.cancelText || '取消'),
                    E('button', { class: 'qf-confirm-ok', click: submit }, opts.okText || '确定')
                ])
            ]);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            setTimeout(() => { document.addEventListener('keydown', onKey); input.focus(); input.select(); }, 0);
        });
    },

    showProgressDialog: function(title) {
        const overlay = E('div', { class: 'qf-overlay' });
        const fill = E('div', { class: 'qf-progress-fill' });
        const text = E('div', { class: 'qf-progress-text' }, '准备中...');
        const cancelBtn = E('button', { class: 'qf-btn', style: 'display:none;margin-top:12px;' }, '取消任务');
        const box = E('div', { class: 'qf-progress-box' }, [
            E('div', { class: 'qf-progress-title' }, title),
            E('div', { class: 'qf-progress-bar' }, [fill]),
            text,
            E('div', { style: 'text-align:right;' }, [cancelBtn])
        ]);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        return {
            set: (pct, msg) => {
                if (pct >= 0) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
                if (msg) text.textContent = msg;
            },
            setCancel: fn => {
                cancelBtn.style.display = '';
                cancelBtn.onclick = ev => { ev.preventDefault(); if (fn) fn(); };
            },
            close: () => overlay.remove()
        };
    },

    monitorTask: function(taskId, title, doneRefreshPath) {
        const progress = this.showProgressDialog(title || '后台任务');
        let closed = false;
        progress.setCancel(() => {
            apiFetch('task_cancel', { method: 'POST', body: formData({ id: taskId }) }).then(() => {
                progress.set(-1, '已请求取消任务...');
            }).catch(notifyError);
        });
        return new Promise((resolve, reject) => {
            const poll = () => {
                if (closed) return;
                apiFetch('task', {}, { id: taskId }).then(tres => {
                    const t = tres.data || {};
                    const pct = Number(t.progress || 0);
                    let msg = t.message || '正在处理';
                    if (t.total > 0) msg += ` (${this.formatSize(t.current || 0)} / ${this.formatSize(t.total || 0)})`;
                    else if (t.current > 0) msg += ` (${this.formatSize(t.current || 0)})`;
                    progress.set(pct, msg);
                    if (t.status === 'done') {
                        progress.set(100, t.message || '任务完成');
                        setTimeout(() => { closed = true; progress.close(); resolve(t); }, 500);
                    } else if (t.status === 'error') {
                        closed = true; progress.close(); reject(new Error(t.error || '任务失败'));
                    } else if (t.status === 'cancelled') {
                        closed = true; progress.close(); reject(new Error('任务已取消'));
                    } else {
                        setTimeout(poll, 1500);
                    }
                }).catch(err => { closed = true; progress.close(); reject(err); });
            };
            poll();
        }).then(t => {
            this.refresh(doneRefreshPath || this.currentPath);
            return t;
        }).catch(err => { notifyError(err); throw err; });
    },

    startTaskAction: function(action, body, title, refreshPath) {
        return apiFetch(action, { method: 'POST', body: body }).then(res => {
            const id = res.data && res.data.id;
            if (!id) throw new Error('任务创建失败');
            return this.monitorTask(id, title || '后台任务', refreshPath);
        });
    },

    startBackgroundTaskAction: function(action, body, refreshPath) {
        return apiFetch(action, { method: 'POST', body: body }).then(res => {
            const id = res.data && res.data.id;
            if (!id) throw new Error('任务创建失败');
            // 真正后台任务：不弹遮罩、不阻塞文件管理页面。进度在右上角“任务”里查看。
            if (refreshPath) {
                setTimeout(() => this.refresh(refreshPath), 300);
            }
            return id;
        });
    },

    updateSelectionUI: function() {
        this.updateToolbarState();
    },

    updateToolbarState: function() {
        // 顶部工具栏不再通过 disabled 变灰；需要选择时由按钮点击后的提示处理。
        Object.values(this.toolbarRefs || {}).forEach(btn => {
            if (btn) btn.disabled = false;
        });
    },

    clearSelection: function() {
        this.selectedFiles.clear();
        document.querySelectorAll('.qf-item').forEach(el => el.classList.remove('selected'));
        document.querySelectorAll('.qf-checkbox').forEach(chk => { chk.checked = false; });
        this.updateSelectionUI();
    },

    clearContextTarget: function() {
        document.querySelectorAll('.qf-item.context-target').forEach(el => el.classList.remove('context-target'));
    },

    setContextTarget: function(item) {
        this.clearContextTarget();
        if (item) item.classList.add('context-target');
    },

    setClipboard: function(action) {
        if (this.selectedFiles.size === 0) {
            return ui.addNotification(null, E('p', {}, '请先选择要' + (action === 'copy' ? '复制' : '剪切') + '的文件或目录'), 'warning');
        }
        this.clipboard = { action: action, files: Array.from(this.selectedFiles) };
        this.clearSelection();
        this.refresh(this.currentPath);
    },

    makeToolbarButton: function(opts) {
        const cls = 'qf-btn' + (opts.primary ? ' qf-btn-primary' : '') + (opts.danger ? ' qf-btn-danger-text' : '');
        const attrs = {
            class: cls,
            click: ev => {
                ev.stopPropagation();
                if (btn.disabled) return;
                if (typeof opts.onClick === 'function') opts.onClick(ev);
            }
        };
        // 注意：HTML 里 disabled="false" 仍然会被浏览器当作禁用。
        // 所以只有真正需要禁用时才写入 disabled 属性，普通按钮不能带 disabled:false。
        if (opts.disabled) attrs.disabled = true;
        const btn = E('button', attrs, [E('span', { class: 'qf-btn-icon' }, opts.icon || ''), E('span', {}, opts.label || '')]);
        return btn;
    },

    getSingleSelectedPath: function() {
        return this.selectedFiles.size === 1 ? Array.from(this.selectedFiles)[0] : '';
    },

    getSingleSelectedName: function() {
        const p = this.getSingleSelectedPath();
        return p ? p.split('/').pop() : '';
    },

    showCompressToolbarMenu: function(ev) {
        if (this.selectedFiles.size !== 1) {
            return ui.addNotification(null, E('p', {}, '请先只选择一个文件或目录再压缩'), 'warning');
        }
        const path = this.getSingleSelectedPath();
        this.removeMenus();
        const menu = E('div', { class: 'qf-context-menu', style: `left:${ev.pageX}px;top:${ev.pageY + 8}px;` }, [
            E('div', { class: 'qf-menu-item', click: () => { this.compress(path, 'tar.gz'); menu.remove(); } }, '压缩为 .tar.gz'),
            E('div', { class: 'qf-menu-item', click: () => { this.compress(path, 'tar.xz'); menu.remove(); } }, '压缩为 .tar.xz'),
            E('div', { class: 'qf-menu-item', click: () => { this.compress(path, 'zip'); menu.remove(); } }, '压缩为 .zip')
        ]);
        this.showMenu(menu);
    },

    renderSettingsCard: function() {
        const enabled = E('select', {}, [E('option', { value: '1' }, '启用'), E('option', { value: '0' }, '禁用')]);
        const listenAddr = E('input', { type: 'text', value: '0.0.0.0' });
        const listenPort = E('input', { type: 'number', min: '1', max: '65535', value: '8989' });
        const terminal = E('select', {}, [E('option', { value: '1' }, '启用'), E('option', { value: '0' }, '禁用')]);
        const maxUpload = E('input', { type: 'number', min: '0', value: '0' });
        const maxEdit = E('input', { type: 'number', min: '0', value: '0' });
        const diag = E('pre', { class: 'qf-diagnose-output' }, '');
        this.settingsRefs = { enabled, listenAddr, listenPort, terminal, maxUpload, maxEdit, diag };
        return E('div', { class: 'qf-settings-panel' }, [
            E('div', { class: 'qf-settings-note' }, '这些是服务级配置，保存并重启后新地址/端口才会完全生效。大小单位 MiB，0 表示不限制。'),
            E('div', { class: 'qf-settings-grid' }, [
                E('label', { class: 'qf-settings-field' }, [E('span', {}, '服务状态'), enabled]),
                E('label', { class: 'qf-settings-field' }, [E('span', {}, '终端功能'), terminal]),
                E('label', { class: 'qf-settings-field' }, [E('span', {}, '监听地址'), listenAddr]),
                E('label', { class: 'qf-settings-field' }, [E('span', {}, '监听端口'), listenPort]),
                E('label', { class: 'qf-settings-field' }, [E('span', {}, '最大上传'), maxUpload]),
                E('label', { class: 'qf-settings-field' }, [E('span', {}, '最大编辑'), maxEdit])
            ]),
            E('div', { class: 'qf-settings-actions' }, [
                E('button', { class: 'qf-btn', click: ev => { ev.stopPropagation(); this.loadSettings(); } }, '读取配置'),
                E('button', { class: 'qf-btn qf-btn-primary', click: ev => { ev.stopPropagation(); this.saveSettings(false); } }, '保存'),
                E('button', { class: 'qf-btn', click: ev => { ev.stopPropagation(); this.saveSettings(true); } }, '保存并重启'),
                E('button', { class: 'qf-btn', click: ev => { ev.stopPropagation(); this.showDiagnose(); } }, '诊断')
            ]),
            diag
        ]);
    },

    openSettingsDialog: function() {
        let closeFn;
        const overlay = E('div', { class: 'qf-overlay' });
        const dialog = E('div', { class: 'qf-dialog qf-settings-dialog' }, [
            E('div', { class: 'qf-dialog-header' }, [E('span', { class: 'qf-dialog-title' }, '设置 / 诊断'), E('span', { class: 'qf-dialog-close', click: () => closeFn() }, '×')]),
            E('div', { class: 'qf-dialog-body' }, [this.renderSettingsCard()])
        ]);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        closeFn = () => overlay.remove();
        this.loadSettings();
    },

    loadSettings: function() {
        return apiFetch('config_get', {}, {}).then(res => {
            const d = res.data || {};
            const r = this.settingsRefs || {};
            if (r.enabled) r.enabled.value = String(d.enabled || '1');
            if (r.listenAddr) r.listenAddr.value = String(d.listen_addr || '0.0.0.0');
            if (r.listenPort) r.listenPort.value = String(d.listen_port || '8989');
            if (r.terminal) r.terminal.value = String(d.enable_terminal || '1');
            if (r.maxUpload) r.maxUpload.value = String(d.max_upload_mb || '0');
            if (r.maxEdit) r.maxEdit.value = String(d.max_edit_mb || '0');
        }).catch(notifyError);
    },

    saveSettings: function(restart) {
        const r = this.settingsRefs || {};
        const port = r.listenPort ? String(r.listenPort.value || '8989') : '8989';
        if (restart && /^\d{1,5}$/.test(port)) localStorage.setItem('quickfileGoPort', port);
        const body = formData({
            enabled: r.enabled ? r.enabled.value : '1',
            listen_addr: r.listenAddr ? r.listenAddr.value : '0.0.0.0',
            listen_port: port,
            enable_terminal: r.terminal ? r.terminal.value : '1',
            max_upload_mb: r.maxUpload ? r.maxUpload.value : '0',
            max_edit_mb: r.maxEdit ? r.maxEdit.value : '0',
            restart: restart ? '1' : '0'
        });
        apiFetch('config_set', { method: 'POST', body }).then(res => {
            ui.addNotification(null, E('p', {}, String(res.data || '配置已保存')), 'info');
            if (restart) setTimeout(() => window.location.reload(), 1800);
        }).catch(notifyError);
    },

    showDiagnose: function() {
        apiFetch('diagnose', {}, {}).then(res => {
            const r = this.settingsRefs || {};
            if (r.diag) {
                r.diag.style.display = 'block';
                r.diag.textContent = JSON.stringify(res.data || {}, null, 2);
            }
        }).catch(notifyError);
    },

    render: function(files) {
        document.body.classList.toggle('qf-quickfile-light', this.theme === 'light');
        document.body.classList.toggle('qf-quickfile-dark', this.theme !== 'light');
        this.fileInput = E('input', { type: 'file', multiple: 'multiple', style: 'display:none', change: ev => this.uploadFiles(ev.target.files) });
        const btnRefresh = E('span', { click: () => this.refresh(this.currentPath) }, '↻ 刷新');
        const btnView = E('span', { click: () => { this.viewMode = this.viewMode === 'grid' ? 'list' : 'grid'; this.refresh(this.currentPath); } }, this.viewMode === 'grid' ? '☶ 列表' : '☷ 网格');
        const btnTheme = E('span', { click: () => { this.theme = this.theme === 'dark' ? 'light' : 'dark'; this.refresh(this.currentPath); } }, this.theme === 'light' ? '🌙 深色模式' : '☀ 浅色模式');
        const btnTasks = E('span', { click: () => this.showTaskCenter() }, '▣ 任务');
        const btnSettings = E('span', { click: () => this.openSettingsDialog() }, '⚙ 设置');

        const logoIcon = this.makeIcon(`<svg viewBox="0 0 1024 1024" width="22" height="22"><path d="M928 256H599.168L501.76 158.592A64 64 0 0 0 456.448 140.8H96a64 64 0 0 0-64 64v614.4a64 64 0 0 0 64 64h832a64 64 0 0 0 64-64V320a64 64 0 0 0-64-64z" fill="#409eff"/></svg>`);
        const header = E('div', { class: 'qf-header' }, [
            E('div', { class: 'qf-logo' }, [logoIcon, E('span', {}, 'Quick 文件管理')]),
            E('div', { class: 'qf-header-right' }, [btnRefresh, btnView, btnTasks, btnTheme, btnSettings])
        ]);

        const breadcrumb = E('div', { class: 'qf-breadcrumb' });
        breadcrumb.appendChild(E('span', { class: 'qf-bc-link', click: () => this.refresh('/') }, '🏠 根目录'));
        let curPath = '';
        this.currentPath.split('/').filter(Boolean).forEach(p => {
            curPath += '/' + p;
            const targetPath = curPath;
            breadcrumb.appendChild(E('span', { style: 'margin:0 5px;color:#c0c4cc;' }, '/'));
            breadcrumb.appendChild(E('span', { class: 'qf-bc-link', click: () => this.refresh(targetPath) }, p));
        });
        const breadcrumbCard = E('div', { class: 'qf-card' }, [breadcrumb]);

        const searchInput = E('input', { type: 'text', placeholder: '搜索文件...', input: ev => this.filterItems(ev.target.value) });
        const btnUpload = this.makeToolbarButton({ primary: true, icon: '☁', label: '上传文件', onClick: () => this.fileInput.click() });
        const btnNew = this.makeToolbarButton({ icon: '✚', label: '新建 ▾', onClick: ev => this.showNewMenu(ev) });
        const btnTerminal = this.makeToolbarButton({ icon: '〉_', label: '终端', onClick: () => this.openTerminal() });
        const btnCompress = this.makeToolbarButton({ icon: '🗜', label: '压缩', onClick: ev => this.showCompressToolbarMenu(ev) });
        const btnCopy = this.makeToolbarButton({ icon: '⧉', label: '复制', onClick: () => this.setClipboard('copy') });
        const btnCut = this.makeToolbarButton({ icon: '✂', label: '剪切', onClick: () => this.setClipboard('move') });
        const btnPaste = this.makeToolbarButton({ icon: '📋', label: '粘贴', onClick: () => this.paste() });
        const btnDownload = this.makeToolbarButton({ icon: '☁', label: '下载文件', onClick: () => this.remoteDownload() });
        const btnDelete = this.makeToolbarButton({ icon: '🗑', label: '批量删除', danger: true, onClick: () => this.deleteSelected() });
        this.toolbarRefs = { upload: btnUpload, newBtn: btnNew, terminal: btnTerminal, compress: btnCompress, copy: btnCopy, cut: btnCut, paste: btnPaste, download: btnDownload, deleteBtn: btnDelete };
        const toolbar = E('div', { class: 'qf-toolbar' }, [
            btnUpload, btnNew, btnTerminal, btnCompress, btnCopy, btnCut, btnPaste, btnDownload, btnDelete,
            E('div', { class: 'qf-search-box' }, [searchInput, E('span', { style: 'padding:0 10px;color:#c0c4cc;' }, '🔍')])
        ]);

        const grid = E('div', { class: 'qf-grid' + (this.viewMode === 'list' ? ' qf-list-view' : '') });
        if (this.viewMode === 'list') {
            grid.appendChild(E('div', { class: 'qf-list-header' }, [
                E('span', {}, ''),
                E('span', { 'data-sort': 'name', click: () => this.setSort('name') }, this.sortLabel('name', '名称')),
                E('span', { 'data-sort': 'size', click: () => this.setSort('size') }, this.sortLabel('size', '大小')),
                E('span', { 'data-sort': 'time', click: () => this.setSort('time') }, this.sortLabel('time', '修改时间')),
                E('span', { 'data-sort': 'mode', click: () => this.setSort('mode') }, this.sortLabel('mode', '权限'))
            ]));
        }
        if (this.currentPath !== '/') {
            const upPath = this.currentPath.split('/').slice(0, -1).join('/') || '/';
            grid.appendChild(E('div', { class: 'qf-item qf-parent-row', click: ev => { ev.stopPropagation(); this.refresh(upPath); } }, [
                E('div', { class: 'qf-item-icon' }, [this.makeIcon(this.icons.folder)]), E('div', { class: 'qf-item-name' }, '.. (返回上一级)'), E('div', { class: 'qf-item-meta' }, [E('span', { class: 'qf-col-size' }, '目录'), E('span', { class: 'qf-col-time' }, ''), E('span', { class: 'qf-col-mode' }, '')])
            ]));
        }

        if (!files || files.length === 0) {
            grid.appendChild(E('div', { class: 'qf-empty' }, '当前目录为空或无权限读取'));
        } else {
            this.sortFiles(files).forEach(f => this.appendFileItem(grid, f));
        }

        grid.addEventListener('contextmenu', ev => {
            if (ev.target.closest('.qf-item')) return;
            ev.preventDefault();
            this.showBlankContextMenu(ev);
        });

        const mainCard = E('div', { class: 'qf-card' }, [toolbar, grid]);
        const appWrapper = E('div', { class: 'qf-app' + (this.theme === 'light' ? ' qf-light' : '') }, [this.fileInput, header, breadcrumbCard, mainCard]);
        appWrapper.addEventListener('click', ev => {
            if (ev.target.closest('.qf-context-menu') || ev.target.closest('.qf-toolbar') || ev.target.closest('.qf-settings') || ev.target.closest('.qf-item')) return;
            this.clearContextTarget();
            this.clearSelection();
        });
        appWrapper.addEventListener('dragover', ev => { ev.preventDefault(); appWrapper.classList.add('drag-over'); });
        appWrapper.addEventListener('dragleave', ev => { ev.preventDefault(); appWrapper.classList.remove('drag-over'); });
        appWrapper.addEventListener('drop', ev => {
            ev.preventDefault();
            appWrapper.classList.remove('drag-over');
            if (ev.dataTransfer.files.length > 0) this.uploadFiles(ev.dataTransfer.files);
        });
        this.updateToolbarState();
        return appWrapper;
    },

    isImageFileName: function(name) {
        const lower = String(name || '').toLowerCase();
        return /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(lower);
    },

    getNormalizedExt: function(name) {
        const lower = String(name || '').toLowerCase();
        if (lower.endsWith('.tar.gz')) return 'tar.gz';
        if (lower.endsWith('.tar.xz')) return 'tar.xz';
        const idx = lower.lastIndexOf('.');
        return idx >= 0 ? lower.slice(idx + 1) : '';
    },

    getFileTypeInfo: function(name) {
        const ext = this.getNormalizedExt(name);
        const make = (category, label, accent, soft) => ({ category: category, label: label, accent: accent, soft: soft || accent });
        const direct = {
            apk: make('package', 'APK', '#f59e0b', '#fcd34d'),
            ipk: make('package', 'IPK', '#fb923c', '#fdba74'),
            txt: make('text', 'TXT', '#60a5fa', '#bfdbfe'),
            log: make('text', 'LOG', '#94a3b8', '#cbd5e1'),
            md: make('text', 'MD', '#22c55e', '#86efac'),
            json: make('config', 'JSON', '#10b981', '#6ee7b7'),
            xml: make('config', 'XML', '#14b8a6', '#99f6e4'),
            yml: make('config', 'YAML', '#22c55e', '#86efac'),
            yaml: make('config', 'YAML', '#22c55e', '#86efac'),
            ini: make('config', 'INI', '#84cc16', '#bef264'),
            cfg: make('config', 'CFG', '#84cc16', '#bef264'),
            conf: make('config', 'CONF', '#84cc16', '#bef264'),
            leases: make('config', 'LEASE', '#65a30d', '#a3e635'),
            sh: make('code', 'SH', '#a855f7', '#d8b4fe'),
            bash: make('code', 'SH', '#a855f7', '#d8b4fe'),
            zsh: make('code', 'SH', '#a855f7', '#d8b4fe'),
            js: make('code', 'JS', '#eab308', '#fde047'),
            ts: make('code', 'TS', '#3b82f6', '#93c5fd'),
            html: make('code', 'HTML', '#f97316', '#fdba74'),
            css: make('code', 'CSS', '#06b6d4', '#67e8f9'),
            go: make('code', 'GO', '#00add8', '#67e8f9'),
            c: make('code', 'C', '#6366f1', '#a5b4fc'),
            h: make('code', 'H', '#818cf8', '#c7d2fe'),
            cpp: make('code', 'C++', '#6366f1', '#a5b4fc'),
            hpp: make('code', 'H++', '#818cf8', '#c7d2fe'),
            py: make('code', 'PY', '#3776ab', '#93c5fd'),
            lua: make('code', 'LUA', '#2563eb', '#93c5fd'),
            java: make('code', 'JAVA', '#ea580c', '#fdba74'),
            php: make('code', 'PHP', '#7c3aed', '#c4b5fd'),
            rb: make('code', 'RB', '#dc2626', '#fca5a5'),
            rs: make('code', 'RS', '#f97316', '#fdba74'),
            zip: make('archive', 'ZIP', '#8b5cf6', '#c4b5fd'),
            tar: make('archive', 'TAR', '#8b5cf6', '#c4b5fd'),
            'tar.gz': make('archive', 'TGZ', '#8b5cf6', '#c4b5fd'),
            tgz: make('archive', 'TGZ', '#8b5cf6', '#c4b5fd'),
            'tar.xz': make('archive', 'TXZ', '#8b5cf6', '#c4b5fd'),
            txz: make('archive', 'TXZ', '#8b5cf6', '#c4b5fd'),
            gz: make('archive', 'GZ', '#8b5cf6', '#c4b5fd'),
            xz: make('archive', 'XZ', '#8b5cf6', '#c4b5fd'),
            '7z': make('archive', '7Z', '#8b5cf6', '#c4b5fd'),
            rar: make('archive', 'RAR', '#8b5cf6', '#c4b5fd'),
            pdf: make('doc', 'PDF', '#ef4444', '#fca5a5'),
            doc: make('doc', 'DOC', '#2563eb', '#93c5fd'),
            docx: make('doc', 'DOCX', '#2563eb', '#93c5fd'),
            xls: make('doc', 'XLS', '#16a34a', '#86efac'),
            xlsx: make('doc', 'XLSX', '#16a34a', '#86efac'),
            csv: make('text', 'CSV', '#16a34a', '#86efac'),
            ppt: make('doc', 'PPT', '#ea580c', '#fdba74'),
            pptx: make('doc', 'PPTX', '#ea580c', '#fdba74'),
            mp3: make('media-audio', 'AUDIO', '#ec4899', '#f9a8d4'),
            wav: make('media-audio', 'AUDIO', '#ec4899', '#f9a8d4'),
            flac: make('media-audio', 'AUDIO', '#ec4899', '#f9a8d4'),
            aac: make('media-audio', 'AUDIO', '#ec4899', '#f9a8d4'),
            m4a: make('media-audio', 'AUDIO', '#ec4899', '#f9a8d4'),
            mp4: make('media-video', 'VIDEO', '#f43f5e', '#fda4af'),
            webm: make('media-video', 'VIDEO', '#f43f5e', '#fda4af'),
            ogg: make('media-video', 'VIDEO', '#f43f5e', '#fda4af'),
            mov: make('media-video', 'VIDEO', '#f43f5e', '#fda4af')
        };
        if (direct[ext]) return direct[ext];
        if (!ext) return make('generic', 'FILE', '#94a3b8', '#cbd5e1');
        if (ext.length <= 5) return make('generic', ext.toUpperCase(), '#94a3b8', '#cbd5e1');
        return make('generic', 'FILE', '#94a3b8', '#cbd5e1');
    },

    makeTypedFileSVG: function(info) {
        const label = String((info && info.label) || 'FILE').replace(/[^A-Za-z0-9+]/g, '').slice(0, 5).toUpperCase() || 'FILE';
        const accent = String((info && info.accent) || '#94a3b8');
        const soft = String((info && info.soft) || accent);
        const category = String((info && info.category) || 'generic');

        if (category === 'package') {
            return [
                '<svg viewBox="0 0 64 72" width="56" height="56" aria-hidden="true">',
                '<path d="M14 26l18-9 18 9-18 9-18-9z" fill="', soft, '"/>',
                '<path d="M14 26v18l18 9V35z" fill="', accent, '" opacity="0.96"/>',
                '<path d="M50 26v18l-18 9V35z" fill="#d48b00" opacity="0.92"/>',
                '<path d="M23 21l18 9" stroke="#fff7d6" stroke-width="2" stroke-linecap="round" opacity="0.7"/>',
                '<path d="M32 17v18" stroke="#fff7d6" stroke-width="1.8" opacity="0.5"/>',
                '<rect x="12" y="56" width="40" height="10" rx="5" fill="', accent, '"/>',
                '<text x="32" y="63" fill="#ffffff" font-size="9.8" font-weight="700" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">', label, '</text>',
                '</svg>'
            ].join('');
        }

        if (category === 'archive') {
            return [
                '<svg viewBox="0 0 64 72" width="56" height="56" aria-hidden="true">',
                '<rect x="17" y="18" width="30" height="30" rx="6" fill="#f5f3ff" stroke="', accent, '" stroke-width="2.2"/>',
                '<rect x="29" y="16" width="6" height="34" rx="2.5" fill="', accent, '"/>',
                '<rect x="30.2" y="20" width="3.6" height="3.6" rx="1" fill="#ffffff"/>',
                '<rect x="30.2" y="26" width="3.6" height="3.6" rx="1" fill="#ffffff"/>',
                '<rect x="30.2" y="32" width="3.6" height="3.6" rx="1" fill="#ffffff"/>',
                '<rect x="30.2" y="38" width="3.6" height="3.6" rx="1" fill="#ffffff"/>',
                '<rect x="12" y="56" width="40" height="10" rx="5" fill="', accent, '"/>',
                '<text x="32" y="63" fill="#ffffff" font-size="9.8" font-weight="700" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">', label, '</text>',
                '</svg>'
            ].join('');
        }

        if (category === 'config') {
            return [
                '<svg viewBox="0 0 64 72" width="56" height="56" aria-hidden="true">',
                '<circle cx="32" cy="31" r="18" fill="#f0fdf4" stroke="', accent, '" stroke-width="2.2"/>',
                '<path d="M20 24h24" stroke="', accent, '" stroke-width="3" stroke-linecap="round"/>',
                '<circle cx="28" cy="24" r="4" fill="', accent, '"/>',
                '<path d="M20 31h24" stroke="', accent, '" stroke-width="3" stroke-linecap="round" opacity="0.85"/>',
                '<circle cx="37" cy="31" r="4" fill="', accent, '" opacity="0.95"/>',
                '<path d="M20 38h24" stroke="', accent, '" stroke-width="3" stroke-linecap="round" opacity="0.72"/>',
                '<circle cx="24" cy="38" r="4" fill="', accent, '" opacity="0.88"/>',
                '<rect x="12" y="56" width="40" height="10" rx="5" fill="', soft, '"/>',
                '<text x="32" y="63" fill="#14532d" font-size="9.2" font-weight="700" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">', label, '</text>',
                '</svg>'
            ].join('');
        }

        if (category === 'code') {
            return [
                '<svg viewBox="0 0 64 72" width="56" height="56" aria-hidden="true">',
                '<rect x="15" y="16" width="34" height="30" rx="6" fill="#0f172a" stroke="#1e293b" stroke-width="1.6"/>',
                '<rect x="15" y="16" width="34" height="7" rx="6" fill="', accent, '"/>',
                '<circle cx="21" cy="19.5" r="1.35" fill="#ffffff"/>',
                '<circle cx="25" cy="19.5" r="1.35" fill="#ffffff" opacity="0.82"/>',
                '<circle cx="29" cy="19.5" r="1.35" fill="#ffffff" opacity="0.64"/>',
                '<path d="M23 31l-5 4.2 5 4.2" stroke="', soft, '" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
                '<path d="M41 31l5 4.2-5 4.2" stroke="', soft, '" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
                '<path d="M35 29.5l-5 11.2" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round" opacity="0.9"/>',
                '<rect x="12" y="56" width="40" height="10" rx="5" fill="', accent, '"/>',
                '<text x="32" y="63" fill="#ffffff" font-size="9.8" font-weight="700" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">', label, '</text>',
                '</svg>'
            ].join('');
        }

        if (category === 'media-audio') {
            return [
                '<svg viewBox="0 0 64 72" width="56" height="56" aria-hidden="true">',
                '<circle cx="32" cy="31" r="18" fill="#fdf2f8" stroke="', accent, '" stroke-width="2.2"/>',
                '<path d="M28 23v15" stroke="', accent, '" stroke-width="3.2" stroke-linecap="round"/>',
                '<path d="M28 23l11-3v15" stroke="', accent, '" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
                '<circle cx="26" cy="42" r="4.6" fill="#ffffff" stroke="', accent, '" stroke-width="2.2"/>',
                '<circle cx="40" cy="39" r="4.6" fill="#ffffff" stroke="', accent, '" stroke-width="2.2"/>',
                '<rect x="12" y="56" width="40" height="10" rx="5" fill="', accent, '"/>',
                '<text x="32" y="63" fill="#ffffff" font-size="8.9" font-weight="700" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">AUDIO</text>',
                '</svg>'
            ].join('');
        }

        if (category === 'media-video') {
            return [
                '<svg viewBox="0 0 64 72" width="56" height="56" aria-hidden="true">',
                '<circle cx="32" cy="31" r="18" fill="#fff1f2" stroke="', accent, '" stroke-width="2.2"/>',
                '<circle cx="32" cy="31" r="10" fill="', soft, '" opacity="0.48"/>',
                '<path d="M28 24.5l12 6.5-12 6.5z" fill="', accent, '"/>',
                '<rect x="12" y="56" width="40" height="10" rx="5" fill="', accent, '"/>',
                '<text x="32" y="63" fill="#ffffff" font-size="8.9" font-weight="700" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">VIDEO</text>',
                '</svg>'
            ].join('');
        }

        if (category === 'doc') {
            return [
                '<svg viewBox="0 0 64 72" width="56" height="56" aria-hidden="true">',
                '<defs><linearGradient id="qfDocBg" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#eef2f7"/></linearGradient></defs>',
                '<path d="M16 4h22l14 14v46a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" fill="url(#qfDocBg)"/>',
                '<path d="M38 4v10a4 4 0 0 0 4 4h10" fill="#dde5ef"/>',
                '<path d="M38 4l14 14H42a4 4 0 0 1-4-4V4z" fill="#cfd8e3"/>',
                '<rect x="20" y="22" width="24" height="16" rx="3" fill="', soft, '" opacity="0.45"/>',
                '<rect x="23" y="26" width="18" height="2.8" rx="1.4" fill="', accent, '"/>',
                '<rect x="23" y="31" width="14" height="2.8" rx="1.4" fill="', accent, '" opacity="0.82"/>',
                '<path d="M45.5 42.5l-5 5" stroke="', accent, '" stroke-width="2.4" stroke-linecap="round"/>',
                '<circle cx="37.5" cy="36.5" r="6" fill="none" stroke="', accent, '" stroke-width="2.2"/>',
                '<rect x="12" y="56" width="40" height="10" rx="5" fill="', accent, '"/>',
                '<text x="32" y="63" fill="#ffffff" font-size="9.4" font-weight="700" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">', label, '</text>',
                '<rect x="12" y="4" width="40" height="64" rx="4" fill="none" stroke="#cbd5e1" stroke-width="1.2"/>',
                '</svg>'
            ].join('');
        }

        if (category === 'text') {
            return [
                '<svg viewBox="0 0 64 72" width="56" height="56" aria-hidden="true">',
                '<defs><linearGradient id="qfTextBg" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#eef2f7"/></linearGradient></defs>',
                '<path d="M16 4h22l14 14v46a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" fill="url(#qfTextBg)"/>',
                '<path d="M38 4v10a4 4 0 0 0 4 4h10" fill="#dde5ef"/>',
                '<path d="M38 4l14 14H42a4 4 0 0 1-4-4V4z" fill="#cfd8e3"/>',
                '<rect x="18" y="22" width="28" height="3.6" rx="1.8" fill="', accent, '"/>',
                '<rect x="18" y="29" width="24" height="3.6" rx="1.8" fill="', accent, '" opacity="0.82"/>',
                '<rect x="18" y="36" width="20" height="3.6" rx="1.8" fill="', accent, '" opacity="0.64"/>',
                '<rect x="12" y="56" width="40" height="10" rx="5" fill="', soft, '"/>',
                '<text x="32" y="63" fill="#1e3a8a" font-size="9.8" font-weight="700" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">', label, '</text>',
                '<rect x="12" y="4" width="40" height="64" rx="4" fill="none" stroke="#cbd5e1" stroke-width="1.2"/>',
                '</svg>'
            ].join('');
        }

        return [
            '<svg viewBox="0 0 64 72" width="56" height="56" aria-hidden="true">',
            '<defs><linearGradient id="qfGenericBg" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#eef2f7"/></linearGradient></defs>',
            '<path d="M16 4h22l14 14v46a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" fill="url(#qfGenericBg)"/>',
            '<path d="M38 4v10a4 4 0 0 0 4 4h10" fill="#dde5ef"/>',
            '<path d="M38 4l14 14H42a4 4 0 0 1-4-4V4z" fill="#cfd8e3"/>',
            '<circle cx="32" cy="31" r="10" fill="', soft, '"/>',
            '<path d="M32 25v12M26 31h12" stroke="', accent, '" stroke-width="2.4" stroke-linecap="round"/>',
            '<rect x="12" y="56" width="40" height="10" rx="5" fill="', accent, '"/>',
            '<text x="32" y="63" fill="#ffffff" font-size="9.8" font-weight="700" text-anchor="middle" font-family="Arial, Helvetica, sans-serif">', label, '</text>',
            '<rect x="12" y="4" width="40" height="64" rx="4" fill="none" stroke="#cbd5e1" stroke-width="1.2"/>',
            '</svg>'
        ].join('');
    },

    makeFileIconNode: function(fPath, f) {
        if (f.isDir) return this.makeIcon(this.icons.folder);
        if (this.isImageFileName(f.name)) {
            const img = E('img', {
                class: 'qf-thumb' + (String(f.name || '').toLowerCase().endsWith('.svg') ? ' qf-thumb-svg' : ''),
                src: downloadUrl(fPath),
                loading: 'lazy',
                decoding: 'async',
                alt: f.name || '',
                error: ev => {
                    const parent = ev.target && ev.target.parentNode;
                    if (parent) {
                        parent.textContent = '';
                        parent.appendChild(this.makeIcon(this.makeTypedFileSVG(this.getFileTypeInfo(f.name))));
                    }
                }
            });
            return img;
        }
        return this.makeIcon(this.makeTypedFileSVG(this.getFileTypeInfo(f.name)));
    },

    appendFileItem: function(grid, f) {
        const fPath = this.currentPath === '/' ? '/' + f.name : this.currentPath + '/' + f.name;
        let item;
        const chk = E('input', { type: 'checkbox', class: 'qf-checkbox', click: ev => {
            ev.stopPropagation();
            if (ev.target.checked) this.selectedFiles.add(fPath);
            else this.selectedFiles.delete(fPath);
            item.className = 'qf-item' + (this.selectedFiles.has(fPath) ? ' selected' : '');
            this.updateSelectionUI();
        }});
        item = E('div', { class: 'qf-item' }, [
            chk,
            E('div', { class: 'qf-item-icon' }, [this.makeFileIconNode(fPath, f)]),
            E('div', { class: 'qf-item-name' }, f.name),
            E('div', { class: 'qf-item-meta' }, [
                E('span', { class: 'qf-col-size' }, f.isDir ? '目录' : this.formatSize(f.size || 0)),
                E('span', { class: 'qf-col-time' }, this.formatTime(f.time)),
                E('span', { class: 'qf-col-mode' }, f.mode || '')
            ])
        ]);
        item.addEventListener('click', ev => {
            ev.stopPropagation();
            this.clearContextTarget();
            if (f.isDir) this.refresh(fPath);
            else this.smartOpenFile(fPath, f.name);
        });
        item.addEventListener('contextmenu', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            this.setContextTarget(item);
            this.showContextMenu(ev, fPath, f.name, f.isDir);
        });
        grid.appendChild(item);
    },

    filterItems: function(keyword) {
        const kw = String(keyword || '').toLowerCase();
        document.querySelectorAll('.qf-grid .qf-item').forEach(item => {
            const name = item.querySelector('.qf-item-name');
            if (name && !name.innerText.includes('返回上一级')) {
                item.style.display = name.innerText.toLowerCase().includes(kw) ? '' : 'none';
            }
        });
    },

    showNewMenu: function(ev) {
        this.removeMenus();
        const menu = E('div', { class: 'qf-context-menu', style: `left:${ev.pageX}px;top:${ev.pageY + 10}px;` }, [
            E('div', { class: 'qf-menu-item', click: () => { this.createNew(true); menu.remove(); } }, '新建文件夹'),
            E('div', { class: 'qf-menu-item', click: () => { this.createNew(false); menu.remove(); } }, '新建文件')
        ]);
        this.showMenu(menu);
    },

    showContextMenu: function(ev, path, name, isDir) {
        this.removeMenus();
        const ext = this.getNormalizedExt(name);
        const lowerName = name.toLowerCase();
        const isArch = ['zip', 'gz', 'tgz', 'tar', 'txz', 'tar.gz', 'tar.xz', 'xz', '7z', 'rar'].includes(ext) || lowerName.endsWith('.tar.gz') || lowerName.endsWith('.tar.xz');
        const menu = E('div', { class: 'qf-context-menu', style: `left:${ev.pageX}px;top:${ev.pageY}px;` }, [
            E('div', { class: 'qf-menu-item', click: () => { this.createNew(true); menu.remove(); } }, '新建文件夹'),
            E('div', { class: 'qf-menu-item', click: () => { this.createNew(false); menu.remove(); } }, '新建文件'),
            E('div', { class: 'qf-menu-separator' }),
            E('div', { class: 'qf-menu-item' + (isDir ? ' disabled' : ''), click: () => { if (!isDir) this.openEditor(path); else ui.addNotification(null, E('p', {}, '目录不能编辑'), 'warning'); menu.remove(); } }, '编辑'),
            E('div', { class: 'qf-menu-item', click: () => { this.renameItem(path, name); menu.remove(); } }, '重命名'),
            E('div', { class: 'qf-menu-separator' }),
            E('div', { class: 'qf-menu-item', click: () => { this.clipboard = { action: 'copy', files: [path] }; this.updateToolbarState(); menu.remove(); } }, '复制'),
            E('div', { class: 'qf-menu-item', click: () => { this.clipboard = { action: 'move', files: [path] }; this.updateToolbarState(); menu.remove(); } }, '剪切'),
            E('div', { class: 'qf-menu-item', click: () => { this.paste(); menu.remove(); } }, '粘贴'),
            E('div', { class: 'qf-menu-separator' }),
            E('div', { class: 'qf-menu-item' + (isDir ? ' disabled' : ''), click: () => { if (!isDir) window.open(downloadUrl(path), '_blank'); menu.remove(); } }, '下载'),
            E('div', { class: 'qf-menu-item', style: 'color:#f56c6c;', click: () => { this.deleteOne(path); menu.remove(); } }, '删除'),
            E('div', { class: 'qf-menu-separator' }),
            E('div', { class: 'qf-menu-item', click: () => { this.showFileProperties(path); menu.remove(); } }, '查看属性'),
            E('div', { class: 'qf-menu-item', click: () => { this.copyPath(path); menu.remove(); } }, '复制路径'),
            E('div', { class: 'qf-menu-item', click: () => { this.changeMode(path); menu.remove(); } }, '修改权限'),
            E('div', { class: 'qf-menu-separator' }),
            E('div', { class: 'qf-menu-item', click: () => { this.compress(path, 'tar.gz'); menu.remove(); } }, '压缩 (.tar.gz)'),
            E('div', { class: 'qf-menu-item', click: () => { this.compress(path, 'tar.xz'); menu.remove(); } }, '压缩 (.tar.xz)'),
            E('div', { class: 'qf-menu-item', click: () => { this.compress(path, 'zip'); menu.remove(); } }, '压缩 (.zip)'),
            E('div', { class: 'qf-menu-item' + (isArch ? '' : ' disabled'), click: () => { if (isArch) this.extract(path); else ui.addNotification(null, E('p', {}, '请选择压缩包'), 'warning'); menu.remove(); } }, '解压')
        ]);
        this.showMenu(menu);
    },

    showBlankContextMenu: function(ev) {
        this.removeMenus();
        const menu = E('div', { class: 'qf-context-menu', style: `left:${ev.pageX}px;top:${ev.pageY}px;` }, [
            E('div', { class: 'qf-menu-item', click: () => { this.refresh(this.currentPath); menu.remove(); } }, '刷新'),
            E('div', { class: 'qf-menu-separator' }),
            E('div', { class: 'qf-menu-item', click: () => { this.fileInput.click(); menu.remove(); } }, '上传文件'),
            E('div', { class: 'qf-menu-item', click: () => { this.remoteDownload(); menu.remove(); } }, '在线下载'),
            E('div', { class: 'qf-menu-item', click: () => { this.createNew(true); menu.remove(); } }, '新建文件夹'),
            E('div', { class: 'qf-menu-item', click: () => { this.createNew(false); menu.remove(); } }, '新建文件'),
            E('div', { class: 'qf-menu-item', click: () => { this.paste(); menu.remove(); } }, '粘贴' + (this.clipboard ? ` (${this.clipboard.files.length}项)` : '')),
            E('div', { class: 'qf-menu-separator' }),
            E('div', { class: 'qf-menu-item', click: () => { this.openTerminal(); menu.remove(); } }, '终端')
        ]);
        this.showMenu(menu);
    },

    showMenu: function(menu) {
        document.body.appendChild(menu);
        const closeMenu = () => {
            if (menu) menu.remove();
            this.clearContextTarget();
            document.removeEventListener('click', closeMenu);
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 10);
    },

    removeMenus: function() {
        document.querySelectorAll('.qf-context-menu').forEach(el => el.remove());
    },

    smartOpenFile: function(path, name) {
        const lower = name.toLowerCase();
        const ext = this.getNormalizedExt(name);
        const imgs = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'];
        const vids = ['mp4', 'webm', 'ogg', 'mov'];
        const pkgs = ['apk', 'ipk'];
        const archs = ['zip', 'gz', 'tgz', 'tar', 'txz', 'tar.gz', 'tar.xz', 'xz', '7z', 'rar'];
        const txts = ['txt', 'text', 'conf', 'cfg', 'cnf', 'sh', 'bash', 'zsh', 'json', 'js', 'ts', 'html', 'css', 'go', 'c', 'cpp', 'h', 'hpp', 'yml', 'yaml', 'xml', 'ini', 'md', 'log', 'csv', 'list', 'leases'];
        if (imgs.includes(ext)) this.previewMedia(path, name, true);
        else if (vids.includes(ext)) this.previewMedia(path, name, false);
        else if (pkgs.includes(ext)) {
            this.confirmPackageInstall(path, name).then(ok => { if (ok) this.install(path); });
        }
        else if (archs.includes(ext) || lower.endsWith('.tar.gz') || lower.endsWith('.tar.xz')) {
            this.confirmAction({ title: '解压文件', message: '是否解压到当前目录？', target: name, okText: '解压' }).then(ok => { if (ok) this.extract(path); });
        }
        else if (txts.includes(ext) || !name.includes('.')) this.openEditor(path);
        else return;
    },

    previewMedia: function(path, name, isImg) {
        const url = downloadUrl(path);
        const content = isImg ? E('img', { src: url, style: 'max-width:100%;max-height:65vh;border-radius:4px;' }) : E('video', { src: url, controls: true, autoplay: true, style: 'max-width:100%;max-height:65vh;border-radius:4px;' });
        ui.showModal('预览: ' + name, [E('div', { style: 'text-align:center;' }, [content]), E('div', { class: 'right', style: 'margin-top:15px;' }, [E('button', { class: 'btn', click: ui.hideModal }, '关闭')])]);
    },

    createNew: function(isDir) {
        this.inputDialog({
            title: isDir ? '新建文件夹' : '新建文件',
            icon: '✚',
            message: isDir ? '请输入新文件夹名称' : '请输入新文件名称',
            label: '名称',
            help: '名称不能包含 / 或 \\，也不能是 . 或 ..',
            okText: '创建',
            validate: value => !value ? '名称不能为空' : (!validName(value) ? '名称不能包含 / 或 \\，也不能是 . 或 ..' : '')
        }).then(name => {
            if (!name) return;
            const path = this.currentPath === '/' ? '/' + name : this.currentPath + '/' + name;
            apiFetch('create', { method: 'POST', body: formData({ path: path, isDir: String(!!isDir) }) }).then(() => this.refresh(this.currentPath)).catch(notifyError);
        });
    },

    renameItem: function(path, oldName) {
        this.inputDialog({
            title: '重命名',
            icon: '✎',
            message: '请输入新的名称',
            target: oldName,
            label: '新名称',
            value: oldName,
            help: '名称不能包含 / 或 \\，也不能是 . 或 ..',
            okText: '保存',
            validate: value => !value ? '名称不能为空' : (!validName(value) ? '名称不能包含 / 或 \\，也不能是 . 或 ..' : '')
        }).then(newName => {
            if (!newName || newName === oldName) return;
            const dst = this.currentPath === '/' ? '/' + newName : this.currentPath + '/' + newName;
            apiFetch('rename', { method: 'POST', body: formData({ src: path, dst: dst }) }).then(() => this.refresh(this.currentPath)).catch(notifyError);
        });
    },

    paste: function() {
        if (!this.clipboard || !this.clipboard.files || this.clipboard.files.length === 0) {
            return ui.addNotification(null, E('p', {}, '剪贴板为空'), 'warning');
        }
        const action = this.clipboard.action;
        const files = Array.from(this.clipboard.files);
        Promise.all(files.map(src => {
            const name = src.split('/').pop();
            const dst = this.currentPath === '/' ? '/' + name : this.currentPath + '/' + name;
            return this.startBackgroundTaskAction(action, formData({ src: src, dst: dst }), this.currentPath);
        })).then(() => {
            if (action === 'move') this.clipboard = null;
            this.updateToolbarState();
            setTimeout(() => this.refresh(this.currentPath), 1200);
        }).catch(notifyError);
    },

    compress: function(path, format) {
        this.startBackgroundTaskAction('compress', formData({ path: path, format: format || 'tar.gz' }), this.currentPath).catch(notifyError);
    },


    copyPath: function(path) {
        const overlay = E('div', { class: 'qf-overlay' });
        const input = E('input', { class: 'qf-form-input qf-copy-path-value', readonly: 'readonly', value: path });
        const status = E('div', { class: 'qf-form-help' }, '点击“复制”可复制完整路径；也可以直接选中文本手动复制。');
        const close = () => overlay.remove();
        const doCopy = () => {
            const fallback = () => {
                try {
                    input.focus();
                    input.select();
                    document.execCommand('copy');
                    status.textContent = '路径已复制';
                } catch (e) {
                    status.textContent = '浏览器阻止自动复制，请手动选中复制。';
                }
            };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(path).then(() => { status.textContent = '路径已复制'; }).catch(fallback);
            } else {
                fallback();
            }
        };
        const dialog = E('div', { class: 'qf-dialog qf-confirm-dialog' }, [
            E('div', { class: 'qf-dialog-header' }, [
                E('span', { class: 'qf-dialog-title' }, '复制路径'),
                E('a', { class: 'qf-dialog-close', click: close }, '×')
            ]),
            E('div', { class: 'qf-dialog-body' }, [
                E('div', { class: 'qf-confirm-content' }, [
                    E('span', { class: 'qf-confirm-icon' }, '⧉'),
                    E('div', { class: 'qf-confirm-main' }, [
                        E('div', { class: 'qf-confirm-message' }, '文件路径'),
                        E('div', { class: 'qf-form-row' }, [input, status])
                    ])
                ])
            ]),
            E('div', { class: 'qf-dialog-footer' }, [
                E('button', { class: 'qf-confirm-cancel', click: close }, '关闭'),
                E('button', { class: 'qf-confirm-ok', click: doCopy }, '复制')
            ])
        ]);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        setTimeout(() => { input.focus(); input.select(); }, 0);
    },

    showFileProperties: function(path) {
        apiFetch('stat', {}, { path: path }).then(res => {
            const d = res.data || {};
            const rows = [
                ['名称', d.name || ''],
                ['路径', d.path || path],
                ['类型', d.type || (d.isDir ? 'directory' : 'file')],
                ['大小', this.formatSize(d.size || 0)],
                ['修改时间', d.mtime || this.formatTime(d.time)],
                ['权限', (d.mode || '') + (d.perm ? ' (' + d.perm + ')' : '')],
                ['所有者', [d.owner || '', d.group ? ':' + d.group : ''].join('')]
            ];
            const body = E('div', { class: 'qf-prop-grid' }, rows.flatMap(r => [
                E('div', { class: 'qf-prop-key' }, r[0]),
                E('div', { class: 'qf-prop-val' }, r[1] || '-')
            ]));
            const closeBtn = E('button', { class: 'qf-btn', click: ui.hideModal }, '关闭');
            ui.showModal('文件属性', [body, E('div', { class: 'right', style: 'padding: 0 18px 18px;' }, [closeBtn])]);
        }).catch(notifyError);
    },

    changeMode: function(path) {
        apiFetch('stat', {}, { path: path }).then(res => {
            const d = res.data || {};
            const oldMode = String(d.perm || '').replace(/^0+/, '') || '644';
            const overlay = E('div', { class: 'qf-overlay' });
            const input = E('input', { class: 'qf-form-input', value: oldMode, maxlength: '4', input: () => { err.textContent = ''; } });
            const err = E('div', { class: 'qf-form-error' }, '');
            const close = () => overlay.remove();
            const save = () => {
                const mode = String(input.value || '').trim();
                if (!/^[0-7]{3,4}$/.test(mode)) {
                    err.textContent = '权限格式错误，请输入 644、755 或 0755 这种八进制权限。';
                    input.focus();
                    return;
                }
                apiFetch('chmod', { method: 'POST', body: formData({ path: path, mode: mode }) }).then(() => {
                    close();
                    this.refresh(this.currentPath);
                }).catch(e => {
                    err.textContent = e.message || String(e);
                });
            };
            const dialog = E('div', { class: 'qf-dialog qf-confirm-dialog' }, [
                E('div', { class: 'qf-dialog-header' }, [
                    E('span', { class: 'qf-dialog-title' }, '修改权限'),
                    E('a', { class: 'qf-dialog-close', click: close }, '×')
                ]),
                E('div', { class: 'qf-dialog-body' }, [
                    E('div', { class: 'qf-confirm-content' }, [
                        E('span', { class: 'qf-confirm-icon' }, '⚙'),
                        E('div', { class: 'qf-confirm-main' }, [
                            E('div', { class: 'qf-confirm-message' }, d.name ? ('修改权限：' + d.name) : '修改权限'),
                            E('div', { class: 'qf-confirm-target' }, path),
                            E('div', { class: 'qf-form-row' }, [
                                E('div', { class: 'qf-form-label' }, '权限值'),
                                input,
                                E('div', { class: 'qf-form-help' }, '常用：644=普通文件，755=可执行文件/目录。'),
                                err
                            ])
                        ])
                    ])
                ]),
                E('div', { class: 'qf-dialog-footer' }, [
                    E('button', { class: 'qf-confirm-cancel', click: close }, '取消'),
                    E('button', { class: 'qf-confirm-ok', click: save }, '保存')
                ])
            ]);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            setTimeout(() => { input.focus(); input.select(); }, 0);
        }).catch(notifyError);
    },

    remoteDownload: function() {
        const overlay = E('div', { class: 'qf-overlay' });
        const urlInput = E('input', { class: 'qf-form-input', placeholder: 'https://example.com/file.bin', input: () => { err.textContent = ''; this.guessDownloadName(urlInput.value, nameInput); } });
        const nameInput = E('input', { class: 'qf-form-input', placeholder: '留空则自动识别文件名', input: () => { err.textContent = ''; nameInput.dataset.userEdited = '1'; } });
        const err = E('div', { class: 'qf-form-error' }, '');
        const close = () => {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
        };
        const startDownload = () => {
            const url = String(urlInput.value || '').trim();
            const name = String(nameInput.value || '').trim();
            if (!url) {
                err.textContent = '下载 URL 不能为空。';
                urlInput.focus();
                return;
            }
            if (!/^https?:\/\//i.test(url)) {
                err.textContent = '只支持 http:// 或 https:// URL。';
                urlInput.focus();
                return;
            }
            if (name && !validName(name)) {
                err.textContent = '文件名不能包含 / 或 \\，也不能是 . 或 ..。';
                nameInput.focus();
                return;
            }
            close();
            this.startBackgroundTaskAction('remote_download_start', formData({ url: url, path: this.currentPath, name: name }), this.currentPath)
                .then(() => this.showTaskCenter())
                .catch(notifyError);
        };
        const onKey = ev => {
            if (ev.key === 'Escape') close();
            if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) startDownload();
        };
        const dialog = E('div', { class: 'qf-dialog qf-confirm-dialog qf-download-dialog' }, [
            E('div', { class: 'qf-dialog-header' }, [
                E('span', { class: 'qf-dialog-title' }, '下载文件'),
                E('a', { class: 'qf-dialog-close', click: close }, '×')
            ]),
            E('div', { class: 'qf-dialog-body' }, [
                E('div', { class: 'qf-confirm-content' }, [
                    E('span', { class: 'qf-confirm-icon' }, '☁'),
                    E('div', { class: 'qf-confirm-main' }, [
                        E('div', { class: 'qf-confirm-message' }, '添加一个后台下载任务'),
                        E('div', { class: 'qf-download-path' }, '保存目录：' + this.currentPath),
                        E('div', { class: 'qf-download-grid' }, [
                            E('label', { class: 'qf-form-row' }, [
                                E('span', { class: 'qf-form-label' }, '下载 URL'),
                                urlInput
                            ]),
                            E('label', { class: 'qf-form-row' }, [
                                E('span', { class: 'qf-form-label' }, '保存文件名'),
                                nameInput,
                                E('span', { class: 'qf-form-help' }, '可留空，后端会根据 URL 或响应头自动识别文件名。')
                            ]),
                            E('div', { class: 'qf-download-tip' }, [
                                E('span', {}, 'i'),
                                E('div', {}, [
                                    E('strong', {}, '后台下载：'),
                                    E('span', {}, '开始后不会遮挡页面，可在右上角“任务”里查看进度或取消。')
                                ])
                            ]),
                            err
                        ])
                    ])
                ])
            ]),
            E('div', { class: 'qf-dialog-footer' }, [
                E('button', { class: 'qf-confirm-cancel', click: close }, '取消'),
                E('button', { class: 'qf-confirm-ok', click: startDownload }, '加入后台任务')
            ])
        ]);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        setTimeout(() => { document.addEventListener('keydown', onKey); urlInput.focus(); }, 0);
    },

    guessDownloadName: function(url, nameInput) {
        if (!nameInput || nameInput.dataset.userEdited === '1') return;
        const current = String(nameInput.value || '').trim();
        if (current) return;
        try {
            const u = new URL(String(url || '').trim());
            const last = decodeURIComponent((u.pathname.split('/').filter(Boolean).pop() || '').trim());
            if (last && validName(last)) nameInput.value = last;
        } catch (e) {}
    },

    showTaskCenter: function() {
        apiFetch('task_list', {}, {}).then(res => {
            const items = res.data || [];
            const body = E('div', { class: 'qf-task-list' });
            if (!items.length) {
                body.appendChild(E('div', { class: 'qf-empty' }, '暂无后台任务'));
            } else {
                items.forEach(t => {
                    const pct = Number(t.progress || 0);
                    const cancel = E('button', { class: 'qf-btn', click: () => {
                        apiFetch('task_cancel', { method: 'POST', body: formData({ id: t.id }) }).then(() => this.showTaskCenter()).catch(notifyError);
                    } }, '取消');
                    if (!t.cancelable || ['done','error','cancelled'].includes(t.status)) cancel.disabled = true;
                    body.appendChild(E('div', { class: 'qf-task-row' }, [
                        E('div', { class: 'qf-task-title' }, [E('span', {}, `${t.type || 'task'} · ${t.status || ''}`), cancel]),
                        E('div', { class: 'qf-progress-bar' }, [E('div', { class: 'qf-progress-fill', style: `width:${Math.max(0, Math.min(100, pct))}%;` })]),
                        E('div', { class: 'qf-task-meta' }, `${pct}%  ${t.message || ''}${t.error ? '\n错误：' + t.error : ''}${t.path ? '\n路径：' + t.path : ''}`)
                    ]));
                });
            }
            ui.showModal('后台任务', [body, E('div', { class: 'right', style: 'padding: 0 18px 18px;' }, [E('button', { class: 'qf-btn', click: ui.hideModal }, '关闭')])]);
        }).catch(notifyError);
    },

    extract: function(path) {
        this.startBackgroundTaskAction('extract', formData({ path: path }), this.currentPath).catch(notifyError);
    },

    uploadFiles: function(files) {
        if (!files || files.length === 0) return;
        const list = Array.from(files);
        const progress = this.showProgressDialog('上传文件');
        let idx = 0;
        const uploadNext = () => {
            if (idx >= list.length) {
                progress.set(100, '上传完成');
                setTimeout(() => { progress.close(); this.refresh(this.currentPath); }, 500);
                return;
            }
            const file = list[idx++];
            const fd = new FormData();
            fd.append('path', this.currentPath);
            fd.append('file', file);
            const xhr = new XMLHttpRequest();
            xhr.open('POST', apiUrl('upload', { path: this.currentPath }));
            xhr.withCredentials = true;
            const sid = luciSession();
            if (sid) xhr.setRequestHeader('X-LuCI-Session', sid);
            let lastProgressAt = 0;
            xhr.upload.onprogress = ev => {
                const now = Date.now();
                if (now - lastProgressAt < 180 && (!ev.lengthComputable || ev.loaded < ev.total)) return;
                lastProgressAt = now;
                const perFile = ev.lengthComputable ? (ev.loaded * 100 / ev.total) : 0;
                const totalPct = ((idx - 1) + perFile / 100) * 100 / list.length;
                const msg = `正在上传 ${file.name} (${idx}/${list.length})` + (ev.lengthComputable ? ` ${this.formatSize(ev.loaded)} / ${this.formatSize(ev.total)}` : '');
                progress.set(totalPct, msg);
            };
            xhr.onload = () => {
                let body = {};
                try { body = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
                if (xhr.status >= 200 && xhr.status < 300 && (!body.code || body.code < 400)) uploadNext();
                else {
                    progress.close();
                    notifyError(new Error(friendlyUploadError(xhr.status, body, '上传失败: HTTP ' + xhr.status)));
                }
            };
            xhr.onerror = () => { progress.close(); notifyError(new Error('上传失败：网络连接中断，请检查浏览器到路由器的连接')); };
            xhr.ontimeout = () => { progress.close(); notifyError(new Error('上传失败：连接超时，请确认目标目录磁盘速度和剩余空间')); };
            xhr.send(fd);
        };
        uploadNext();
    },

    deleteOne: function(path) {
        this.confirmAction({
            title: '删除确认',
            message: '确定删除这个文件/目录吗？此操作不可撤销。',
            target: path,
            okText: '删除',
            type: 'danger'
        }).then(ok => {
            if (!ok) return;
            apiFetch('delete', { method: 'POST', body: formData({ path: path }) }).then(() => this.refresh(this.currentPath)).catch(notifyError);
        });
    },

    deleteSelected: function() {
        if (this.selectedFiles.size === 0) {
            return ui.addNotification(null, E('p', {}, '请先选择要删除的文件或目录'), 'warning');
        }
        const files = Array.from(this.selectedFiles);
        this.confirmAction({
            title: '删除确认',
            message: `确定删除选中的 ${files.length} 个文件/目录吗？此操作不可撤销。`,
            target: files.slice(0, 3).join('\n') + (files.length > 3 ? `\n... 以及另外 ${files.length - 3} 项` : ''),
            okText: '删除',
            type: 'danger'
        }).then(ok => {
            if (!ok) return;
            Promise.all(files.map(path => apiFetch('delete', { method: 'POST', body: formData({ path: path }) })))
                .then(() => { this.clearSelection(); this.refresh(this.currentPath); })
                .catch(notifyError);
        });
    },

    packageNameFromPath: function(path) {
        const p = String(path || '');
        return p.split('/').filter(Boolean).pop() || p || '软件包';
    },

    confirmPackageInstall: function(path, name) {
        const fileName = name || this.packageNameFromPath(path);
        return this.confirmAction({
            title: '安装系统软件包',
            message: '将以 root 权限调用 apk/opkg 安装此软件包，可能修改系统软件包、依赖、配置文件或服务。请确认文件来源可信后再继续。',
            target: '文件名：' + fileName + '\n完整路径：' + path,
            okText: '确认安装',
            type: 'danger'
        });
    },

    copyText: function(text) {
        text = String(text || '');
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
        return new Promise((resolve, reject) => {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                const ok = document.execCommand('copy');
                ta.remove();
                ok ? resolve() : reject(new Error('复制失败'));
            } catch (e) {
                reject(e);
            }
        });
    },

    showInstallDialog: function(path) {
        const fileName = this.packageNameFromPath(path);
        const overlay = E('div', { class: 'qf-overlay' });
        const statusText = E('span', {}, '正在安装，等待后端返回安装日志...');
        const status = E('div', { class: 'qf-install-status' }, [E('span', { class: 'qf-install-dot' }), statusText]);
        const logBox = E('div', { class: 'qf-install-log' }, '准备安装...\n');
        const hint = E('div', { class: 'qf-install-actions-left' }, '安装期间请不要刷新页面；失败时会保留完整错误日志。');
        const copyBtn = E('button', { class: 'qf-btn' }, '复制日志');
        const closeBtn = E('button', { class: 'qf-btn', disabled: 'disabled' }, '关闭');
        const dialog = E('div', { class: 'qf-dialog qf-install-dialog' }, [
            E('div', { class: 'qf-dialog-header' }, [
                E('span', { class: 'qf-dialog-title', title: path }, '安装软件包 - ' + fileName),
                E('span', { class: 'qf-dialog-close', click: () => { if (!closeBtn.disabled) overlay.remove(); } }, '×')
            ]),
            E('div', { class: 'qf-dialog-body' }, [
                E('div', { class: 'qf-install-status-row' }, [status]),
                E('div', { class: 'qf-install-meta' }, [
                    E('div', { class: 'qf-install-meta-label' }, '文件名'),
                    E('div', { class: 'qf-install-meta-value' }, fileName),
                    E('div', { class: 'qf-install-meta-label' }, '完整路径'),
                    E('div', { class: 'qf-install-meta-value' }, path)
                ]),
                E('div', { class: 'qf-install-warning' }, '提示：这是 root 权限安装操作，会修改系统软件包/依赖，可能触发服务重启或配置变更。'),
                logBox
            ]),
            E('div', { class: 'qf-dialog-footer' }, [hint, copyBtn, closeBtn])
        ]);
        const appendLog = text => {
            logBox.textContent += String(text || '');
            logBox.scrollTop = logBox.scrollHeight;
        };
        const setStatus = (cls, text) => {
            status.className = 'qf-install-status' + (cls ? ' ' + cls : '');
            statusText.textContent = text;
            hint.textContent = text;
        };
        copyBtn.onclick = ev => {
            ev.preventDefault();
            this.copyText(logBox.textContent).then(() => {
                const old = copyBtn.textContent;
                copyBtn.textContent = '已复制';
                setTimeout(() => { copyBtn.textContent = old; }, 1200);
            }).catch(notifyError);
        };
        closeBtn.onclick = ev => { ev.preventDefault(); overlay.remove(); };
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        return {
            appendLog: appendLog,
            setStatus: setStatus,
            finish: (ok, text) => {
                setStatus(ok ? 'success' : 'fail', text || (ok ? '安装成功' : '安装失败'));
                closeBtn.disabled = false;
                closeBtn.removeAttribute('disabled');
            },
            setLog: text => { logBox.textContent = String(text || ''); logBox.scrollTop = logBox.scrollHeight; }
        };
    },

    install: function(path) {
        const dlg = this.showInstallDialog(path);
        const fd = formData({ path: path, stream: '1' });
        const sid = luciSession();
        const headers = sid ? { 'X-LuCI-Session': sid } : {};
        let raw = '';
        const finishFromLog = () => {
            let ok = false;
            let text = '安装失败';
            let visible = raw;
            const marker = visible.match(/\n?__QF_INSTALL_STATUS__:(OK|FAIL)\s*\n?$/);
            if (marker) {
                ok = marker[1] === 'OK';
                text = ok ? '安装成功' : '安装失败，已保留完整错误日志';
                visible = visible.replace(/\n?__QF_INSTALL_STATUS__:(OK|FAIL)\s*\n?$/, '');
            }
            dlg.setLog(visible || (ok ? '安装完成' : '安装失败'));
            dlg.finish(ok, text);
            if (ok) this.refresh(this.currentPath);
        };
        fetch(apiUrl('install'), { method: 'POST', body: fd, credentials: 'include', headers: headers }).then(async res => {
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error((body && (body.data || body.msg)) || res.statusText || '安装请求失败');
            }
            if (!res.body || !res.body.getReader) {
                const body = await res.text();
                raw += body;
                finishFromLog();
                return;
            }
            dlg.setLog('正在安装，实时等待后端返回安装日志...\n');
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                const text = decoder.decode(part.value, { stream: true });
                raw += text;
                dlg.appendLog(text);
            }
            const tail = decoder.decode();
            if (tail) { raw += tail; dlg.appendLog(tail); }
            finishFromLog();
        }).catch(err => {
            raw += '\n[QuickFile-Go] 安装请求失败：' + String(err && err.message ? err.message : err) + '\n';
            dlg.setLog(raw);
            dlg.finish(false, '安装失败，已保留错误信息');
        });
    },

    openEditor: function(path) {
        ui.showModal('读取中...', [E('p', {}, '加载中...')]);
        apiFetch('read', {}, { path: path }).then(res => {
            ui.hideModal();
            let closeFn;
            let editor = null;
            const overlay = E('div', { class: 'qf-overlay' });
            const editorHost = E('div', { class: 'qf-editor-host' });
            const textarea = E('textarea', { class: 'qf-editor', spellcheck: 'false' }, res.data || '');
            const status = E('div', { class: 'qf-editor-status' }, '内置编辑器已启用；正在检测本地 Monaco...');
            editorHost.appendChild(textarea);
            const saveBtn = E('button', { class: 'qf-btn qf-btn-primary' }, '保存');
            const cancelBtn = E('button', { class: 'qf-btn', click: () => closeFn() }, '取消');
            const fullBtn = E('button', { class: 'qf-terminal-action' }, '全屏');
            const fileTitle = path.split('/').pop() || path;
            const dialog = E('div', { class: 'qf-dialog qf-editor-dialog' }, [
                E('div', { class: 'qf-dialog-header' }, [
                    E('span', { class: 'qf-dialog-title', title: path }, fileTitle),
                    E('span', { class: 'qf-terminal-actions' }, [fullBtn, E('span', { class: 'qf-dialog-close', click: () => closeFn() }, '×')])
                ]),
                E('div', { class: 'qf-dialog-body' }, [editorHost]),
                E('div', { class: 'qf-dialog-footer' }, [status, cancelBtn, saveBtn])
            ]);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const saveCode = () => {
                const content = editor ? editor.getValue() : textarea.value;
                saveBtn.disabled = true;
                saveBtn.innerText = '保存中...';
                apiFetch('write', { method: 'POST', body: formData({ path: path, content: content }) }).then(() => {
                    ui.addNotification(null, E('p', {}, '已保存'), 'info');
                    closeFn();
                    this.refresh(this.currentPath);
                }).catch(err => { saveBtn.disabled = false; saveBtn.innerText = '保存'; notifyError(err); });
            };
            saveBtn.addEventListener('click', saveCode);
            const layoutEditor = () => setTimeout(() => {
                try { if (editor && editor.layout) editor.layout(); } catch (_) {}
                if (editor && editor.focus) editor.focus();
                else textarea.focus();
            }, 80);
            fullBtn.addEventListener('click', ev => {
                ev.stopPropagation();
                dialog.classList.toggle('qf-editor-fullscreen');
                fullBtn.textContent = dialog.classList.contains('qf-editor-fullscreen') ? '退出全屏' : '全屏';
                layoutEditor();
            });
            const keyHandler = ev => {
                if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); saveCode(); }
                if (ev.key === 'Escape') { ev.preventDefault(); closeFn(); }
            };
            let closed = false;
            const resizeHandler = () => layoutEditor();
            closeFn = () => {
                closed = true;
                document.removeEventListener('keydown', keyHandler);
                window.removeEventListener('resize', resizeHandler);
                if (editor) editor.dispose();
                overlay.remove();
            };
            document.addEventListener('keydown', keyHandler);
            window.addEventListener('resize', resizeHandler);
            setTimeout(() => textarea.focus(), 50);

            promiseWithTimeout(loadMonacoEditor(), 5000, '本地 Monaco 不存在或加载超时').then(monaco => {
                if (closed) return;
                editorHost.innerHTML = '';
                editor = monaco.editor.create(editorHost, {
                    value: res.data || '',
                    language: detectEditorLanguage(path),
                    theme: this.theme === 'light' ? 'vs' : 'vs-dark',
                    automaticLayout: true,
                    minimap: { enabled: false },
                    fontSize: 13,
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                    renderWhitespace: 'selection',
                    tabSize: 4,
                    insertSpaces: false
                });
                if (monaco.KeyMod && monaco.KeyCode) {
                    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCode);
                }
                status.textContent = 'Monaco Editor 已启用：代码高亮 / 行号 / 搜索 / Ctrl+S 保存';
                setTimeout(() => editor.focus(), 50);
            }).catch(() => {
                if (closed) return;
                status.textContent = '已使用内置编辑器；本地 Monaco 未加载成功';
                setTimeout(() => textarea.focus(), 50);
            });
        }).catch(err => { ui.hideModal(); notifyError(err); });
    },

    openTerminal: function() {
        let closeFn;
        let ws = null;
        let term = null;
        const overlay = E('div', { class: 'qf-overlay' });
        const terminalHost = E('div', { class: 'qf-terminal-host' });
        const status = E('div', { class: 'qf-terminal-status' }, '正在加载本地 xterm.js...');
        const copyBtn = E('button', { class: 'qf-terminal-action' }, '复制');
        const pasteBtn = E('button', { class: 'qf-terminal-action' }, '粘贴');
        const clearBtn = E('button', { class: 'qf-terminal-action' }, '清屏');
        const fullBtn = E('button', { class: 'qf-terminal-action' }, '全屏');
        const dialog = E('div', { class: 'qf-dialog qf-terminal-dialog' }, [
            E('div', { class: 'qf-dialog-header' }, [
                E('span', { class: 'qf-dialog-title' }, '实时终端 - ' + this.currentPath),
                E('span', { class: 'qf-terminal-actions' }, [copyBtn, pasteBtn, clearBtn, fullBtn, E('span', { class: 'qf-dialog-close', click: () => closeFn() }, '×')])
            ]),
            E('div', { class: 'qf-dialog-body' }, [terminalHost, status])
        ]);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const writeClipboard = text => {
            if (!text) return Promise.resolve(false);
            if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
            return Promise.resolve(false);
        };
        const pasteClipboard = () => {
            if (!term) return;
            if (navigator.clipboard && navigator.clipboard.readText) {
                navigator.clipboard.readText().then(text => { if (text && ws && ws.readyState === WebSocket.OPEN) ws.send(text); term.focus(); }).catch(() => {
                    status.textContent = '浏览器禁止读取剪贴板，请用 Ctrl+V 或右键粘贴';
                });
            }
        };
        const fitTerm = () => {
            if (!term) return { cols: 100, rows: 30 };
            try { if (typeof term.fit === 'function') term.fit(); } catch (_) {}
            return { cols: term.cols || 100, rows: term.rows || 30 };
        };
        const syncTermSize = () => {
            const sz = fitTerm();
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(`__QF_RESIZE__:${sz.cols}:${sz.rows}`);
            return sz;
        };
        const toggleFullscreen = () => {
            dialog.classList.toggle('qf-terminal-fullscreen');
            const isFull = dialog.classList.contains('qf-terminal-fullscreen');
            fullBtn.textContent = isFull ? '退出全屏' : '全屏';
            setTimeout(() => { syncTermSize(); if (term) term.focus(); }, 80);
        };
        const connect = () => {
            const sz = fitTerm();
            ws = new WebSocket(terminalUrl(this.currentPath, sz.cols, sz.rows));
            ws.binaryType = 'arraybuffer';
            ws.onopen = () => { status.textContent = 'xterm.js 已连接 PTY WebSocket；可点“全屏”放大窗口，支持 top/vi/nano、复制粘贴、Ctrl+C、Ctrl+D'; fitTerm(); term.focus(); };
            ws.onmessage = ev => bytesToText(ev.data).then(text => term.write(text));
            ws.onerror = () => { status.textContent = '终端连接错误，请确认 quickfile-go-api 正在运行并且已登录 LuCI'; };
            ws.onclose = () => { status.textContent = '终端连接已关闭'; };
        };

        loadXtermLocal().then(Terminal => {
            term = new Terminal({
                cursorBlink: true,
                scrollback: 2000,
                fontSize: 14,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                theme: { background: '#000000', foreground: '#eeeeee', cursor: '#ffffff' }
            });
            term.open(terminalHost);
            if (typeof term.on === 'function') term.on('data', data => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(data); });
            else if (typeof term.onData === 'function') term.onData(data => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(data); });
            copyBtn.onclick = ev => {
                ev.stopPropagation();
                const text = (term.getSelection && term.getSelection()) || '';
                writeClipboard(text).then(ok => { status.textContent = ok ? '已复制终端选中文本' : '请先选中文本，再使用浏览器复制'; });
                term.focus();
            };
            pasteBtn.onclick = ev => { ev.stopPropagation(); pasteClipboard(); };
            clearBtn.onclick = ev => { ev.stopPropagation(); term.clear(); term.focus(); };
            fullBtn.onclick = ev => { ev.stopPropagation(); toggleFullscreen(); };
            terminalHost.addEventListener('paste', ev => {
                const text = (ev.clipboardData || window.clipboardData).getData('text');
                if (text && ws && ws.readyState === WebSocket.OPEN) { ev.preventDefault(); ws.send(text); }
            });
            connect();
        }).catch(err => {
            status.textContent = '本地 xterm.js 加载失败，已尝试重试：' + (err && err.message ? err.message : err);
            terminalHost.appendChild(E('pre', { class: 'qf-terminal-fallback' }, 'xterm.js 本地资源加载失败。请关闭终端窗口后重试，或清理 LuCI/浏览器缓存后再进入。'));
        });

        const resizeHandler = () => {
            if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
            syncTermSize();
        };
        window.addEventListener('resize', resizeHandler);
        const keyHandler = ev => { if (ev.key === 'Escape') { ev.preventDefault(); closeFn(); } };
        closeFn = () => {
            window.removeEventListener('resize', resizeHandler);
            document.removeEventListener('keydown', keyHandler);
            if (ws) ws.close();
            try { if (term && term.dispose) term.dispose(); } catch (_) {}
            overlay.remove();
        };
        document.addEventListener('keydown', keyHandler);
    },

    handleSaveApply: null,
    handleSave: null,
    handleReset: null
});
