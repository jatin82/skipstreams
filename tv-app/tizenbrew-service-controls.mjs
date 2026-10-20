export function parseDiagnosticHistory(text) {
	if (!text.trim()) throw new Error('Saved diagnostics response was empty');
	if (new Blob([text]).size > 524288) throw new Error('Saved diagnostics exceed the 512 KiB limit');
	const entries = [];
	const invalidLines = [];
	text.split('\n').forEach((line, index) => {
		if (!line.trim()) return;
		try {
			const entry = JSON.parse(line);
			if (!entry || typeof entry.session !== 'string' || typeof entry.time !== 'string' ||
				typeof entry.level !== 'string' || typeof entry.text !== 'string' || typeof entry.url !== 'string') {
				throw new Error('Invalid diagnostic record');
			}
			entries.push(entry);
		} catch (error) {
			invalidLines.push(index + 1);
		}
	});
	return { entries, invalidLines };
}

export function mergeDiagnosticEntries(previous, incoming) {
	if (!incoming.length) return previous;
	const records = new Map();
	for (const entry of previous.concat(incoming)) {
		const key = entry.key || (Number.isInteger(entry.id) ? entry.session + ':' + entry.id :
			JSON.stringify([entry.session, entry.time, entry.level, entry.text, entry.url]));
		const existing = records.get(key);
		if (!existing || entry.text.length >= existing.text.length) records.set(key, { ...entry, key });
	}
	const entries = Array.from(records.values()).sort((a, b) => a.time.localeCompare(b.time));
	let size = 0;
	let start = entries.length;
	while (start > 0) {
		const bytes = new Blob([JSON.stringify(entries[start - 1])]).size;
		if (size + bytes > 2097152) break;
		size += bytes;
		start--;
	}
	return entries.slice(start);
}

export function diagnosticSource(entry) {
	if (entry.url?.startsWith('ui://')) return 'UI';
	if (entry.url?.startsWith('transport://')) return 'TRANSPORT';
	if (entry.url?.startsWith('service://')) return 'SERVICE';
	return 'PAGE';
}

export function createServiceControls(token, platform = window) {
	const base = 'http://127.0.0.1:8081/__tv_debug/';
	const sleep = platform.sleep || (ms => new Promise(resolve => platform.setTimeout(resolve, ms)));
	const now = platform.now || Date.now;

	function request(method, route, expectedStatus = 200, decode = JSON.parse) {
		return new Promise((resolve, reject) => {
			const xhr = new platform.XMLHttpRequest();
			function fail(message, code) {
				const error = new Error(message);
				error.code = code;
				reject(error);
			}
			xhr.open(method, base + route);
			xhr.timeout = 3000;
			xhr.setRequestHeader('Authorization', 'Bearer ' + token);
			xhr.onload = () => {
				if (xhr.status !== expectedStatus) {
					fail('Service request failed: HTTP ' + xhr.status, 'http');
					return;
				}
				try {
					resolve(decode(xhr.responseText));
				} catch (error) {
					fail('Service returned an unreadable response: ' + error.message, 'invalid');
				}
			};
			xhr.onerror = () => fail('Service is disconnected or unavailable', 'network');
			xhr.ontimeout = () => fail('Service did not respond within 3 seconds', 'timeout');
			xhr.send();
		});
	}

	async function check(cursor = { session: '', after: 0 }) {
		const result = await request('GET', 'live?session=' + encodeURIComponent(cursor.session) + '&after=' + cursor.after);
		if (!result || typeof result.session !== 'string' || !Number.isInteger(result.pid) ||
			!Number.isFinite(result.uptime) || !Number.isInteger(result.cursor) || !Array.isArray(result.entries) ||
			result.entries.some(entry => !Number.isInteger(entry.id) || typeof entry.text !== 'string' ||
				typeof entry.level !== 'string' || typeof entry.time !== 'string')) {
			const error = new Error('Service returned an invalid health response');
			error.code = 'invalid';
			throw error;
		}
		return result;
	}

	function launch() {
		return new Promise((resolve, reject) => {
			const timer = platform.setTimeout(() => reject(new Error('Tizen did not confirm the service launch request')), 10000);
			function finish(error) {
				platform.clearTimeout(timer);
				if (error) reject(new Error('Service launch failed: ' + error.message));
				else resolve();
			}
			try {
				const tizen = platform.tizen;
				const packageId = tizen.application.getCurrentApplication().appInfo.packageId;
				tizen.application.launchAppControl(
					new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
					packageId + '.StandaloneService', () => finish(), finish);
			} catch (error) {
				finish(error);
			}
		});
	}

	async function restart(onProgress) {
		let before;
		try {
			before = await check();
		} catch (error) {
			if (error.code !== 'network' && error.code !== 'timeout') throw error;
		}
		if (before) {
			onProgress('Stopping service...');
			const response = await request('POST', 'restart', 202);
			if (!response.restarting || response.session !== before.session) {
				throw new Error('Service did not confirm the restart request');
			}
			await sleep(750);
		}
		onProgress('Starting service; waiting for a fresh response...');
		await launch();
		const deadline = now() + 30000;
		do {
			try {
				const snapshot = await check();
				if (!before || snapshot.session !== before.session) {
					return { snapshot, restarted: !!before };
				}
			} catch (error) {
				if (error.code !== 'network' && error.code !== 'timeout') throw error;
			}
			await sleep(1000);
		} while (now() < deadline);
		throw new Error('Service launch was requested, but recovery was not confirmed within 30 seconds');
	}

	return { check, restart, history: () => request('GET', 'logs', 200, parseDiagnosticHistory) };
}
