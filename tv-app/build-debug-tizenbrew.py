"""Patch the existing custom TizenBrew package without changing its UI or modules."""

import json
import os
import re
from pathlib import Path
import secrets
import subprocess
import zipfile


ROOT = Path(__file__).resolve().parent
BASE = ROOT / "dist" / "tizenbrew" / "module-button" / "signed" / "TizenBrew-ModuleButton.wgt"
OUT = ROOT / "dist" / "tizenbrew" / "debug-logs"
FORWARDER = ROOT / "tizenbrew-log-forwarder.js"
SERVICE_DIAGNOSTICS = ROOT / "tizenbrew-service-diagnostics.js"
DEVICE_INFO = ROOT / "tizenbrew-device-info.js"
DEBUGGER_RECOVERY = ROOT / "tizenbrew-debugger-recovery.js"


def factory(source):
    return "(function () { var module = {exports: {}};\n" + source + "\nreturn module.exports; }())"


def replace_once(content, marker, replacement):
    if content.count(marker) != 1:
        raise ValueError(f"Expected exactly one service hook: {marker}")
    return content.replace(marker, replacement)


def fix_device_info(content, source):
    start = re.search(r"(?:let|var) canLaunchInDebug = null;", content)
    if start is None:
        raise ValueError("Expected device-info startup check")
    end = re.search(r"(?:const|var) inDebug = \{", content[start.end():])
    if end is None:
        raise ValueError("Expected debugger state after device-info startup check")
    end = start.end() + end.start()
    startup = content[start.start():end]
    if startup.count("fetch('http://127.0.0.1:8001/api/v2/')") != 1:
        raise ValueError("Unexpected device-info startup request")
    content = content[:start.start()] + (
        "var deviceInfo = " + factory(source) + "(fetch, global.__ptServiceDiagnostics.report);\n"
        "deviceInfo.read().catch(function (error) {\n"
        "global.__ptServiceDiagnostics.report('error', 'Startup device-info check failed: ' + error.message);\n"
        "});\n"
    ) + content[end:]
    start = content.index("case Events.CanLaunchInDebug:")
    end = content.index("case Events.ReLaunchInDebug:", start)
    if content[start:end].count("fetch('http://127.0.0.1:8001/api/v2/')") != 1:
        raise ValueError("Unexpected device-info response handler")
    content = content[:start] + (
        "case Events.CanLaunchInDebug: {\n"
        "deviceInfo.reply(wsConn, Events);\n"
        "break;\n}\n"
    ) + content[end:]
    if "canLaunchInDebug" in content.replace(factory(source), ""):
        raise ValueError("Unexpected remaining cached device-info reference")
    return content


def instrument_service(content, startup):
    if "module.exports.onStop" in content:
        raise ValueError("Unexpected existing service onStop hook")
    content = replace_once(
        content, "module.exports.onStart = function () {",
        "module.exports.onStop = function () {\n"
        "if (global.__ptServiceDiagnostics) global.__ptServiceDiagnostics.report('info', 'Service onStop');\n"
        "};\nmodule.exports.onStart = function () {",
    )
    content = replace_once(
        content, "module.exports.onStart = function () {",
        "module.exports.onStart = function () {\n" + startup,
    )
    content = replace_once(content, "function createAdbConnection(ip, mdl) {",
        "function createAdbConnection(ip, mdl) {\n"
        "global.__ptServiceDiagnostics.report('info', 'Loopback SDB connection requested; target=' + ip);")
    content = replace_once(content, "currentModule.fullName = mdl.fullName;",
        "global.__ptServiceDiagnostics.report('info', 'Module launch received; module=' + mdl.fullName + "
        "'; URL=' + mdl.appPath + '; script=' + mdl.mainFile);\ncurrentModule.fullName = mdl.fullName;")
    content = replace_once(content,
        "startDebugging(port, queuedEvents, services, ip, mdl, inDebug, appControlData, false);",
        "global.__ptServiceDiagnostics.report('info', 'Attaching page debugger; port=' + port + '; IP=' + ip);\n"
        "startDebugging(port, queuedEvents, services, ip, mdl, inDebug, appControlData, false);")
    content, count = re.subn(r"((?:const|var) appControlData = \{)",
        "global.__ptServiceDiagnostics.bindState(function () { return {module: currentModule.fullName || '', "
        "debug: inDebug, deviceApi: deviceInfo.getStatus(), uiSocket: services.get('wsConn') && services.get('wsConn').connection && "
        "services.get('wsConn').connection.readyState}; });\n" + r"\1", content)
    if count != 1:
        raise ValueError("Expected one service-state binding")
    for pattern, hook in [
        (r"(app\.all\('\*', (?:\(req, res\) =>|function \(req, res\)) \{)",
         "if (global.__ptServiceDiagnostics.handleRequest(req, res)) return;"),
        (r"(wsServer\.on\('connection', (?:\(ws\) =>|function \(ws\)) \{)",
         "global.__ptServiceDiagnostics.observeSocket(ws);"),
    ]:
        content, count = re.subn(pattern, lambda match: match[1] + "\n" + hook, content)
        if count != 1:
            raise ValueError("Expected one local diagnostic route/socket hook")
    return content


