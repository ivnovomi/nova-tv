//! One plugin, running: its own thread with its own QuickJS engine, so a slow
//! or broken plugin can't block NOVA or touch another plugin.
//!
//! The only way out of the engine is the `__nova` object installed here (the
//! SDK's host.ts talks to it). Limits: 32 MB of memory and 5 s of computation
//! per call (time spent waiting for the network doesn't count).

use super::http;
use super::manifest::{Manifest, API};
use super::storage::Storage;
use rquickjs::{Context, Ctx, Exception, Function, Object, Promise, Runtime};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const MEMORY: usize = 32 * 1024 * 1024;
const STACK: usize = 512 * 1024;
/// Computation allowed per call.
const JS_TIME: Duration = Duration::from_secs(5);
/// How long NOVA waits for a call in total (computation plus network).
const CALL_LIMIT: Duration = Duration::from_secs(60);
const LOG_LINES: usize = 200;

/// Installed first: `console` for convenience and the function NOVA calls into the plugin.
const BOOTSTRAP: &str = r#"
const __fmt = (parts) => parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
globalThis.console = {
  log: (...p) => __nova.log("info", __fmt(p)),
  info: (...p) => __nova.log("info", __fmt(p)),
  warn: (...p) => __nova.log("warn", __fmt(p)),
  error: (...p) => __nova.log("error", __fmt(p)),
};
globalThis.__novaCall = async (part, fn, args) => {
  const target = globalThis.__novaPlugin && globalThis.__novaPlugin[part];
  if (!target || typeof target[fn] !== "function") throw new Error(`El plugin no tiene ${part}.${fn}()`);
  const result = await target[fn](...JSON.parse(args));
  return JSON.stringify(result === undefined ? null : result);
};
"#;

#[derive(Serialize, Clone, Debug)]
pub struct LogLine {
    pub at: u64,
    pub level: String,
    pub message: String,
}

/// What the running plugin shares with NOVA.
pub struct Env {
    pub manifest: Manifest,
    pub storage: Storage,
    /// Values the user chose in Ajustes → Plugins (JSON by key).
    pub settings: Mutex<serde_json::Map<String, serde_json::Value>>,
    pub log: Mutex<VecDeque<LogLine>>,
    deadline: Mutex<Instant>,
    /// The (opaque) profile of the call in progress, for `storage.profile`.
    profile: Mutex<Option<String>>,
    /// When its last notices were shown (for the limit).
    notices: Mutex<VecDeque<Instant>>,
    /// Under `nova dev`: the file its log is copied to (the developer's terminal reads it).
    pub tee: Option<std::path::PathBuf>,
}

impl Env {
    pub fn new(manifest: Manifest, storage: Storage) -> Self {
        Self {
            manifest,
            storage,
            settings: Mutex::new(Default::default()),
            log: Mutex::new(VecDeque::new()),
            deadline: Mutex::new(Instant::now() + JS_TIME),
            profile: Mutex::new(None),
            notices: Mutex::new(VecDeque::new()),
            tee: None,
        }
    }

    fn arm(&self) {
        *self.deadline.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now() + JS_TIME;
    }

    /// Network waits don't count as computation.
    fn extend(&self, by: Duration) {
        *self.deadline.lock().unwrap_or_else(|p| p.into_inner()) += by;
    }

