'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const UI_DIRECTORY = path.join(__dirname, 'tv-app', 'dist', 'tizenbrew', 'debug-logs', 'ui', 'dist');
const UI_PATH = '/tizenbrew-ui/dist/index.html';
const DEFINITIONS = {
	prime: { folder: '', suffix: '' },
	hotstar: { folder: 'hotstar', suffix: '/hotstar' },
	google: { folder: 'google-test', suffix: '/google-test' },
};

function createLocalService() {
	const modules = new Map();
	let running = false;
	let generation = 0;
	let startedAt = 0;
	let activeModule = null;
	const debug = { tizenDebug: true, webDebug: true, rwiDebug: false };
	function identify(address) {
		const match = /^gh\/jatin82\/skipstreams(?:@[^/]+)?(?:\/(hotstar|google-test))?$/.exec(address || '');
		if (!match) throw new Error('Desktop preview supports only the local Prime, Hotstar and Google scripts; no remote package was installed');
		return match[1] === 'hotstar' ? 'hotstar' : match[1] === 'google-test' ? 'google' : 'prime';
	}
	function add(address) {
		const key = identify(address);
		const definition = DEFINITIONS[key];
		const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, definition.folder, 'package.json'), 'utf8'));
		modules.set(address, {
			fullName: address, name: address.slice(3), appName: pkg.appName + ' [local source]',
			version: pkg.version + ' working tree', description: 'REAL website with the LOCAL working-tree script. ' + pkg.description,
			appPath: pkg.websiteURL, keys: pkg.keys || [], packageType: 'mods', moduleType: 'gh', mainFile: pkg.main,
		});
	}
	for (const definition of Object.values(DEFINITIONS)) add('gh/jatin82/skipstreams@working-tree' + definition.suffix);
	function handle(request) {
		switch (request.operation) {
			case 'start':
				if (!running) { running = true; generation++; startedAt = Date.now(); }
				return { started: true };
			case 'health':
				return running ? { status: 200, body: {
					session: 'desktop-' + generation, pid: process.pid, uptime: Math.floor((Date.now() - startedAt) / 1000),
					time: new Date().toISOString(), loggingEnabled: false, entries: [], cursor: 0, dropped: 0,
					state: { desktopAdapter: true, module: activeModule || '', debug },
				} } : { networkError: true };
			case 'restart':
				if (!running) return { networkError: true };
				running = false;
				activeModule = null;
				return { status: 202, body: { session: 'desktop-' + generation, restarting: true } };
			case 'return':
				if (request.payload !== 'home') throw new Error('Invalid return request');
				activeModule = null;
				return { returned: true };
			case 'message': {
				if (!running) throw new Error('Local desktop service is stopped. Use Restart service.');
				const message = request.message;
				switch (message.type) {
					case -1: return [];
					case 1: return [{ type: 1, payload: debug }];
					case 2: return [{ type: 2, payload: false }];
					case 4: return [{ type: 4, payload: [...modules.values()] }];
					case 5:
						if (!modules.has(message.payload.fullName)) throw new Error('Module is not in the local catalog');
						activeModule = identify(message.payload.fullName);
						return [];
					case 7: return [{ type: 7, payload: [] }];
					case 10:
						if (message.payload.action === 'add') add(message.payload.module);
						else if (message.payload.action === 'remove') modules.delete(message.payload.module);
						else throw new Error('Auto-launch and native module services are not enabled in the desktop preview');
						return [];
					case 11: return [{ type: 11, payload: { ok: true, debug } }];
					default: throw new Error('This native Tizen operation is not supported by the desktop adapter');
				}
			}
			default: throw new Error('Unknown desktop-adapter operation');
		}
	}
	return { handle };
}

