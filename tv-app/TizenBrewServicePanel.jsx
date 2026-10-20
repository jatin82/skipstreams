import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { FocusContext, useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import { useTranslation } from 'react-i18next';
import { createServiceControls, mergeDiagnosticEntries, diagnosticSource } from './tizenbrew-service-controls.mjs';
import { uiDiagnostics } from './tv-ui-diagnostics-bootstrap.js';
import { GlobalStateContext } from './ClientContext.jsx';
import Client, { Events } from './WebSocketClient.js';
import config from './tv-diagnostics-config.json';
import './tizenbrew-service-panel.css';

function Control({ children, name, action, disabled }) {
	const { ref, focused } = useFocusable({ focusKey: name });
	return <button ref={ref} className={focused ? 'focus' : ''} disabled={disabled}
		onClick={action} type="button">{children}</button>;
}

function LogHistory({ entries, t }) {
	const logRef = useRef(null);
	const { ref, focused } = useFocusable({
		focusKey: 'service-log-history',
		onArrowPress(direction) {
			if (direction === 'up' || direction === 'down') {
				const element = logRef.current;
				if (direction === 'up' && element.scrollTop === 0) return true;
				element.scrollTop += (direction === 'up' ? -1 : 1) * Math.max(60, element.clientHeight * 0.8);
				return false;
			}
			return true;
		},
	});
	useEffect(() => {
		if (!focused && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
	}, [entries, focused]);
	return <div ref={ref} className={'tv-service-log-frame' + (focused ? ' focus' : '')}>
		<div ref={logRef} className="tv-service-logs" role="log"
			aria-label={t('diagnostics.liveLogs', { defaultValue: 'Live service logs' })}>
			{entries.map(entry => <div key={entry.key} className={'tv-service-log-' + entry.level}>
				<span>{entry.time.slice(0, 19).replace('T', ' ')}Z [{diagnosticSource(entry)}] {entry.level.toUpperCase()} </span>{entry.text}
			</div>)}
			{!entries.length && <div>{t('diagnostics.empty', {
				defaultValue: 'No service records received yet. Logs remain visible if the connection stops.',
			})}</div>}
		</div>
	</div>;
}

export default function ServicePanel() {
	const { t } = useTranslation();
	const context = useContext(GlobalStateContext);
	const appContext = useRef(context);
	appContext.current = context;
	const client = useRef(null);
	if (!client.current) client.current = createServiceControls(config.token);
	const cursor = useRef({ session: '', after: 0 });
	const running = useRef(false);
	const manualPending = useRef(false);
	const alive = useRef(true);
	const historySession = useRef('');
	const historyAttempt = useRef(0);
	const lastError = useRef('');
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState('Waiting for service response...');
	const [notice, setNotice] = useState('');
	const [lastReply, setLastReply] = useState(null);
	const [age, setAge] = useState(null);
	const [entries, setEntries] = useState([]);
	const [historyStatus, setHistoryStatus] = useState('Saved diagnostics not loaded yet');
	const { ref, focusKey } = useFocusable({
		focusKey: 'service-diagnostics',
		preferredChildFocusKey: 'service-check',
		saveLastFocusedChild: false,
	});

	function accept(snapshot) {
		cursor.current = { session: snapshot.session, after: snapshot.cursor };
		setLastReply(Date.now());
		setAge(0);
		if (config.loggingEnabled) setEntries(previous => mergeDiagnosticEntries(previous,
			snapshot.entries.map(entry => ({ ...entry, session: snapshot.session }))));
		if (snapshot.dropped) {
			historySession.current = '';
			uiDiagnostics.record('warning',
				snapshot.dropped + ' live records were overwritten; loading saved diagnostics to fill the gap');
		}
		if (lastError.current) {
			uiDiagnostics.record('info', 'Service replies resumed');
			lastError.current = '';
		}
		return 'Responding - PID ' + snapshot.pid + ' - uptime ' + snapshot.uptime + 's' +
			(snapshot.localWriteError ? ' - local log write failed' : '');
	}

	async function loadHistory(snapshot, manual) {
		if (!config.loggingEnabled) return;
		if (!manual && !snapshot.dropped && historySession.current === snapshot.session) return;
		if (!manual && Date.now() - historyAttempt.current < 10000) return;
		historyAttempt.current = Date.now();
		try {
			const saved = await client.current.history();
			if (!alive.current) return;
			setEntries(previous => mergeDiagnosticEntries(previous, saved.entries));
			historySession.current = snapshot.session;
			setHistoryStatus('Loaded ' + saved.entries.length + ' saved TV records');
			if (saved.invalidLines.length) {
				uiDiagnostics.record('error', 'Saved diagnostics contain unreadable lines: ' + saved.invalidLines.join(', '));
				setHistoryStatus('Saved history has ' + saved.invalidLines.length + ' unreadable lines');
			}
		} catch (error) {
			if (!alive.current) return;
			setHistoryStatus('Saved history unavailable');
			uiDiagnostics.record('error', 'Loading saved diagnostics failed: ' + error.message);
		}
	}

	async function reconnectApp(force, prefix = '') {
		try {
			let appClient = appContext.current.state.client;
			if (!appClient) {
				appClient = new Client(appContext.current, true);
				appContext.current.dispatch({ type: 'SET_CLIENT', payload: appClient });
			}
			if (!force && appClient.socket?.readyState === 1 && appClient.modulesLoaded && appClient.debuggerReady) {
				setNotice('App connected; module debugger ready.');
				return;
			}
			setNotice(prefix + ' Reconnecting app and loading modules...');
			uiDiagnostics.record('info', 'Reconnecting the app WebSocket and module handshake');
			const result = await appClient.reconnect();
			if (!alive.current) return;
			if (force && !result.debuggerReady && !Number.isInteger(window.__tizenBrewDebugPort)) {
				setNotice(prefix + ' App connected. Debugger initialization requested.');
				if (!appClient.send({ type: Events.CanLaunchInDebug })) {
					throw new Error('App connection closed before debugger initialization could be requested');
				}
				return;
			}
			setNotice(prefix + (result.debuggerReady ? ' App connected; module debugger ready.' :
				' App connected; modules loaded, but debugger is not ready.'));
			uiDiagnostics.record(result.debuggerReady ? 'info' : 'warning',
				'App reconnected; modules=' + appClient.modules.length + '; debuggerReady=' + result.debuggerReady +
				(result.error ? '; ' + result.error : ''));
		} catch (error) {
			if (!alive.current) return;
			setNotice(prefix + ' Service responds, but app reconnection failed: ' + error.message);
			uiDiagnostics.record('error', 'App reconnection failed: ' + error.message);
		}
	}

	async function check(manual = false) {
		if (manual) {
			if (manualPending.current) return;
			manualPending.current = true;
			setBusy(true);
			setStatus('Checking service...');
			while (running.current && alive.current) await new Promise(resolve => setTimeout(resolve, 50));
		} else if (running.current || manualPending.current) {
			return;
		}
		if (!alive.current) return;
		running.current = true;
		try {
			const snapshot = await client.current.check(cursor.current);
			if (alive.current) {
				setStatus(accept(snapshot));
				if (manual) await reconnectApp(false);
				await loadHistory(snapshot, manual);
			}
		} catch (error) {
			if (alive.current) {
				setStatus(error.message + ' (this does not prove the process stopped)');
				if (lastError.current !== error.message) uiDiagnostics.record('error', error.message);
				lastError.current = error.message;
			}
		} finally {
			running.current = false;
			if (manual) {
				manualPending.current = false;
				if (alive.current) setBusy(false);
			}
		}
	}

	async function restart() {
		if (manualPending.current) return;
		manualPending.current = true;
		setBusy(true);
		setNotice('');
		uiDiagnostics.record('info', 'Manual service recovery requested');
		setStatus('Waiting for the current service check...');
		while (running.current && alive.current) await new Promise(resolve => setTimeout(resolve, 50));
		if (!alive.current) return;
		running.current = true;
		try {
			const result = await client.current.restart(message => { if (alive.current) setStatus(message); });
			if (alive.current) {
				setStatus(accept(result.snapshot));
				uiDiagnostics.record('info', 'Manual recovery confirmed; session=' + result.snapshot.session);
				await reconnectApp(true, result.restarted ? 'Service restarted.' : 'Service started / reconnected.');
				await loadHistory(result.snapshot, true);
			}
		} catch (error) {
			if (alive.current) {
				setStatus(error.message);
				uiDiagnostics.record('error', 'Manual recovery failed: ' + error.message);
			}
		} finally {
			running.current = false;
			manualPending.current = false;
			if (alive.current) setBusy(false);
		}
	}

	useEffect(() => {
		alive.current = true;
		const unsubscribe = config.loggingEnabled ? uiDiagnostics.subscribe(incoming => {
			if (alive.current) setEntries(previous => mergeDiagnosticEntries(previous, incoming));
		}) : () => {};
		check();
		const timer = setInterval(() => check(), 2000);
		return () => { alive.current = false; unsubscribe(); clearInterval(timer); };
	}, []);
	useEffect(() => {
		const timer = setInterval(() => {
			if (lastReply) setAge(Math.floor((Date.now() - lastReply) / 1000));
		}, 1000);
		return () => clearInterval(timer);
	}, [lastReply]);

	return <FocusContext.Provider value={focusKey}>
	<section ref={ref} className={'tv-service-panel' + (config.loggingEnabled ? '' : ' tv-service-panel--compact')}
		aria-label={t(config.loggingEnabled ? 'diagnostics.title' : 'diagnostics.controlsTitle')}>
		<div className="tv-service-toolbar">
			<strong>{t(config.loggingEnabled ? 'diagnostics.title' : 'diagnostics.controlsTitle')}</strong>
			<Control name="service-check" disabled={busy} action={() => check(true)}>
				{t('diagnostics.check', { defaultValue: 'Check service' })}
			</Control>
			<Control name="service-restart" disabled={busy} action={restart}>
				{t('diagnostics.restart', { defaultValue: 'Restart service' })}
			</Control>
			<span>{age === null ? t('diagnostics.noReply', { defaultValue: 'No reply yet' }) :
				t('diagnostics.lastReply', { defaultValue: 'Last reply {{seconds}}s ago', seconds: age })}</span>
			{config.loggingEnabled && <span>{entries.length} records / all sources / 2 MiB view limit</span>}
		</div>
		<div className="tv-service-status" role="status" title={notice + ' ' + status + (config.loggingEnabled ? ' - ' + historyStatus : '')}>
			{notice} {status}{config.loggingEnabled ? ' - ' + historyStatus : ''}
		</div>
		{config.loggingEnabled && <LogHistory entries={entries} t={t} />}
	</section>
	</FocusContext.Provider>;
}
