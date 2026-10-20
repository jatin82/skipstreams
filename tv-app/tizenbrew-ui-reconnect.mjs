export function reconnectClient(client, platform = window) {
	if (client.reconnectPending) return client.reconnectPending;
	const events = { debug: 1, modules: 4, ready: -1, error: 8, recover: 11 };
	const old = client.socket;
	if (old) {
		old.onopen = old.onmessage = old.onerror = old.onclose = null;
		if (old.readyState < 2) old.close();
	}
	client.debuggerReady = false;
	client.modulesLoaded = false;
	client.modules = [];
	client.pendingEvents = [];
	client.context.dispatch({ type: 'SET_MODULES', payload: null });
	const socket = new platform.WebSocket('ws://localhost:8081');
	client.socket = socket;
	let resolve;
	let reject;
	const pending = new Promise((done, failed) => { resolve = done; reject = failed; });
	client.reconnectPending = pending;
	let settled = false;
	let debugDone = false;
	let recoveryRequested = false;
	let debugError = '';
	let retryTimer;
	const timer = platform.setTimeout(() => fail(new Error('App reconnection timed out before the module handshake completed')), 20000);
	const active = () => client.socket === socket;

	function clearTimers() {
		platform.clearTimeout(timer);
		platform.clearTimeout(retryTimer);
	}
	function fail(error) {
		if (!active() || settled) return;
		settled = true;
		clearTimers();
		client.debuggerReady = false;
		client.reconnectPending = null;
		client.connectionError(error.message, true);
		if (socket.readyState < 2) socket.close();
		reject(error);
	}
	function setDebug(status) {
		if (!status || typeof status.webDebug !== 'boolean') throw new Error('Invalid debugger status from service');
		client.debuggerReady = !!(status.webDebug || status.rwiDebug || status.appDebug);
		client.context.state.sharedData.debugStatus = status;
		client.context.dispatch({ type: 'SET_DEBUG_STATUS', payload: status });
	}
	function finish() {
		if (settled || !debugDone || !client.modulesLoaded) return;
		settled = true;
		clearTimers();
		client.reconnectPending = null;
		socket.onmessage = event => { if (active()) client.onMessage(event); };
		client.context.dispatch({ type: 'CLEAR_CONNECTION_ERROR', payload: client.connectionErrorMessage });
		client.context.dispatch({ type: 'SET_STATE', payload: 'service.connected' });
		if (!client.debuggerReady) {
			client.connectionError(debugError || 'App reconnected, but the module debugger is not attached. Reopen TizenBrew to initialize injection.');
		}
		resolve({ connected: true, debuggerReady: client.debuggerReady, error: debugError });
	}
	socket.onopen = () => {
		if (active()) client.send({ type: events.debug });
	};
	socket.onerror = () => {
		if (!active()) return;
		if (!settled) fail(new Error('App WebSocket connection failed'));
		else client.connectionError('App WebSocket connection failed. Use Check service to reconnect.', true);
	};
	socket.onclose = () => {
		if (!active()) return;
		client.debuggerReady = false;
		if (!settled) fail(new Error('App connection closed before the module handshake completed'));
		else client.connectionError('Service connection closed. Use Check service or Restart service to reconnect.', true);
	};
	socket.onmessage = event => {
		if (!active() || settled) return;
		try {
			const message = JSON.parse(event.data);
			if (message.type === events.debug) {
				setDebug(message.payload);
				if (client.debuggerReady) {
					debugDone = true;
				} else if (!recoveryRequested) {
					const port = platform.__tizenBrewDebugPort;
					if (Number.isInteger(port) && port > 0 && port <= 65535) {
						recoveryRequested = true;
						client.send({ type: events.recover, payload: { port } });
					} else {
						debugDone = true;
						debugError = 'App reconnected, but no existing page debugger endpoint is available. Reopen TizenBrew to initialize injection.';
					}
				}
				client.send({ type: events.modules });
			} else if (message.type === events.recover) {
				if (!message.payload || typeof message.payload.ok !== 'boolean') throw new Error('Invalid debugger recovery response');
				debugDone = true;
				if (message.payload.ok) setDebug(message.payload.debug);
				else {
					client.debuggerReady = false;
					debugError = 'Debugger recovery failed: ' + message.payload.error;
				}
			} else if (message.type === events.modules) {
				if (message.payload === null) {
					platform.clearTimeout(retryTimer);
					retryTimer = platform.setTimeout(() => {
						if (active() && !settled) client.send({ type: events.modules });
					}, 500);
				} else {
					if (!Array.isArray(message.payload)) throw new Error('Invalid module list from service');
					client.modules = message.payload;
					client.modulesLoaded = true;
					client.context.dispatch({ type: 'SET_MODULES', payload: message.payload });
					client.send({ type: events.ready });
					client.processPendingEvents();
				}
			} else if (message.type === events.error) {
				throw new Error(String(message.payload));
			} else {
				client.onMessage(event);
			}
			finish();
		} catch (error) {
			fail(error);
		}
	};
	return pending;
}
