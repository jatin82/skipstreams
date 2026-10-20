'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const startServiceDiagnostics = require('./tizenbrew-service-diagnostics');
const rawLogForwarder = require('./tizenbrew-log-forwarder');
const attachLogForwarder = (client, moduleInfo, config, record) =>
	rawLogForwarder(client, moduleInfo, { loggingEnabled: true, ...config }, record);
const { readDiagnostics } = require('./read-tv-diagnostics');

const token = 'private-diagnostic-token-for-tests';

function localTransport(emitter, moduleInfo, config, record) {
	emitter.on('Runtime.consoleAPICalled', event => {
		record({ level: event.type, text: event.args[0].value, url: moduleInfo.appPath });
	});
	return { flush() {}, stop() {}, getStatus: () => ({ pending: false, queued: 0 }) };
}

function fixture(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-local-test-'));
	const logPath = path.join(directory, 'diagnostics.jsonl');
	const calls = [];
	const localConsole = Object.fromEntries(['log', 'info', 'debug', 'warn', 'error'].map(level =>
		[level, (...args) => calls.push({ level, args })]));
	const localProcess = Object.assign(new EventEmitter(), { pid: 123, version: 'v18.18.2', uptime: () => 42 });
	const services = [];
	t.after(() => {
		for (const service of services) service.stop();
		fs.rmSync(directory, { recursive: true, force: true });
	});
	return {
		logPath, calls, localProcess,
		start(config = {}, transport = localTransport, runtime = {}) {
			const service = startServiceDiagnostics({ token, loggingEnabled: true, ...config }, transport,
				{ console: localConsole, process: localProcess, logPath, ...runtime });
			services.push(service);
			return service;
		},
		entries() {
			return [logPath + '.1', logPath].filter(filename => fs.existsSync(filename))
				.flatMap(filename => fs.readFileSync(filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)));
		},
	};
}

async function waitUntil(predicate) {
	const deadline = Date.now() + 8000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, 'Timed out waiting for diagnostic event');
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

async function listen(t, handler) {
	const server = http.createServer(handler);
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => {
		server.closeAllConnections();
		return new Promise(resolve => server.close(resolve));
	});
	return server.address().port;
}

test('local records survive restart, redact credentials, and observe lifecycle and socket events', t => {
	const f = fixture(t);
	const service = f.start();
	service.report('info', 'before restart ' + token);
	const socket = new EventEmitter();
	service.observeSocket(socket);
	socket.emit('close', 1001);
	assert.throws(() => socket.emit('error', new Error('test socket error')), /test socket error/);
	socket.on('error', () => {});
	assert.doesNotThrow(() => socket.emit('error', new Error('handled socket error')));
	f.localProcess.emit('beforeExit', 0);
	f.localProcess.emit('exit', 0);
	service.stop();
	f.localProcess.pid++;
	f.start();
	const entries = f.entries();
	assert.equal(new Set(entries.map(entry => entry.session)).size, 2);
	assert.ok(entries.every(entry => typeof entry.uptimeMs === 'number' && !Number.isNaN(Date.parse(entry.time))));
	const text = JSON.stringify(entries);
	assert.ok(!text.includes(token));
	for (const marker of ['before restart [redacted]', 'Process beforeExit', 'Process exit',
		'UI socket opened', 'UI socket closed; code=1001', 'test socket error']) assert.ok(text.includes(marker));
	assert.equal(f.localProcess.listenerCount('uncaughtException'), 0);
	assert.equal(f.localProcess.listenerCount('unhandledRejection'), 0);
});

test('rotation bounds both generations to 256 KiB with worst-case escaped Unicode records', t => {
	const f = fixture(t);
	const service = f.start();
	service.report('info', 'oldest record');
	for (let i = 0; i < 60; i++) {
		service.record({ level: 'info', text: String(i) + '\u0000'.repeat(8000),
			url: '\u0000'.repeat(2000) });
		assert.ok(fs.statSync(f.logPath).size <= 262144);
		if (fs.existsSync(f.logPath + '.1')) assert.ok(fs.statSync(f.logPath + '.1').size <= 262144);
	}
	assert.deepEqual(fs.readdirSync(path.dirname(f.logPath)).sort(), ['diagnostics.jsonl', 'diagnostics.jsonl.1']);
	const entries = f.entries();
	assert.ok(entries.at(-1).text.startsWith('59'));
	assert.ok(!entries.some(entry => entry.text.includes('oldest record')));
});