def fix_ui_bootstrap(content):
    marker = 'if(location.protocol!="file:"){window.__vite_is_modern_browser=true}'
    if content.count(marker) != 1:
        raise ValueError("Expected exactly one file-protocol modern-browser guard")
    return content.replace(marker, "window.__vite_is_modern_browser=true")


def wire_debugger_recovery(content, source):
    binding = (
        "var recoverDebugger = " + factory(source) + "(fetch, function (port) {\n"
        "if (inDebug.webDebug || inDebug.rwiDebug) return Promise.resolve();\n"
        "return new Promise(function (resolve, reject) {\n"
        "startDebugging(port, queuedEvents, services, '127.0.0.1', currentModule, inDebug, appControlData, false, 1, "
        "function (error) { if (error) reject(error); else resolve(); });\n"
        "});\n}, global.__ptServiceDiagnostics.report);\n"
    )
    content = replace_once(content, "wsServer.on('connection'", binding + "wsServer.on('connection'")
    return replace_once(content, "case Events.GetDebugStatus:",
        "case 11: {\n"
        "var respondToRecovery = function (payload) {\n"
        "if (ws.readyState === 1) wsConn.send(wsConn.Event(11, payload));\n"
        "else global.__ptServiceDiagnostics.report('warning', 'Debugger recovery reply skipped: UI socket closed');\n"
        "};\n"
        "recoverDebugger(payload && payload.port).then(function () {\n"
        "respondToRecovery({ok: true, debug: inDebug});\n"
        "}, function (error) {\n"
        "respondToRecovery({ok: false, error: String(error && error.message || error)});\n"
        "}).catch(function (error) {\n"
        "global.__ptServiceDiagnostics.report('error', 'Debugger recovery reply failed: ' + String(error));\n"
        "});\nbreak;\n}\ncase Events.GetDebugStatus:")


def add_debugger_completion(content):
    signature = "function startDebugging(port, queuedEvents, clientConn, ip, mdl, inDebug, appControlData, isAnotherApp, attempts) {"
    content = replace_once(content, signature, signature.replace("attempts)", "attempts, onReady)"))
    call = "startDebugging(port, queuedEvents, clientConn, ip, mdl, inDebug, appControlData, isAnotherApp, attempts)"
    if content.count(call) != 2:
        raise ValueError("Expected two debugger retry calls")
    content = content.replace(call, call[:-1] + ", onReady)")
    content = replace_once(content, "if (!isAnotherApp) inDebug.webDebug = true;",
        "if (!isAnotherApp) inDebug.webDebug = true;\n"
        "if (onReady) { var completed = onReady; onReady = null; completed(null); }")
    failure = "clientConn.send(clientConn.Event(Events.Error, 'Failed to connect to the debugger'));"
    if content.count(failure) != 2:
        raise ValueError("Expected two debugger failure branches")
    return content.replace(failure,
        "if (onReady) { var failed = onReady; onReady = null; failed(new Error('Failed to connect to the debugger')); }\n"
        "else sendClientInformation(clientConn, {type: Events.Error, payload: 'Failed to connect to the debugger'});")