    fn timed_out(&self) -> bool {
        Instant::now() > *self.deadline.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn push_log(&self, level: &str, message: &str) {
        let line = LogLine { at: crate::config::now_secs(), level: level.to_string(), message: message.chars().take(2000).collect() };
        if cfg!(debug_assertions) {
            eprintln!("[plugin {}] {}: {}", self.manifest.id, line.level, line.message);
        }
        if let Some(path) = &self.tee {
            super::dev::append_to(path, &line.level, &line.message);
        }
        let mut log = self.log.lock().unwrap_or_else(|p| p.into_inner());
        if log.len() >= LOG_LINES {
            log.pop_front();
        }
        log.push_back(line);
    }
}

struct Job {
    part: String,
    func: String,
    args: String,
    profile: Option<String>,
    reply: mpsc::Sender<Result<String, String>>,
}

/// A running plugin. Dropping it stops its thread.
pub struct Plugin {
    tx: Mutex<mpsc::Sender<Job>>,
    pub env: Arc<Env>,
    /// What it provides ("rows", "channels"…), with each part's refresh and functions.
    pub parts: std::collections::HashMap<String, Part>,
}

impl Plugin {
    /// Starts the engine and runs the plugin's code (its `defineProvider`).
    pub fn start(env: Arc<Env>, source: String) -> Result<Plugin, String> {
        let (tx, rx) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();
        let thread_env = env.clone();
        std::thread::Builder::new()
            .name(format!("plugin {}", env.manifest.id))
            .stack_size(4 * 1024 * 1024)
            .spawn(move || run(thread_env, source, rx, ready_tx))
            .map_err(|e| e.to_string())?;
        let described = ready_rx.recv_timeout(Duration::from_secs(15)).map_err(|_| "El plugin no arrancó a tiempo".to_string())??;
        let parts = serde_json::from_str(&described).map_err(|e| format!("El plugin no se describe bien: {e}"))?;
        Ok(Plugin { tx: Mutex::new(tx), env, parts })
    }

    /// Whether the plugin defines `part.func()` (e.g. channels.stream).
    pub fn has(&self, part: &str, func: &str) -> bool {
        self.parts.get(part).is_some_and(|p| p.functions.iter().any(|f| f == func))
    }

    /// `part`'s refresh text ("30m"), if the plugin set one.
    pub fn refresh(&self, part: &str) -> Option<&str> {
        self.parts.get(part).and_then(|p| p.refresh.as_deref())
    }

    /// Calls `part.func(...args)` in the plugin and waits for its (JSON) result.
    pub fn call(&self, part: &str, func: &str, args: serde_json::Value, profile: Option<String>) -> Result<serde_json::Value, String> {
        let (reply, answer) = mpsc::channel();
        let job = Job { part: part.into(), func: func.into(), args: args.to_string(), profile, reply };
        self.tx.lock().map_err(|e| e.to_string())?.send(job).map_err(|_| "El plugin se ha detenido".to_string())?;
        let text = answer.recv_timeout(CALL_LIMIT).map_err(|_| "El plugin no respondió a tiempo".to_string())??;
        serde_json::from_str(&text).map_err(|e| format!("El plugin devolvió datos no válidos: {e}"))
    }
}

/// `{ "rows": { "refresh": "30m", "functions": ["load"] }, … }`: what the plugin defined.
const DESCRIBE: &str = r#"JSON.stringify(Object.fromEntries(Object.entries(globalThis.__novaPlugin)
  .filter(([, v]) => v && typeof v === "object")
  .map(([k, v]) => [k, {
    refresh: typeof v.refresh === "string" ? v.refresh : null,
    functions: Object.keys(v).filter((f) => typeof v[f] === "function"),
  }])))"#;

/// One part of a plugin ("rows", "channels"…): its refresh and the functions it has.
#[derive(serde::Deserialize, Debug, Clone)]
pub struct Part {
    pub refresh: Option<String>,
    pub functions: Vec<String>,
}

fn run(env: Arc<Env>, source: String, jobs: mpsc::Receiver<Job>, ready: mpsc::Sender<Result<String, String>>) {
    let runtime = match Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            let _ = ready.send(Err(e.to_string()));
            return;
        }
    };
    runtime.set_memory_limit(MEMORY);
    runtime.set_max_stack_size(STACK);
    let watch = env.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || watch.timed_out())));
    let context = match Context::full(&runtime) {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(e.to_string()));
            return;
        }
    };

    let loaded = context.with(|ctx| {
        env.arm();
        install(&ctx, &env).map_err(|e| describe(&ctx, &env, e))?;
        ctx.eval::<(), _>(BOOTSTRAP).map_err(|e| describe(&ctx, &env, e))?;
        ctx.eval::<(), _>(source).map_err(|e| describe(&ctx, &env, e))?;
        let defined: bool = ctx.globals().get::<_, Object>("__novaPlugin").is_ok();
        if !defined {
            return Err("El plugin no llama a defineProvider()".to_string());
        }
        ctx.eval::<String, _>(DESCRIBE).map_err(|e| describe(&ctx, &env, e))
    });
    let ok = loaded.is_ok();
    let _ = ready.send(loaded);
    if !ok {
        return;
    }

    for job in jobs {
        env.arm();
        *env.profile.lock().unwrap_or_else(|p| p.into_inner()) = job.profile.clone();
        let result = context.with(|ctx| {
            let call: Function = ctx.globals().get("__novaCall").map_err(|e| describe(&ctx, &env, e))?;
            let promise: Promise = call.call((job.part.as_str(), job.func.as_str(), job.args.as_str())).map_err(|e| describe(&ctx, &env, e))?;
            promise.finish::<String>().map_err(|e| describe(&ctx, &env, e))
        });
        if let Err(e) = &result {
            env.push_log("error", &format!("{}.{}(): {e}", job.part, job.func));
        }
        let _ = job.reply.send(result);
    }
}