test('HTTP retrieval is read-only, authenticated, and leaves existing service routes untouched', async t => {
	const f = fixture(t);
	const service = f.start();
	service.report('info', 'persisted evidence');
	const port = await listen(t, (req, res) => {
		if (!service.handleRequest(req, res)) res.end('existing route');
	});
	const base = 'http://127.0.0.1:' + port;
	assert.equal((await fetch(base + '/__tv_debug/logs')).status, 401);
	assert.equal((await fetch(base + '/__tv_debug/logs', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
	const headers = { Authorization: 'Bearer ' + token };
	assert.equal((await fetch(base + '/__tv_debug/logs', { method: 'POST', headers })).status, 405);
	assert.equal(await (await fetch(base + '/module/test')).text(), 'existing route');
	const contents = await readDiagnostics(port, token);
	assert.match(contents.toString(), /persisted evidence/);
	assert.equal(contents.toString(), fs.readFileSync(f.logPath, 'utf8'));
});

test('disk failures are explicit and unavailable snapshots return errors, not empty success', async t => {
	const f = fixture(t);
	const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
	const service = f.start({}, localTransport, { fs: { statSync() { throw denied; } } });
	const port = await listen(t, (req, res) => service.handleRequest(req, res));
	await assert.rejects(readDiagnostics(port, token), /HTTP 503/);
	assert.ok(f.calls.some(call => call.args[0].includes('Local diagnostic write failed')));
	assert.equal(f.calls.length, 1, 'Repeated disk errors are throttled without recursion');
});

test('live UI diagnostics expose bounded incremental records and allow only local-app CORS', async t => {
	const f = fixture(t);
	const service = f.start();
	const port = await listen(t, (req, res) => service.handleRequest(req, res));
	const base = 'http://127.0.0.1:' + port + '/__tv_debug/live';
	const headers = { Authorization: 'Bearer ' + token, Origin: 'null' };
	const first = await fetch(base, { headers });
	assert.equal(first.headers.get('access-control-allow-origin'), 'null');
	const data = await first.json();
	assert.equal(data.pid, 123);
	assert.equal(data.uptime, 42);
	assert.ok(data.entries.length > 0);
	service.report('error', 'full diagnostic ' + 'x'.repeat(6000));
	const full = await (await fetch(base, { headers })).json();
	const complete = full.entries.find(entry => entry.text.includes('full diagnostic'));
	assert.ok(complete.text.length > 6000);
	assert.ok(f.entries().some(entry => entry.session === full.session && entry.id === complete.id));
	for (let i = 0; i < 250; i++) service.report('info', 'entry ' + i);
	const next = await (await fetch(base + '?session=' + data.session + '&after=' + data.cursor, { headers })).json();
	assert.equal(next.entries.length, 40);
	assert.ok(next.dropped > 0);
	assert.ok(next.entries.every(entry => entry.id > data.cursor && entry.text.length <= 8000));
	assert.equal((await fetch(base + '?after=invalid', { headers })).status, 400);
	assert.equal((await fetch(base, { headers: { ...headers, Origin: 'https://www.google.com' } })).status, 403);
	assert.equal((await fetch(base, { method: 'OPTIONS', headers: { Origin: 'null' } })).status, 204);
});

test('manual service exit requires an authenticated POST and never affects module configuration', async t => {
	const f = fixture(t);
	const exits = [];
	f.localProcess.exit = code => exits.push(code);
	const service = f.start();
	const port = await listen(t, (req, res) => service.handleRequest(req, res));
	const url = 'http://127.0.0.1:' + port + '/__tv_debug/restart';
	const headers = { Authorization: 'Bearer ' + token };
	assert.equal((await fetch(url, { method: 'POST' })).status, 401);
	assert.equal((await fetch(url, { headers })).status, 405);
	assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
	assert.deepEqual(exits, []);
	const result = await fetch(url, { method: 'POST', headers });
	assert.equal(result.status, 202);
	assert.equal((await result.json()).restarting, true);
	assert.equal((await fetch(url, { method: 'POST', headers })).status, 409);
	await waitUntil(() => exits.length > 0);
	assert.deepEqual(exits, [0]);
	assert.ok(f.entries().some(entry => entry.text.includes('Manual service restart requested')));
	assert.ok(fs.readdirSync(path.dirname(f.logPath)).every(name => name.startsWith('diagnostics.jsonl')));
});

test('disabled logging retains health and stop controls without a transport, disk writes or process hooks', async t => {
	const f = fixture(t);
	const exits = [];
	f.localProcess.exit = code => exits.push(code);
	const service = f.start({ loggingEnabled: false }, () => assert.fail('No upload transport should be created'));
	service.bindState(() => ({ module: '', debug: { webDebug: false } }));
	service.report('error', 'not recorded');
	service.record({ level: 'info', text: 'not recorded' });
	assert.equal(fs.existsSync(f.logPath), false);
	assert.equal(f.localProcess.listenerCount('uncaughtExceptionMonitor'), 0);
	assert.equal(f.localProcess.listenerCount('beforeExit'), 0);
	const port = await listen(t, (req, res) => service.handleRequest(req, res));
	const headers = { Authorization: 'Bearer ' + token };
	const health = await (await fetch('http://127.0.0.1:' + port + '/__tv_debug/live', { headers })).json();
	assert.equal(health.loggingEnabled, false);
	assert.equal(health.pid, 123);
	assert.deepEqual(health.entries, []);
	assert.equal((await fetch('http://127.0.0.1:' + port + '/__tv_debug/restart',
		{ method: 'POST', headers })).status, 202);
	await waitUntil(() => exits.length > 0);
	assert.deepEqual(exits, [0]);
	assert.equal(fs.existsSync(f.logPath), false);
});

test('upload rejection and recovery are recorded locally without recursive uploads', async t => {
	let status = 503;
	const received = [];
	const port = await listen(t, (req, res) => {
		let body = '';
		req.on('data', chunk => { body += chunk; });
		req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(status); res.end(); });
	});
	const f = fixture(t);
	f.start({ host: '127.0.0.1', port }, attachLogForwarder, { heartbeatMs: 30 });
	await waitUntil(() => f.entries().some(entry => entry.text.includes('Upload failed: Error: HTTP 503')));
	await waitUntil(() => f.entries().some(entry => entry.text.includes('Heartbeat;') && entry.text.includes('HTTP 503')));
	status = 204;
	await waitUntil(() => f.entries().some(entry => entry.text.includes('Upload completed; HTTP 204')));
	assert.ok(received.flat().every(entry => !entry.url.startsWith('transport://')));
	assert.ok(f.entries().some(entry => entry.text.includes('Upload TCP connected')));
});

test('a stalled upload times out while local heartbeat records keep progressing', async t => {
	const port = await listen(t, req => req.resume());
	const f = fixture(t);
	const service = f.start({ host: '127.0.0.1', port }, attachLogForwarder, { heartbeatMs: 100 });
	await waitUntil(() => f.entries().some(entry => entry.text.includes('Upload failed: Error: Upload timeout')));
	const entries = f.entries();
	assert.ok(entries.filter(entry => entry.text.includes('Heartbeat;')).length > 10);
	assert.ok(entries.some(entry => entry.text.includes('"pending":true')));
	service.stop();
});

test('page debugger events are persisted even when its upload receiver is unavailable', t => {
	const f = fixture(t);
	const service = f.start();
	const client = new EventEmitter();
	const forwarder = attachLogForwarder(client, { fullName: 'google-test' },
		{ host: '127.0.0.1', port: 1, token }, service.record);
	t.after(() => forwarder.stop());
	client.emit('Runtime.executionContextCreated', { context: { id: 7, origin: 'https://www.google.com' } });
	client.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'i am injected' }] });
	forwarder.stop();
	assert.ok(f.entries().some(entry => entry.text.includes('Execution context 7')));
	assert.ok(f.entries().some(entry => entry.text === 'i am injected'));
});