function installDesktopAdapter(settings) {
	if (window.top !== window) return;
	const ui = location.origin === settings.uiOrigin;
	const site = /(^|\.)(primevideo\.com|hotstar\.com|google\.com)$/.test(location.hostname);
	if (!ui && !site) return;
	window.addEventListener('keydown', event => {
		if (event.key === 'Escape') Object.defineProperty(event, 'keyCode', { value: 10009 });
	}, true);
	function badge() {
		if (ui) {
			const style = document.createElement('style');
			style.textContent = [
				'html,body{width:100%;overflow-x:hidden}',
				'#app>header,#app>header nav{height:64px!important}',
				'#app>header nav{box-sizing:border-box;padding:8px 12px!important}',
				'#app>header nav>div:first-child{flex:0 1 auto;min-width:0}',
				'#app>header img{height:44px!important;width:auto;max-width:40vw;object-fit:contain}',
				'#app>header nav>div:last-child{display:flex!important;flex:0 0 auto;justify-content:flex-end;gap:4px}',
				'#app>header button{width:40px;height:40px;min-width:40px;padding:8px!important}',
				'#app>header button svg{width:24px!important;height:24px!important}',
				'@media(max-width:1100px){#app>header nav>div:nth-child(2){display:none!important}}',
				'@media(max-width:600px){.tv-service-toolbar>strong{display:none}.tv-service-toolbar>*{margin-right:8px}',
				'.tv-service-toolbar button{font-size:14px;padding:5px 10px}.tv-service-toolbar>span{font-size:13px}',
				'.tv-service-toolbar>span+span{display:none}}',
			].join('\n');
			document.documentElement.appendChild(style);
		}
		const element = document.createElement('div');
		element.textContent = 'LOCAL DESKTOP PREVIEW | Esc = TV Back | no TV service';
		element.style.cssText = 'position:fixed;z-index:2147483647;padding:4px 8px;background:#ffe08a;color:#111;' +
			'font:12px/16px sans-serif;pointer-events:none;max-width:calc(100vw - 24px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
			(ui ? 'left:12px;top:68px;' : 'right:8px;top:8px;');
		document.documentElement.appendChild(element);
	}
	if (document.documentElement) badge();
	else document.addEventListener('DOMContentLoaded', badge, { once: true });
	if (!ui) {
		if (/^(www\.)?google\.com$/.test(location.hostname)) {
			window.addEventListener('keydown', event => {
				if (event.keyCode !== 10009 && event.key !== 'BrowserBack') return;
				event.preventDefault();
				event.stopImmediatePropagation();
				window.__tizenBrewReturnToHome('home').catch(error => console.error('[Local TizenBrew] Return failed:', error));
			}, true);
		}
		return;
	}

	const sockets = new Set();
	const rpc = request => window.__localBrewRpc(request);
	const NativeWebSocket = window.WebSocket;
	class LocalSocket extends EventTarget {
		constructor(address, protocols) {
			super();
			if (!/^ws:\/\/(localhost|127\.0\.0\.1):8081\/?$/.test(address)) return new NativeWebSocket(address, protocols);
			this.readyState = 0;
			sockets.add(this);
			rpc({ operation: 'health' }).then(result => {
				if (this.readyState !== 0) return;
				if (result.networkError) { this.emit('error'); this.close(); }
				else { this.readyState = 1; this.emit('open'); }
			}).catch(error => { console.error('[Local TizenBrew]', error); this.emit('error'); this.close(); });
		}
		emit(type, data) {
			const event = type === 'message' ? new MessageEvent(type, { data }) : new Event(type);
			if (this['on' + type]) this['on' + type](event);
			this.dispatchEvent(event);
		}
		send(data) {
			if (this.readyState !== 1) throw new Error('Local socket is not open');
			rpc({ operation: 'message', message: JSON.parse(data) }).then(messages => {
				if (this.readyState === 1) messages.forEach(message => this.emit('message', JSON.stringify(message)));
			}).catch(error => {
				if (this.readyState === 1) this.emit('message', JSON.stringify({ type: 8, payload: error.message }));
			});
		}
		close() {
			if (this.readyState === 3) return;
			this.readyState = 3;
			sockets.delete(this);
			this.emit('close');
		}
	}
	Object.assign(LocalSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
	window.WebSocket = LocalSocket;

	const NativeXHR = window.XMLHttpRequest;
	window.XMLHttpRequest = class extends EventTarget {
		constructor() { super(); this.headers = {}; this.timeout = 0; this.readyState = 0; }
		open(method, address) { this.method = method; this.address = address; this.readyState = 1; }
		setRequestHeader(name, value) { this.headers[name] = value; }
		emit(type) {
			const event = new Event(type);
			if (this['on' + type]) this['on' + type](event);
			this.dispatchEvent(event);
		}
		send(body) {
			const url = new URL(this.address, location.href);
			if (url.origin !== 'http://127.0.0.1:8081' || !url.pathname.startsWith('/__tv_debug/')) {
				this.native = new NativeXHR();
				this.native.open(this.method, this.address);
				this.native.timeout = this.timeout;
				Object.entries(this.headers).forEach(([name, value]) => this.native.setRequestHeader(name, value));
				for (const type of ['load', 'error', 'timeout']) this.native['on' + type] = () => {
					this.status = this.native.status;
					this.responseText = this.native.responseText;
					this.emit(type);
				};
				this.native.send(body);
				return;
			}
			const operation = url.pathname.endsWith('/live') && this.method === 'GET' ? 'health' :
				url.pathname.endsWith('/restart') && this.method === 'POST' ? 'restart' : null;
			const timer = setTimeout(() => { this.cancelled = true; this.emit('timeout'); }, this.timeout || 3000);
			const response = operation ? rpc({ operation }) : Promise.resolve({ status: 404, body: { error: 'Unsupported local diagnostic route' } });
			response.then(result => {
				clearTimeout(timer);
				if (this.cancelled) return;
				if (result.networkError) { this.emit('error'); return; }
				this.status = result.status;
				this.responseText = JSON.stringify(result.body);
				this.readyState = 4;
				this.emit('load');
				if (operation === 'restart') [...sockets].forEach(socket => socket.close());
			}).catch(error => { clearTimeout(timer); console.error('[Local TizenBrew]', error); this.emit('error'); });
		}
		abort() { this.cancelled = true; if (this.native) this.native.abort(); }
	};

	window.tizen = {
		tvinputdevice: { registerKey() {} },
		systeminfo: { getPropertyValue(name, success, failure) {
			if (name === 'LOCALE') success({ language: navigator.language.replace('-', '_') });
			else failure(new Error('Only locale lookup is available in the desktop adapter'));
		} },
		ApplicationControl: function (operation) { this.operation = operation; },
		application: {
			getCurrentApplication: () => ({
				appInfo: { packageId: 'xvvl3S1bvH' },
				getRequestedAppControl: () => ({ appControl: { data: [] } }),
				exit: () => window.__localBrewClose(),
			}),
			launchAppControl(control, id, success, failure) {
				if (control.operation !== 'http://tizen.org/appcontrol/operation/service' || id !== 'xvvl3S1bvH.StandaloneService') {
					failure(new Error('Desktop adapter cannot launch native Tizen applications'));
					return;
				}
				rpc({ operation: 'start' }).then(success, failure);
			},
		},
		websetting: { setUserAgentString() { throw new Error('Desktop preview uses the installed browser user agent'); } },
	};
	window.webapis = { network: { getIp: () => '127.0.0.1' } };
}

function createUiServer(directory = UI_DIRECTORY, privateToken = '') {
	return http.createServer((request, response) => {
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('X-Content-Type-Options', 'nosniff');
		response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
		response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
		if (request.method !== 'GET') { response.writeHead(405); response.end('GET only'); return; }
		let pathname;
		try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
		catch (error) { response.writeHead(400); response.end('Invalid URL'); return; }
		if (pathname === '/') { response.writeHead(302, { Location: UI_PATH }); response.end(); return; }
		if (!pathname.startsWith('/tizenbrew-ui/dist/')) { response.writeHead(404); response.end(); return; }
		if (pathname.endsWith('/$WEBAPIS/webapis/webapis.js')) {
			response.writeHead(200, { 'Content-Type': 'text/javascript' });
			response.end('// Device APIs are provided by the desktop adapter.');
			return;
		}
		const relative = pathname === UI_PATH || pathname.startsWith(UI_PATH + '/') ? 'index.html' :
			pathname.slice('/tizenbrew-ui/dist/'.length);
		if (relative.split(/[\\/]/).includes('..')) { response.writeHead(403); response.end(); return; }
		const target = path.resolve(directory, relative);
		if (!target.startsWith(path.resolve(directory) + path.sep)) { response.writeHead(403); response.end(); return; }
		fs.readFile(target, (error, contents) => {
			if (error) {
				if (error.code !== 'ENOENT') console.error('[Local TizenBrew] UI read failed:', error.message);
				response.writeHead(error.code === 'ENOENT' ? 404 : 500);
				response.end('UI resource unavailable');
				return;
			}
			const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
			const extension = path.extname(target);
			if (privateToken && ['.js', '.json', '.html', '.map'].includes(extension)) {
				const escaped = JSON.stringify(privateToken).slice(1, -1);
				let text = contents.toString('utf8');
				for (const value of [escaped, escaped.replace(/\\"/g, '"').replace(/'/g, "\\'"), privateToken]) {
					text = text.split(value).join('desktop-preview-token-not-valid-for-tv');
				}
				contents = Buffer.from(text, 'utf8');
			}
			response.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream' });
			response.end(contents);
		});
	});
}

function browserChannel() {
	if (process.env.LOCAL_BREW_BROWSER) {
		if (!['chrome', 'msedge'].includes(process.env.LOCAL_BREW_BROWSER)) throw new Error('LOCAL_BREW_BROWSER must be chrome or msedge');
		return process.env.LOCAL_BREW_BROWSER;
	}
	if (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ||
		fs.existsSync('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe')) return 'chrome';
	if (fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe') ||
		fs.existsSync('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')) return 'msedge';
	throw new Error('Install Chrome or Edge, or select an installed channel with LOCAL_BREW_BROWSER');
}

async function startLivePreview(options = {}) {
	if (!fs.existsSync(path.join(UI_DIRECTORY, 'index.html'))) {
		throw new Error('Build the TizenBrew UI first: python tv-app\\build-debug-tizenbrew.py');
	}
	const { chromium } = require('playwright');
	const uiConfig = JSON.parse(fs.readFileSync(path.join(UI_DIRECTORY, '..', 'src', 'components', 'tv-diagnostics-config.json'), 'utf8'));
	if (typeof uiConfig.token !== 'string' || !uiConfig.token) throw new Error('Built UI has no diagnostic token; rebuild it before previewing');
	const server = createUiServer(UI_DIRECTORY, uiConfig.token);
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	let browser;
	try {
		const headless = options.headless === true;
		browser = await chromium.launch({ channel: options.channel || browserChannel(), headless,
			args: ['--autoplay-policy=no-user-gesture-required', ...(headless ? [] : ['--start-maximized'])] });
		const context = await browser.newContext({ viewport: headless ? { width: 1280, height: 720 } : null });
		const page = await context.newPage();
		const uiOrigin = 'http://127.0.0.1:' + server.address().port;
		const url = uiOrigin + UI_PATH;
		const service = createLocalService();
		await page.exposeFunction('__localBrewRpc', request => service.handle(request));
		await page.exposeFunction('__localBrewClose', () => browser.close());
		await page.exposeFunction('__tizenBrewReturnToHome', async payload => {
			service.handle({ operation: 'return', payload });
			await page.goto(url);
		});
		let bootstrap = '(' + installDesktopAdapter.toString() + ')(' + JSON.stringify({ uiOrigin }) + ');\n';
		for (const [key, definition] of Object.entries(DEFINITIONS)) {
			const test = key === 'prime' ? '/(^|\\.)primevideo\\.com$/.test(location.hostname)' :
				key === 'hotstar' ? '/(^|\\.)hotstar\\.com$/.test(location.hostname)' : '/^(www\\.)?google\\.com$/.test(location.hostname)';
			bootstrap += 'if (' + test + ') {\n' +
				fs.readFileSync(path.join(__dirname, definition.folder, 'userScript.js'), 'utf8') + '\n}\n';
		}
		await page.addInitScript({ content: bootstrap });
		await page.goto(url);
		let closed = false;
		async function close() {
			if (closed) return;
			closed = true;
			try { await browser.close(); }
			finally {
				server.closeAllConnections();
				await new Promise(resolve => server.close(resolve));
			}
		}
		return { browser, page, url, service, close };
	} catch (error) {
		if (browser) await browser.close();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		throw error;
	}
}

if (require.main === module) {
	startLivePreview().then(async preview => {
		console.log('Local TizenBrew UI: ' + preview.url);
		console.log('Real websites / local working-tree scripts. No TV service is contacted.');
		console.log('Press Restart service in this LOCAL UI, then select a module. Login manually if required.');
		console.log('Esc acts as TV Back. Close the browser or press Ctrl+C to stop.');
		process.once('SIGINT', () => preview.close().catch(error => { console.error(error); process.exitCode = 1; }));
		process.once('SIGTERM', () => preview.close().catch(error => { console.error(error); process.exitCode = 1; }));
		if (preview.browser.isConnected()) await new Promise(resolve => preview.browser.once('disconnected', resolve));
		await preview.close();
	}).catch(error => { console.error('[Local TizenBrew] ' + error.message); process.exitCode = 1; });
}

module.exports = { createLocalService, createUiServer, startLivePreview, browserChannel };