def patch_ui_sources(app, client):
    app = replace_once(app, "import './components/i18n.js';",
                       "import './components/i18n.js';\n"
                       "import ServicePanel from './components/TizenBrewServicePanel.jsx';\n"
                       "import diagnosticsConfig from './components/tv-diagnostics-config.json';")
    app = replace_once(app, "calc(100vh - ${headerHeight}px)",
                       "calc(100vh - ${headerHeight}px - ${diagnosticsConfig.loggingEnabled ? '27vh' : '100px'})")
    app = replace_once(app, "</LocationProvider>", "<ServicePanel />\n      </LocationProvider>")
    start = app.index("\nfunction startService(context) {")
    service_start = app[start:]
    if service_start.count("\nfunction ") != 1 or service_start.count("launchAppControl") != 1:
        raise ValueError("Unexpected automatic service startup function")
    app = app[:start] + """
function connectExistingService(context) {
  context.dispatch({ type: 'SET_STATE', payload: 'diagnostics.manualStart' });
  context.dispatch({ type: 'SET_CLIENT', payload: new Client(context) });
}
"""
    app = replace_once(app, "startService(context);", "connectExistingService(context);")
    client = "import { reconnectClient } from './tizenbrew-ui-reconnect.mjs';\n" + client
    client = replace_once(client, "constructor(context) {", "constructor(context, deferConnect = false) {")
    client = replace_once(client, "this.socket = new WebSocket('ws://localhost:8081');",
                          "this.socket = null;\n        this.debuggerReady = false;\n        if (!deferConnect) {\n"
                          "        this.socket = new WebSocket('ws://localhost:8081');")
    client = replace_once(client, "this.socket.onerror = () => location.reload();",
                          "this.socket.onerror = () => this.connectionError('Service connection failed. Use Check service or Restart service.', true);\n"
                          "        this.socket.onclose = () => { this.debuggerReady = false; this.connectionError('Service connection closed. Use Check service or Restart service to reconnect.', true); };\n"
                          "        }")
    client = replace_once(client, "    onOpen() {",
                          "    reconnect() { return reconnectClient(this); }\n\n"
                          "    connectionError(message, connectionFailure = false) {\n"
                          "        if (connectionFailure) this.connectionErrorMessage = message;\n"
                          "        console.error('[TizenBrew UI] ' + message);\n"
                          "        this.context.dispatch({type: 'SET_ERROR', payload: {message, disappear: false}});\n"
                          "    }\n\n    onOpen() {\n"
                          "        this.context.dispatch({type: 'SET_STATE', payload: 'service.connected'});")
    client = replace_once(client, "switch (type) {",
                          "switch (type) {\n"
                          "            case Events.Error: {\n"
                          "                this.connectionError(String(payload));\n"
                          "                break;\n"
                          "            }")
    client = replace_once(client, "switch (type) {",
                          "if (type === Events.GetDebugStatus) this.debuggerReady = !!(payload && (payload.webDebug || payload.rwiDebug || payload.appDebug));\n"
                          "        if (type === Events.CanLaunchModules) this.debuggerReady = true;\n"
                          "        switch (type) {")
    client = replace_once(client, "this.socket.send(JSON.stringify(data));",
                          "if (!this.socket || this.socket.readyState !== 1) {\n"
                          "            this.connectionError('Service connection is not ready. Use Check service to reconnect.', true);\n"
                          "            return false;\n"
                          "        }\n"
                          "        if (data.type === Events.LaunchModule && !this.debuggerReady) {\n"
                          "            this.connectionError('The module debugger is not ready. Use Check service to recover it.');\n"
                          "            return false;\n"
                          "        }\n"
                          "        try { this.socket.send(JSON.stringify(data)); return true; }\n"
                          "        catch (error) { this.connectionError('Service send failed: ' + error.message, true); return false; }")
    client, count = re.subn(
        r"this\.send\(\{\s*type: Events\.LaunchModule,\s*payload: module\s*\}\);",
        "if (!this.send({type: Events.LaunchModule, payload: module})) return;", client)
    if count != 2:
        raise ValueError("Expected two automatic module navigation guards")
    return app, client


