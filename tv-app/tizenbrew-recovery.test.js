'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createDebuggerRecovery = require('./tizenbrew-debugger-recovery');
const reconnectModule = import('./tizenbrew-ui-reconnect.mjs');

async function fixture(port) {
	const { reconnectClient } = await reconnectModule;
	const timers = new Map();
	let nextTimer = 0;
	const sockets = [];
	class Socket {
		constructor() { this.readyState = 0; sockets.push(this); }
		close() { this.readyState = 3; if (this.onclose) this.onclose(); }
		open() { this.readyState = 1; this.onopen(); }
		message(type, payload) { this.onmessage({ data: JSON.stringify({ type, payload }) }); }
	}
	const state = { sharedData: { modules: [{ name: 'old' }], debugStatus: {},
		error: { message: 'Service connection closed' } } };
	const actions = [];
	const sent = [];
	const errors = [];
	const client = {
		socket: new Socket(), modulesLoaded: true, modules: state.sharedData.modules,
		connectionErrorMessage: 'Service connection closed',
		context: { state, dispatch(action) {
			actions.push(action);
			if (action.type === 'SET_MODULES') state.sharedData.modules = action.payload;
			if (action.type === 'SET_DEBUG_STATUS') state.sharedData.debugStatus = action.payload;
			if (action.type === 'CLEAR_CONNECTION_ERROR' && state.sharedData.error.message === action.payload) {
				state.sharedData.error.message = null;
			}
		} },
		send(message) { sent.push(message); return true; },
		connectionError(message, transport) {
			errors.push(message);
			if (transport) this.connectionErrorMessage = message;
			state.sharedData.error.message = message;
		},
		onMessage() {},
		processPendingEvents() {},
	};
	const platform = {
		WebSocket: Socket, __tizenBrewDebugPort: port,
		setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
		clearTimeout(id) { timers.delete(id); },
	};
	return { client, state, sent, errors, sockets, actions, timers,
		connect: () => reconnectClient(client, platform) };
}

const ready = { tizenDebug: true, webDebug: true, rwiDebug: false };
const notReady = { tizenDebug: false, webDebug: false, rwiDebug: false };

test('reconnection replaces the closed socket and reloads Home before clearing its own error', async () => {
	const f = await fixture();
	const old = f.client.socket;
	const pending = f.connect();
	assert.equal(f.connect(), pending);
	assert.equal(old.readyState, 3);
	assert.equal(f.state.sharedData.modules, null);
	f.client.socket.open();
	assert.deepEqual(f.sent[0], { type: 1 });
	f.client.socket.message(1, ready);
	assert.notEqual(f.state.sharedData.error.message, null);
	f.client.socket.message(4, [{ name: 'google-test' }]);
	const result = await pending;
	assert.equal(result.debuggerReady, true);
	assert.equal(f.state.sharedData.modules[0].name, 'google-test');
	assert.equal(f.state.sharedData.error.message, null);
	assert.equal(f.timers.size, 0);
	assert.equal(f.client.reconnectPending, null);
});

test('a new service reattaches the remembered debugger without requesting another app relaunch', async () => {
	const f = await fixture(42873);
	const pending = f.connect();
	let completed = false;
	pending.then(() => { completed = true; });
	f.client.socket.open();
	f.client.socket.message(1, notReady);
	assert.ok(f.sent.some(message => message.type === 11 && message.payload.port === 42873));
	assert.ok(!f.sent.some(message => message.type === 3));
	f.client.socket.message(4, [{ name: 'google-test' }]);
	await Promise.resolve();
	assert.equal(completed, false);
	f.client.socket.message(11, { ok: true, debug: ready });
	assert.equal((await pending).debuggerReady, true);
	assert.equal(f.client.debuggerReady, true);
});

test('missing or failed debugger recovery restores the catalog but never claims injection readiness', async () => {
	for (const port of [undefined, 42873]) {
		const f = await fixture(port);
		const pending = f.connect();
		f.client.socket.open();
		f.client.socket.message(1, notReady);
		if (port) f.client.socket.message(11, { ok: false, error: 'target unavailable' });
		f.client.socket.message(4, [{ name: 'google-test' }]);
		const result = await pending;
		assert.equal(result.connected, true);
		assert.equal(result.debuggerReady, false);
		assert.equal(f.state.sharedData.modules.length, 1);
		assert.match(f.state.sharedData.error.message, /debugger|Debugger/);
	}
});

test('a healthy handshake does not erase an unrelated error and handles a loading catalog', async () => {
	const f = await fixture();
	f.state.sharedData.error.message = 'Unrelated module error';
	const pending = f.connect();
	f.client.socket.open();
	f.client.socket.message(1, ready);
	f.client.socket.message(4, null);
	assert.equal(f.client.modulesLoaded, false);
	const retry = [...f.timers.values()].find(timer => timer.ms === 500);
	retry.callback();
	f.client.socket.message(4, []);
	await pending;
	assert.equal(f.state.sharedData.error.message, 'Unrelated module error');
});

test('timeouts and invalid handshakes reject rather than reporting a connected app', async () => {
	for (const mode of ['timeout', 'invalid', 'close']) {
		const f = await fixture();
		const pending = f.connect();
		const rejected = assert.rejects(pending);
		f.client.socket.open();
		if (mode === 'timeout') [...f.timers.values()].find(timer => timer.ms === 20000).callback();
		else if (mode === 'invalid') f.client.socket.message(1, null);
		else f.client.socket.close();
		await rejected;
		assert.equal(f.client.debuggerReady, false);
		assert.equal(f.client.reconnectPending, null);
		assert.ok(f.errors.length > 0);
	}
});

test('debugger recovery checks that the port belongs to the TizenBrew UI before attaching', async () => {
	const requests = [];
	const attached = [];
	const logs = [];
	const recover = createDebuggerRecovery(async (url, options) => {
		requests.push({ url, options });
		return { ok: true, json: async () => [{ url: 'file:///tizenbrew-ui/dist/index.html' }] };
	}, async port => attached.push(port), (level, text) => logs.push({ level, text }));
	const pending = recover(42873);
	assert.equal(recover(42873), pending);
	await pending;
	assert.deepEqual(attached, [42873]);
	assert.equal(requests[0].url, 'http://127.0.0.1:42873/json/list');
	assert.deepEqual(requests[0].options, { timeout: 3000, size: 65536 });
	assert.ok(logs.some(entry => entry.text.includes('debugger restored')));
	await assert.rejects(recover(0), /Invalid/);
});

test('debugger recovery reports wrong targets, HTTP failures and attach failures', async () => {
	for (const scenario of ['wrong-target', 'http', 'attach']) {
		const logs = [];
		const recover = createDebuggerRecovery(async () => ({
			ok: scenario !== 'http', status: 503,
			json: async () => [{ url: scenario === 'wrong-target' ? 'https://www.google.com/' : 'file:///tizenbrew-ui/dist/index.html' }],
		}), async () => { throw new Error('attach failed'); }, (level, text) => logs.push({ level, text }));
		await assert.rejects(recover(1234));
		assert.ok(logs.some(entry => entry.level === 'error'));
	}
});