/// A readable message for an engine error (the plugin's own Error message when there is one).
fn describe(ctx: &Ctx<'_>, env: &Env, error: rquickjs::Error) -> String {
    if env.timed_out() {
        return "El plugin tardó demasiado (más de 5 s calculando)".into();
    }
    match error {
        rquickjs::Error::Exception => {
            let value = ctx.catch();
            let text = if let Some(exc) = value.as_exception() {
                exc.message().unwrap_or_else(|| "Error".into())
            } else if let Some(s) = value.as_string() {
                s.to_string().unwrap_or_default()
            } else {
                ctx.json_stringify(value).ok().flatten().and_then(|s| s.to_string().ok()).unwrap_or_else(|| "Error".into())
            };
            if text.contains("out of memory") {
                "El plugin se quedó sin memoria (máximo 32 MB)".into()
            } else {
                text
            }
        }
        rquickjs::Error::WouldBlock => "El plugin se quedó esperando algo que no llega (¿un await sin resolver?)".into(),
        other => other.to_string(),
    }
}

/// `__nova`: what the plugin can ask of NOVA. Every function checks permissions.
fn install<'js>(ctx: &Ctx<'js>, env: &Arc<Env>) -> rquickjs::Result<()> {
    let nova = Object::new(ctx.clone())?;
    nova.set("api", API)?;

    let e = env.clone();
    nova.set(
        "http",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, request: String| -> rquickjs::Result<Promise<'js>> {
            let (promise, resolve, reject) = Promise::new(&ctx)?;
            let started = Instant::now();
            let result = serde_json::from_str::<http::Request>(&request).map_err(|err| format!("Petición no válida: {err}")).and_then(|r| http::fetch(&e.manifest, r));
            e.extend(started.elapsed());
            match result {
                Ok(response) => resolve.call::<_, ()>((serde_json::to_string(&response).unwrap_or_default(),))?,
                Err(message) => reject.call::<_, ()>((Exception::from_message(ctx.clone(), &message)?,))?,
            }
            Ok(promise)
        })?,
    )?;

    let profile_of = |ctx: &Ctx<'js>, env: &Env, scope: &str| -> rquickjs::Result<Option<String>> {
        match scope {
            "plugin" => Ok(None),
            "profile" => match env.profile.lock().ok().and_then(|p| p.clone()) {
                Some(p) => Ok(Some(p)),
                None => Err(Exception::throw_message(ctx, "storage.profile solo se puede usar dentro de una llamada de NOVA")),
            },
            _ => Err(Exception::throw_message(ctx, "Ámbito de almacenamiento no válido")),
        }
    };

    let e = env.clone();
    nova.set(
        "storageGet",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, scope: String, key: String| -> rquickjs::Result<Option<String>> {
            let profile = profile_of(&ctx, &e, &scope)?;
            Ok(e.storage.get(profile.as_deref(), &key))
        })?,
    )?;
    let e = env.clone();
    nova.set(
        "storageSet",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, scope: String, key: String, value: String| -> rquickjs::Result<()> {
            let profile = profile_of(&ctx, &e, &scope)?;
            e.storage.set(profile.as_deref(), &key, &value).map_err(|m| Exception::throw_message(&ctx, &m))
        })?,
    )?;
    let e = env.clone();
    nova.set(
        "storageDelete",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, scope: String, key: String| -> rquickjs::Result<()> {
            let profile = profile_of(&ctx, &e, &scope)?;
            e.storage.delete(profile.as_deref(), &key).map_err(|m| Exception::throw_message(&ctx, &m))
        })?,
    )?;

    let e = env.clone();
    nova.set(
        "setting",
        Function::new(ctx.clone(), move |key: String| -> Option<String> {
            let chosen = e.settings.lock().ok().and_then(|s| s.get(&key).cloned());
            chosen.or_else(|| e.manifest.default_setting(&key)).map(|v| v.to_string())
        })?,
    )?;

    let e = env.clone();
    nova.set(
        "location",
        Function::new(ctx.clone(), move |ctx: Ctx<'js>| -> rquickjs::Result<Option<String>> {
            if !e.manifest.permissions.location {
                return Err(Exception::throw_message(&ctx, "El plugin no tiene el permiso «location»"));
            }
            // The city the user chose in NOVA, never GPS or IP; coordinates rounded to about 10 km.
            let place = super::tv::app().and_then(|app| {
                use tauri::Manager;
                app.state::<crate::AppState>().config.snapshot().location
            });
            let round = |x: f64| (x * 10.0).round() / 10.0;
            Ok(place.map(|p| serde_json::json!({ "city": p.city, "country": p.country, "latitude": round(p.latitude), "longitude": round(p.longitude) }).to_string()))
        })?,
    )?;

    let e = env.clone();
    nova.set(
        "notify",
        // `Opt`: the detail can be left out (a plain Option would still be required).
        Function::new(ctx.clone(), move |ctx: Ctx<'js>, title: String, detail: rquickjs::function::Opt<String>| -> rquickjs::Result<()> {
            let detail = detail.0;
            if !e.manifest.permissions.notify {
                return Err(Exception::throw_message(&ctx, "El plugin no tiene el permiso «notify»"));
            }
            // At most 3 notices a minute per plugin: more are dropped, not queued.
            let now = Instant::now();
            let mut sent = e.notices.lock().unwrap_or_else(|p| p.into_inner());
            sent.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
            if sent.len() >= 3 {
                e.push_log("warn", "Aviso descartado: máximo 3 por minuto");
                return Ok(());
            }
            sent.push_back(now);
            let clean = |s: &str, max: usize| s.trim().chars().filter(|c| !c.is_control()).take(max).collect::<String>();
            let title = clean(&title, 80);
            if title.is_empty() {
                return Err(Exception::throw_message(&ctx, "El aviso necesita un título"));
            }
            if let Some(app) = super::tv::app() {
                use tauri::Emitter;
                let detail = detail.map(|d| clean(&d, 200)).filter(|d| !d.is_empty());
                let _ = app.emit("plugin-notify", serde_json::json!({ "plugin": e.manifest.name, "title": title, "detail": detail }));
            }
            Ok(())
        })?,
    )?;

    let e = env.clone();
    nova.set(
        "log",
        Function::new(ctx.clone(), move |level: String, message: String| {
            let level = if matches!(level.as_str(), "warn" | "error") { level } else { "info".to_string() };
            e.push_log(&level, &message);
        })?,
    )?;

    ctx.globals().set("__nova", nova)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(code: &str) -> Result<Plugin, String> {
        let manifest: Manifest = serde_json::from_value(serde_json::json!({
            "id": "es.ejemplo.prueba", "name": "Prueba", "version": "1.0.0", "api": 1, "kind": ["provider"],
            "main": "dist/index.js", "description": "Un plugin de prueba.", "author": { "name": "Yo" },
            "audience": "everyone", "permissions": { "network": ["api.ejemplo.es"], "rows": true },
            "settings": [{ "key": "city", "type": "text", "label": "Ciudad", "default": "Madrid" }]
        }))
        .unwrap();
        let dir = std::env::temp_dir().join(format!("nova-plugin-rt-{}-{}", std::process::id(), code.len()));
        let _ = std::fs::remove_dir_all(&dir);
        Plugin::start(Arc::new(Env::new(manifest, Storage::new(dir))), code.to_string())
    }

    #[test]
    fn calls_into_the_plugin() {
        let p = plugin(
            r#"globalThis.__novaPlugin = { rows: { async load(ctx) {
                 __nova.storageSet("profile", "visto", "true");
                 const city = JSON.parse(__nova.setting("city"));
                 return [{ title: `Hola ${city} (${ctx.profile.kids ? "niños" : "adultos"})`, items: [] }];
               } } };"#,
        )
        .unwrap();
        let ctx = serde_json::json!({ "profile": { "id": "p1", "kids": false }, "locale": "es-ES" });
        let rows = p.call("rows", "load", serde_json::json!([ctx]), Some("p1".into())).unwrap();
        assert_eq!(rows[0]["title"], "Hola Madrid (adultos)");
        assert_eq!(p.env.storage.get(Some("p1"), "visto").as_deref(), Some("true"));
    }

    #[test]
    fn reports_plugin_errors() {
        let p = plugin(r#"globalThis.__novaPlugin = { rows: { async load() { throw new Error("sin datos"); } } };"#).unwrap();
        assert_eq!(p.call("rows", "load", serde_json::json!([]), None).unwrap_err(), "sin datos");
        assert!(p.call("rows", "nada", serde_json::json!([]), None).unwrap_err().contains("rows.nada"));
        assert!(plugin("const x = 1;").err().unwrap().contains("defineProvider"));
        assert!(plugin("esto no es JavaScript (").is_err());
    }

    #[test]
    fn notices_and_location_need_their_permission() {
        let p = plugin(
            r#"globalThis.__novaPlugin = { rows: { async load() {
                 const out = [];
                 for (const f of [() => __nova.notify("Hola"), () => __nova.location()]) {
                   try { f(); out.push("permitido"); } catch (e) { out.push(e.message); }
                 }
                 return out;
               } } };"#,
        )
        .unwrap();
        let out = p.call("rows", "load", serde_json::json!([]), None).unwrap();
        assert!(out[0].as_str().unwrap().contains("notify"), "{out}");
        assert!(out[1].as_str().unwrap().contains("location"), "{out}");
    }

    #[test]
    fn network_is_checked() {
        let p = plugin(
            r#"globalThis.__novaPlugin = { rows: { async load() {
                 try { await __nova.http(JSON.stringify({ url: "https://otro.es/" })); return "fue"; }
                 catch (e) { return e.message; }
               } } };"#,
        )
        .unwrap();
        let message = p.call("rows", "load", serde_json::json!([]), None).unwrap();
        assert!(message.as_str().unwrap().contains("otro.es"), "{message}");
    }

    /// The example plugin, built with the real SDK (`npm run plugin:build -- plugins/ejemplo`).
    #[test]
    #[ignore = "needs the example plugin built with npm"]
    fn runs_a_plugin_built_with_the_sdk() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/ejemplo");
        let manifest = Manifest::read(&dir).unwrap();
        let source = std::fs::read_to_string(dir.join(&manifest.main)).unwrap();
        let data = std::env::temp_dir().join(format!("nova-plugin-ejemplo-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let p = Plugin::start(Arc::new(Env::new(manifest, Storage::new(data.clone()))), source).unwrap();
        let ctx = serde_json::json!({ "profile": { "id": "p1", "kids": true }, "locale": "es-ES" });
        for visits in ["1 visita", "2 visitas"] {
            let rows = p.call("rows", "load", serde_json::json!([ctx]), Some("p1".into())).unwrap();
            assert_eq!(rows[0]["items"][0]["title"], "¡Hola!");
            assert_eq!(rows[0]["items"][0]["subtitle"], "Perfil infantil");
            assert_eq!(rows[0]["items"][1]["title"], visits);
        }
        assert!(p.env.log.lock().unwrap().iter().any(|l| l.message.contains("Cargando la fila")));
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn limits_time_and_memory() {
        let p = plugin(r#"globalThis.__novaPlugin = { rows: { async load() { while (true) {} } } };"#).unwrap();
        assert!(p.call("rows", "load", serde_json::json!([]), None).unwrap_err().contains("tardó demasiado"));
        let p = plugin(r#"globalThis.__novaPlugin = { rows: { async load() { const a = []; while (true) a.push("x".repeat(1e6)); } } };"#).unwrap();
        let err = p.call("rows", "load", serde_json::json!([]), None).unwrap_err();
        assert!(err.contains("memoria") || err.contains("tardó"), "{err}");
    }
}