test('synchronous upload setup failures are recorded without swallowing the original error', t => {
	const f = fixture(t);
	const service = f.start();
	const forwarder = attachLogForwarder(new EventEmitter(), { fullName: 'google-test' },
		{ host: '127.0.0.1', port: -1, token }, service.record);
	t.after(() => forwarder.stop());
	try {
		assert.throws(() => forwarder.flush(), { code: 'ERR_SOCKET_BAD_PORT' });
		assert.ok(f.entries().some(entry => entry.text.includes('Upload failed:') && entry.text.includes('ERR_SOCKET_BAD_PORT')));
	} finally {
		forwarder.stop();
	}
});

test('fatal exceptions reach disk without changing the process exit status', t => {
	const f = fixture(t);
	const result = spawnSync(process.execPath, ['-e', `
		const start = require(${JSON.stringify(require.resolve('./tizenbrew-service-diagnostics'))});
		start({token: ${JSON.stringify(token)}, loggingEnabled: true}, ${localTransport.toString()},
			{console, process, logPath: ${JSON.stringify(f.logPath)}});
		throw new Error('intentional fatal diagnostic test');
	`], { encoding: 'utf8', timeout: 10000 });
	assert.equal(result.status, 1);
	const entries = f.entries();
	assert.ok(entries.some(entry => entry.text.includes('Uncaught exception observed') && entry.text.includes('intentional fatal')));
	assert.ok(entries.some(entry => entry.text === 'Process exit; code=1'));
});

test('retrieval rejects legacy endpoints, excessive response sizes, and invalid inputs', async t => {
	let oversized = false;
	const port = await listen(t, (req, res) => {
		if (oversized) {
			res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
			res.end('x'.repeat(524289));
		} else {
			res.end('192.168.29.51');
		}
	});
	await assert.rejects(readDiagnostics(port, token), /newest build/);
	oversized = true;
	await assert.rejects(readDiagnostics(port, token), /exceeds 512 KiB/);
	await assert.rejects(readDiagnostics(0, token), /Invalid local forwarding port/);
	await assert.rejects(readDiagnostics(port, 'short'), /Invalid diagnostic token/);
});
