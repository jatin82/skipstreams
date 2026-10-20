import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "debug_build", Path(__file__).with_name("build-debug-tizenbrew.py")
)
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BootstrapTests(unittest.TestCase):
    def test_debug_app_has_distinct_app_and_service_ids(self):
        original = ('<widget><tizen:application id="xvvl3S1bvH.TizenBrewStandalone" package="xvvl3S1bvH"/>'
                    '<tizen:service id="xvvl3S1bvH.StandaloneService"/>'
                    '<name>TizenBrewNextGeneration</name></widget>')
        result = build.debug_app_manifest(original)
        self.assertIn('id="TBDebug001.TizenBrewStandalone" package="TBDebug001"', result)
        self.assertIn('id="TBDebug001.StandaloneService"', result)
        self.assertIn("<name>TB-Debug</name>", result)
        self.assertNotIn("xvvl3S1bvH", result)
        with self.assertRaises(ValueError):
            build.debug_app_manifest(original.replace("TizenBrewNextGeneration", "Unexpected"))

    def test_github_prefix_is_editable_and_incomplete_default_is_rejected(self):
        form = """function AddModule() {
    const [name, setName] = useState('');
    const loc = useLocation();
        if (!state.client || state.client.socket.readyState !== 1) {
            return;
        }
        ref.current.focus();
    }, [ref]);
}"""
        result = build.prefill_module_form(form)
        self.assertIn("loc.query.type === 'gh' ? 'jatin82/skipstreams@' : ''", result)
        self.assertIn("useState(defaultPrefix)", result)
        self.assertIn("moduleName === defaultPrefix", result)
        self.assertIn("moduleManager.completeGitHubRef", result)
        self.assertIn("setSelectionRange(end, end)", result)
        self.assertLess(result.index("useLocation()"), result.index("useState(defaultPrefix)"))
        self.assertLess(result.index("moduleName === defaultPrefix"), result.index("!state.client"))
        with self.assertRaises(ValueError):
            build.prefill_module_form(form.replace("const loc = useLocation();", "const loc = other();"))

    def test_ui_panel_preserves_routes_and_reports_service_errors_without_reload_loops(self):
        app = """import './components/i18n.js';
calc(100vh - ${headerHeight}px)
<Router>existing routes</Router></LocationProvider>
startService(context);
function startService(context) {
tizen.application.launchAppControl();
}"""
        client = """constructor(context) {
this.socket = new WebSocket('ws://localhost:8081');
this.socket.onerror = () => location.reload();
}
    onOpen() {
switch (type) { existing events }
}
send(data) { this.socket.send(JSON.stringify(data)); }
this.send({type: Events.LaunchModule, payload: module});
this.send({type: Events.LaunchModule, payload: module});"""
        app, client = build.patch_ui_sources(app, client)
        self.assertIn("<ServicePanel />", app)
        self.assertIn("existing routes", app)
        self.assertIn("loggingEnabled ? '27vh' : '100px'", app)
        self.assertIn("connectExistingService(context)", app)
        self.assertIn("new Client(context)", app)
        self.assertNotIn("launchAppControl", app)
        self.assertNotIn("location.reload()", app)
        self.assertIn("case Events.Error:", client)
        self.assertIn("this.socket.onclose", client)
        self.assertIn("tizen.websetting.setUserAgentString", client)
        self.assertLess(client.index("tizen.websetting.setUserAgentString"), client.index("this.socket.send(JSON.stringify(data))"))
        self.assertIn("Could not configure module browser user agent", client)
        self.assertIn("reconnectClient(this)", client)
        self.assertIn("!this.debuggerReady", client)
        self.assertEqual(client.count("if (!this.send({type: Events.LaunchModule"), 2)
        self.assertNotIn("location.reload()", client)

    def test_debugger_recovery_wiring_preserves_status_and_existing_retry_behavior(self):
        service = "wsServer.on('connection', handler);\ncase Events.GetDebugStatus: existingStatus();"
        wired = build.wire_debugger_recovery(service, "module.exports = createRecovery;")
        self.assertIn("case 11:", wired)
        self.assertIn("existingStatus();", wired)
        self.assertIn("currentModule, inDebug, appControlData, false, 1", wired)
        call = "startDebugging(port, queuedEvents, clientConn, ip, mdl, inDebug, appControlData, isAnotherApp, attempts)"
        failure = "clientConn.send(clientConn.Event(Events.Error, 'Failed to connect to the debugger'));"
        source = "function " + call + " {\nif (!isAnotherApp) inDebug.webDebug = true;\n" + (call + ";" + failure) * 2 + "}"
        result = build.add_debugger_completion(source)
        self.assertEqual(result.count("attempts, onReady)"), 3)
        self.assertIn("completed(null)", result)
        self.assertEqual(result.count("failed(new Error"), 2)
        self.assertNotIn("clientConn.send", result)

    def test_device_api_fix_replaces_startup_and_response_in_source_and_bundle(self):
        for declaration, callback in [("let", "res => res.json()"),
                                      ("var", "function (res) { return res.json(); }")]:
            source = f"""{declaration} canLaunchInDebug = null;
fetch('http://127.0.0.1:8001/api/v2/').then({callback});
const inDebug = {{}};
switch (type) {{
case Events.CanLaunchInDebug: {{
fetch('http://127.0.0.1:8001/api/v2/').then({callback});
wsConn.send(wsConn.Event(Events.CanLaunchInDebug, canLaunchInDebug));
break;
}}
case Events.ReLaunchInDebug: {{ existingLaunch(); break; }}
}}"""
            result = build.fix_device_info(source, "module.exports = createClient;")
            self.assertIn("deviceInfo.read().catch", result)
            self.assertIn("deviceInfo.reply(wsConn, Events)", result)
            self.assertIn("existingLaunch();", result)
            self.assertNotIn("canLaunchInDebug", result)
            with self.assertRaises(ValueError):
                build.fix_device_info(source.replace("case Events.CanLaunchInDebug:", "case Unexpected:"), "")

    def test_keeps_capability_detection_and_enables_modern_on_file_urls(self):
        prefix = 'import.meta.url;import("_").catch(()=>1);(async function*(){})().next();'
        guard = 'if(location.protocol!="file:"){window.__vite_is_modern_browser=true}'
        fallback = 'if(window.__vite_is_modern_browser)return;loadLegacy()'
        html = prefix + guard + "</script><script>" + fallback
        fixed = build.fix_ui_bootstrap(html)
        self.assertEqual(
            fixed, prefix + "window.__vite_is_modern_browser=true</script><script>" + fallback
        )

    def test_rejects_unexpected_or_duplicate_bootstrap(self):
        guard = 'if(location.protocol!="file:"){window.__vite_is_modern_browser=true}'
        for content in ("unrecognized HTML", guard + guard):
            with self.assertRaises(ValueError):
                build.fix_ui_bootstrap(content)

    def test_instruments_only_injection_downloads_and_cache_operations(self):
        snippet = "fetch(url);modulesCache.get(key);modulesCache.set(key,value);"
        source = "fetch(other);" + "client.Runtime.enable();" + snippet * 2 + "client.on('disconnect', cleanup);"
        result = build.instrument_injection(source)
        self.assertTrue(result.startswith("fetch(other);"))
        self.assertEqual(result.count("client.__tvDebugFetch(fetch, "), 2)
        self.assertEqual(result.count("client.__tvDebugCacheGet(modulesCache, "), 2)
        self.assertEqual(result.count("client.__tvDebugCacheSet(modulesCache, "), 2)
        with self.assertRaises(ValueError):
            build.instrument_injection("client.Runtime.enable();client.on('disconnect', cleanup);")

    def test_service_diagnostics_are_initialized_before_service_start(self):
        source = """module.exports.onStart = function () {
console.log('Service started');
var appControlData = {};
app.all('*', (req, res) => {
res.send(deviceIP);
});
wsServer.on('connection', (ws) => {
services.set('wsConn', wsConn);
});
function createAdbConnection(ip, mdl) {
startDebugging(port, queuedEvents, services, ip, mdl, inDebug, appControlData, false);
}
currentModule.fullName = mdl.fullName;
}"""
        result = build.instrument_service(source, "START_DIAGNOSTICS();")
        self.assertLess(result.index("START_DIAGNOSTICS"), result.index("console.log"))
        for marker in ["bindState", "Loopback SDB connection requested", "Module launch received",
                       "Attaching page debugger", "Service onStop", "handleRequest", "observeSocket"]:
            self.assertIn(marker, result)
        self.assertLess(result.index("handleRequest"), result.index("res.send"))
        self.assertLess(result.index("observeSocket"), result.index("services.set"))
        bundled = source.replace("(req, res) =>", "function (req, res)").replace(
            "(ws) =>", "function (ws)"
        )
        self.assertIn("handleRequest", build.instrument_service(bundled, "START_DIAGNOSTICS();"))
        with self.assertRaises(ValueError):
            build.instrument_service(source.replace("currentModule.fullName = mdl.fullName;", ""), "")
        with self.assertRaises(ValueError):
            build.instrument_service(source.replace("app.all(", "app.get("), "")


if __name__ == "__main__":
    unittest.main()
