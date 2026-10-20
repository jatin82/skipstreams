export function createUiDiagnostics(platform, token, enabled = false) {
	if (enabled !== true) {
		return { record() {}, subscribe(listener) { listener([]); return () => {}; }, stop() {} };
	}
	const session = 'ui-' + Date.now();
	const entries = [];
	const listeners = new Set();
	const originals = new Map();
	let sequence = 0;
	let bytes = 0;
	let timer = null;
	let stopped = false;

	function format(value) {
		try {
			if (value && value.stack) return String(value.stack);
			return typeof value === 'object' ? JSON.stringify(value) : String(value);
		} catch (error) {
			return '[UI log serialization failed: ' + String(error) + ']';
		}
	}
	function record(level, message) {
		if (stopped) return;
		let text = String(message);
		if (token) text = text.split(token).join('[redacted]');
		const entry = { id: ++sequence, session, time: new Date().toISOString(),
			level, text: text.slice(0, 8000), url: 'ui://TizenBrew' };
		const size = new Blob([JSON.stringify(entry)]).size;
		entries.push({ entry, size });
		bytes += size;
		while (bytes > 131072) bytes -= entries.shift().size;
		if (timer === null) {
			timer = platform.setTimeout(() => {
				timer = null;
				const snapshot = entries.map(item => item.entry);
				listeners.forEach(listener => listener(snapshot));
			}, 0);
		}
	}
	for (const level of ['log', 'info', 'debug', 'warn', 'error', 'trace', 'table', 'assert']) {
		const original = platform.console[level];
		if (typeof original !== 'function') continue;
		const wrapped = function (...args) {
			if (level !== 'assert' || !args[0]) {
				record(level === 'assert' ? 'error' : level,
					(level === 'assert' ? args.slice(1) : args).map(format).join(' '));
			}
			return original.apply(platform.console, args);
		};
		originals.set(level, { original, wrapped });
		platform.console[level] = wrapped;
	}
	function onError(event) {
		const resource = event.target && (event.target.src || event.target.href);
		record('error', 'UI error: ' + format(event.error || event.message || ('Resource failed: ' + resource)) +
			(event.filename ? ' at ' + event.filename + ':' + event.lineno : ''));
	}
	function onRejection(event) {
		record('error', 'UI unhandled rejection: ' + format(event.reason));
	}
	platform.addEventListener('error', onError, true);
	platform.addEventListener('unhandledrejection', onRejection);
	record('info', 'Local UI diagnostics started; captures errors even without a service connection');
	return {
		record,
		subscribe(listener) {
			listeners.add(listener);
			listener(entries.map(item => item.entry));
			return () => listeners.delete(listener);
		},
		stop() {
			stopped = true;
			platform.clearTimeout(timer);
			listeners.clear();
			platform.removeEventListener('error', onError, true);
			platform.removeEventListener('unhandledrejection', onRejection);
			originals.forEach(({ original, wrapped }, level) => {
				if (platform.console[level] === wrapped) platform.console[level] = original;
			});
		},
	};
}