def prefill_module_form(form):
    form = replace_once(form,
        "    const [name, setName] = useState('');\n    const loc = useLocation();",
        "    const loc = useLocation();\n"
        "    const defaultPrefix = loc.query.type === 'gh' ? 'jatin82/skipstreams@' : '';\n"
        "    const [name, setName] = useState(defaultPrefix);")
    form = replace_once(form, "        if (!state.client || state.client.socket.readyState !== 1) {",
        "        if (loc.query.type === 'gh' && moduleName === defaultPrefix) {\n"
        "            ref.current.setCustomValidity(t('moduleManager.completeGitHubRef', {\n"
        "                defaultValue: 'Enter a version, tag, or commit after @, for example v1.4.0/hotstar.'\n"
        "            }));\n"
        "            ref.current.reportValidity();\n"
        "            return;\n"
        "        }\n"
        "        if (!state.client || state.client.socket.readyState !== 1) {")
    return replace_once(form, "        ref.current.focus();\n    }, [ref]);",
        "        ref.current.focus();\n"
        "        const end = ref.current.value.length;\n"
        "        ref.current.setSelectionRange(end, end);\n"
        "    }, [ref]);")


def build_ui(original, config):
    work = OUT / "ui"
    for name in original.namelist():
        if name.startswith("tizenbrew-ui/") and not name.endswith("/") and not name.startswith("tizenbrew-ui/dist/"):
            relative = Path(name.removeprefix("tizenbrew-ui/"))
            if ".." in relative.parts:
                raise ValueError("Unexpected UI archive path")
            target = work / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(original.read(name))
    subprocess.run(["git", "apply", "-p4", "--directory=" + str(work.relative_to(ROOT.parent)),
                    str(ROOT / "tizenbrew-module-button.patch")], cwd=ROOT.parent, check=True)
    app_name = "tizenbrew-ui/src/app.jsx"
    client_name = "tizenbrew-ui/src/components/WebSocketClient.js"
    app, client = patch_ui_sources(original.read(app_name).decode("utf-8"),
                                   original.read(client_name).decode("utf-8"))
    patched = {app_name: app.encode("utf-8"), client_name: client.encode("utf-8")}
    context_name = "tizenbrew-ui/src/components/ClientContext.jsx"
    context = original.read(context_name).decode("utf-8")
    context = replace_once(context, "        case 'SET_ERROR':",
                          "        case 'CLEAR_CONNECTION_ERROR':\n"
                          "            if (!action.payload || state.sharedData.error.message !== action.payload) return state;\n"
                          "            return { ...state, sharedData: { ...state.sharedData, error: { message: null, disappear: false } } };\n"
                          "        case 'SET_ERROR':")
    patched[context_name] = context.encode("utf-8")
    modules_name = "tizenbrew-ui/src/components/Modules.jsx"
    modules = original.read(modules_name).decode("utf-8")
    modules = replace_once(modules,
        "state.client.send({\n      type: Events.LaunchModule,\n      payload: module\n    });",
        "if (!state.client.send({\n      type: Events.LaunchModule,\n      payload: module\n    })) return;")
    patched[modules_name] = modules.encode("utf-8")
    patched["tizenbrew-ui/src/components/i18n.js"] = (ROOT / "tizenbrew-ui-i18n.js").read_bytes()
    manager = (work / "src" / "pages" / "ModuleManager.jsx").read_text(encoding="utf-8")
    start = manager.index("function AddModule()")
    form, count = re.subn(
        r"(state\.client\.send\(\{\s*type: Events\.(?:ModuleAction|GetModules),[\s\S]*?\n        \}\));",
        r"if (!\1) { submitted.current = false; return; }", manager[start:])
    if count != 2:
        raise ValueError("Expected module-add and refresh send guards")
    form = prefill_module_form(form)
    patched["tizenbrew-ui/src/pages/ModuleManager.jsx"] = (manager[:start] + form).encode("utf-8")
    if b"<form onSubmit={submit}" not in patched["tizenbrew-ui/src/pages/ModuleManager.jsx"]:
        raise ValueError("Custom Add module form was not preserved")
    for filename in ["TizenBrewServicePanel.jsx", "tizenbrew-service-controls.mjs", "tizenbrew-service-panel.css",
                     "tizenbrew-ui-diagnostics.mjs", "tizenbrew-ui-reconnect.mjs"]:
        patched["tizenbrew-ui/src/components/" + filename] = (ROOT / filename).read_bytes()
    patched["tizenbrew-ui/src/components/tv-ui-diagnostics-bootstrap.js"] = (
        "import { createUiDiagnostics } from './tizenbrew-ui-diagnostics.mjs';\n"
        "import config from './tv-diagnostics-config.json';\n"
        "export const uiDiagnostics = createUiDiagnostics(window, config.token, config.loggingEnabled);\n"
    ).encode("utf-8")
    main_name = "tizenbrew-ui/src/main.jsx"
    patched[main_name] = (b"import './components/tv-ui-diagnostics-bootstrap.js';\n" + original.read(main_name))
    patched["tizenbrew-ui/src/components/tv-diagnostics-config.json"] = json.dumps(
        {"token": config["token"], "loggingEnabled": config["loggingEnabled"]}
    ).encode("utf-8")
    for name, contents in patched.items():
        (work / name.removeprefix("tizenbrew-ui/")).write_bytes(contents)
    subprocess.run(["npm.cmd" if os.name == "nt" else "npm", "run", "build"], cwd=work, check=True)
    for filename in (work / "dist").rglob("*"):
        if filename.is_file():
            patched["tizenbrew-ui/dist/" + filename.relative_to(work / "dist").as_posix()] = filename.read_bytes()
    html_name = "tizenbrew-ui/dist/index.html"
    patched[html_name] = fix_ui_bootstrap(patched[html_name].decode("utf-8")).encode("utf-8")
    return patched


