'use strict';

module.exports = function createDeviceInfoClient(fetch, report, runtime) {
	var pending = null;
	var allowed = null;
	var lastError = null;
	var attempts = 0;
	var retryDelay = runtime && runtime.retryDelayMs !== undefined ? runtime.retryDelayMs : 1000;
	var timeout = 3000;
	var address = 'http://127.0.0.1:8001/api/v2/';

	function attempt() {
		attempts++;
		report('info', 'Device API request; attempt=' + attempts + '/3');
		return Promise.resolve().then(function () {
			return fetch(address, { timeout: timeout, size: 65536 });
		}).then(function (response) {
			if (!response.ok) throw new Error('Device API HTTP ' + response.status);
			return response.json();
		}).then(function (json) {
			var device = json && json.device;
			if (!device || typeof device.developerIP !== 'string' ||
				(device.developerMode !== '0' && device.developerMode !== '1')) {
				throw new Error('Device API response is missing valid developer-mode information');
			}
			allowed = (device.developerIP === '127.0.0.1' || device.developerIP === '1.0.0.127') &&
				device.developerMode === '1';
			lastError = null;
			report('info', 'Device API check completed; canLaunchInDebug=' + allowed);
			return allowed;
		}).catch(function (error) {
			lastError = String(error && error.message || error);
			report('error', 'Device API attempt ' + attempts + '/3 failed: ' + lastError);
			if (attempts >= 3) {
				throw new Error('TV device API unavailable after 3 attempts: ' + lastError +
					'. Reopen TizenBrew after the TV has finished starting.');
			}
			report('info', 'Device API retry scheduled; delayMs=' + retryDelay);
			return new Promise(function (resolve) { setTimeout(resolve, retryDelay); }).then(attempt);
		});
	}

	function read() {
		if (pending) return pending;
		attempts = 0;
		allowed = null;
		pending = attempt().then(function (value) {
			pending = null;
			return value;
		}, function (error) {
			pending = null;
			throw error;
		});
		return pending;
	}

	function reply(connection, events) {
		function send(type, payload) {
			if (connection.connection.readyState !== 1) {
				report('warning', 'Device API reply skipped: UI socket is no longer open');
				return;
			}
			connection.send(connection.Event(type, payload));
		}
		return read().then(function (value) {
			send(events.CanLaunchInDebug, value);
		}, function (error) {
			send(events.Error, error.message);
		}).catch(function (error) {
			report('error', 'Device API reply failed: ' + String(error && error.message || error));
		});
	}

	return {
		read: read,
		reply: reply,
		getStatus: function () {
			return { pending: !!pending, attempts: attempts, allowed: allowed, lastError: lastError };
		},
	};
};
