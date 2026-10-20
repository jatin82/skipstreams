'use strict';

module.exports = function createDebuggerRecovery(fetch, attach, report) {
	var pending = null;
	var pendingPort = null;
	return function recover(port) {
		if (typeof port !== 'number' || port % 1 !== 0 || port < 1 || port > 65535) {
			return Promise.reject(new Error('Invalid page debugger port'));
		}
		if (pending) {
			if (port !== pendingPort) return Promise.reject(new Error('Another debugger recovery is in progress'));
			return pending;
		}
		pendingPort = port;
		report('info', 'Restoring existing page debugger; port=' + port);
		pending = Promise.resolve().then(function () {
			return fetch('http://127.0.0.1:' + port + '/json/list', { timeout: 3000, size: 65536 });
		}).then(function (response) {
			if (!response.ok) throw new Error('Debugger target lookup returned HTTP ' + response.status);
			return response.json();
		}).then(function (targets) {
			if (!Array.isArray(targets) || targets.length !== 1 || !targets[0] ||
				typeof targets[0].url !== 'string' || targets[0].url.indexOf('file:///tizenbrew-ui/dist/') !== 0) {
				throw new Error('Saved debugger port does not identify the TizenBrew UI');
			}
			return attach(port);
		}).then(function () {
			pending = null;
			report('info', 'Existing page debugger restored; port=' + port);
		}, function (error) {
			pending = null;
			report('error', 'Existing page debugger recovery failed: ' + String(error && error.message || error));
			throw error;
		});
		return pending;
	};
};