def instrument_injection(content):
    start = content.index("client.Runtime.enable();")
    end = content.index("client.on('disconnect'", start)
    section = content[start:end]
    replacements = {
        "fetch(": ("client.__tvDebugFetch(fetch, ", 2),
        "modulesCache.get(": ("client.__tvDebugCacheGet(modulesCache, ", 2),
        "modulesCache.set(": ("client.__tvDebugCacheSet(modulesCache, ", 2),
    }
    for marker, (replacement, count) in replacements.items():
        if section.count(marker) != count:
            raise ValueError(f"Expected {count} injection occurrences of {marker}")
        section = section.replace(marker, replacement)
    return content[:start] + section + content[end:]


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    config_path = OUT / "receiver.json"
    if config_path.exists():
        config = json.loads(config_path.read_text(encoding="utf-8"))
    else:
        config = {"host": "192.168.29.126", "port": 8087, "token": secrets.token_hex(32), "loggingEnabled": False}
        config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    if "loggingEnabled" not in config:
        config["loggingEnabled"] = False
        config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    if not isinstance(config["loggingEnabled"], bool):
        raise ValueError("loggingEnabled must be a boolean")
    if not isinstance(config.get("token"), str) or len(config["token"]) < 32:
        raise ValueError("Invalid receiver upload token")
    source = FORWARDER.read_text(encoding="utf-8")
    service_source = SERVICE_DIAGNOSTICS.read_text(encoding="utf-8")
    device_info_source = DEVICE_INFO.read_text(encoding="utf-8")
    debugger_recovery_source = DEBUGGER_RECOVERY.read_text(encoding="utf-8")
    startup = (
        "if (!global.__ptServiceDiagnostics) global.__ptServiceDiagnostics = "
        + factory(service_source) + "(" + json.dumps(config) + ", " + factory(source) + ");\n"
    )
    hook = (
        "if (!isAnotherApp) client.__tvDebugPort = port;\n"
        "(function () { var module = {exports: {}};\n"
        + source
        + "\nreturn module.exports; }())(client, mdl, "
        + json.dumps(config)
        + ", global.__ptServiceDiagnostics.record);\n"
    )
    targets = {
        "service-nextgen/service/utils/debugger.js",
        "service-nextgen/service/dist/index.js",
        "service-nextgen/service/index.js",
    }
    html_name = "tizenbrew-ui/dist/index.html"
    result = OUT / "TizenBrew-DebugLogs.wgt"
    with zipfile.ZipFile(BASE) as original:
        patched = build_ui(original, config)
        for name in targets:
            content = original.read(name).decode("utf-8")
            if name.endswith("/dist/index.js") or name.endswith("/utils/debugger.js"):
                content = add_debugger_completion(content)
                marker = "client.Runtime.enable();"
                if content.count(marker) != 1:
                    raise ValueError(f"Expected exactly one debugger initialization in {name}")
                content = instrument_injection(content)
                content = content.replace(marker, hook + marker)
                debugger_marker = "if (!attempts) attempts = 1;"
                content = replace_once(content, debugger_marker, debugger_marker +
                    "\nif (global.__ptServiceDiagnostics) global.__ptServiceDiagnostics.report('info', "
                    "'Debugger attempt=' + attempts + '; port=' + port + '; IP=' + ip);")
                content = replace_once(content, hook + marker,
                    "if (global.__ptServiceDiagnostics) global.__ptServiceDiagnostics.report('info', "
                    "'Page debugger connected; port=' + port);\n" + hook + marker)
                content, error_count = re.subn(
                    r"(\}\)\.on\('error', (?:\(err\) =>|function \(err\)) \{)",
                    r"\1" + "\nif (global.__ptServiceDiagnostics) global.__ptServiceDiagnostics.report('error', "
                    "'Page debugger connection failed: ' + String(err && err.stack || err));",
                    content,
                )
                if error_count != 1:
                    raise ValueError("Expected one debugger connection error hook")
            if name.endswith("/index.js"):
                content = fix_device_info(content, device_info_source)
                content = instrument_service(content, startup)
                content = wire_debugger_recovery(content, debugger_recovery_source)
            check = subprocess.run(
                ["node", "--check"], input=content, text=True, encoding="utf-8",
                capture_output=True, check=False
            )
            if check.returncode:
                raise ValueError(f"Patched JavaScript failed syntax check: {name}\n{check.stderr}")
            patched[name] = content.encode("utf-8")
        with zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as output:
            for info in original.infolist():
                if info.filename in {"author-signature.xml", "signature1.xml"}:
                    continue
                if info.filename.startswith("tizenbrew-ui/dist/"):
                    continue
                output.writestr(info, patched.get(info.filename, original.read(info.filename)))
            for name, contents in patched.items():
                if name.startswith("tizenbrew-ui/dist/") or name not in original.namelist():
                    output.writestr(name, contents)
    with zipfile.ZipFile(result) as output, zipfile.ZipFile(BASE) as original:
        if output.testzip() is not None:
            raise ValueError("Generated widget ZIP failed integrity check")
        for name in original.namelist():
            if name not in patched and not name.startswith("tizenbrew-ui/dist/") and name not in {"author-signature.xml", "signature1.xml"}:
                if output.read(name) != original.read(name):
                    raise ValueError(f"Unexpected package change: {name}")
    print(f"Built and verified: {result}")
    print("Next: sign the widget with Monitor32 before installing.")


if __name__ == "__main__":
    build()
