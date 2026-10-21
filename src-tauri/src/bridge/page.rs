//! A small page NovaBridge serves only to this PC (from its tray menu):
//! connect NovaBridge with Sunshine's user, change Sunshine's password, or
//! make up an easy one. It needs a token that only the tray menu knows.

use super::sunshine;
use std::io::Read;
use std::sync::OnceLock;
use tiny_http::{Header, Method, Request, Response};

const MAX_FORM: u64 = 4096;
const MIN_PASSWORD: usize = 8;

fn token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| super::hex(&super::random::<16>()))
}

/// What the tray menu opens.
pub fn url() -> String {
    format!("http://127.0.0.1:{}/sunshine?t={}", super::proto::HTTP_PORT, token())
}

fn local(from: &str) -> bool {
    matches!(from, "127.0.0.1" | "::1" | "::ffff:127.0.0.1")
}

/// `a=1&b=dos+palabras` → value of `key`.
fn field(form: &str, key: &str) -> String {
    form.split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| decode(v))
        .unwrap_or_default()
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                (Some(hi), Some(lo)) => {
                    out.push(hi << 4 | lo);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn html(request: Request, status: u16, body: String) {
    let response = Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", "text/html; charset=utf-8"))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Frame-Options", "DENY"))
        .with_header(header("Referrer-Policy", "no-referrer"))
        .with_header(header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"));
    let _ = request.respond(response);
}

enum Notice {
    None,
    Good(String),
    Bad(String),
}

pub fn handle(mut request: Request, from: &str) {
    if !local(from) {
        return html(request, 403, "Solo desde este PC.".into());
    }
    let query = request.url().split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
    let notice = match request.method() {
        Method::Get => {
            if field(&query, "t") != token() {
                return html(request, 403, "Abre esta página desde el menú de NovaBridge.".into());
            }
            Notice::None
        }
        Method::Post => {
            let mut form = String::new();
            let _ = request.as_reader().take(MAX_FORM).read_to_string(&mut form);
            if field(&form, "t") != token() {
                return html(request, 403, "Abre esta página desde el menú de NovaBridge.".into());
            }
            act(&form)
        }
        _ => return html(request, 405, "Método no permitido".into()),
    };
    html(request, 200, render(&notice))
}

fn act(form: &str) -> Notice {
    match field(form, "action").as_str() {
        "easy" => {
            let password = sunshine::easy_password();
            match sunshine::change_password(&password) {
                Ok(()) => Notice::Good(format!("Nueva contraseña de Sunshine: <b class=\"pass\">{}</b>", escape(&password))),
                Err(e) => Notice::Bad(escape(&e)),
            }
        }
        "change" => {
            let (new, again) = (field(form, "new"), field(form, "again"));
            if new.chars().count() < MIN_PASSWORD {
                Notice::Bad(format!("La contraseña necesita al menos {MIN_PASSWORD} caracteres."))
            } else if new != again {
                Notice::Bad("Las dos contraseñas no coinciden.".into())
            } else {
                match sunshine::change_password(&new) {
                    Ok(()) => Notice::Good("Contraseña cambiada. NovaBridge la recordará para escribir el PIN de Moonlight.".into()),
                    Err(e) => Notice::Bad(escape(&e)),
                }
            }
        }
        "connect" => {
            let (user, password) = (field(form, "user"), field(form, "password"));
            if user.trim().is_empty() || password.is_empty() {
                Notice::Bad("Escribe el usuario y la contraseña de Sunshine.".into())
            } else {
                match sunshine::connect(user.trim(), &password) {
                    Ok(()) => Notice::Good("Conectado: NovaBridge ya puede escribir solo el PIN de Moonlight.".into()),
                    Err(e) => Notice::Bad(escape(&e)),
                }
            }
        }
        _ => Notice::Bad("No sé qué hacer con eso.".into()),
    }
}

fn render(notice: &Notice) -> String {
    let t = token();
    let banner = match notice {
        Notice::None => String::new(),
        Notice::Good(m) => format!("<p class=\"ok\">{m}</p>"),
        Notice::Bad(m) => format!("<p class=\"bad\">{m}</p>"),
    };
    let known = sunshine::credentials();
    let current = match &known {
        Some((user, password)) => format!(
            "<section><h2>Ahora</h2><p>Usuario <b>{}</b> · contraseña <b class=\"pass\">{}</b></p>\
             <form method=\"post\"><input type=\"hidden\" name=\"t\" value=\"{t}\"><input type=\"hidden\" name=\"action\" value=\"easy\">\
             <button>Darle una contraseña fácil</button></form></section>\
             <section><h2>Elegir la contraseña</h2><form method=\"post\"><input type=\"hidden\" name=\"t\" value=\"{t}\"><input type=\"hidden\" name=\"action\" value=\"change\">\
             <label>Nueva<input type=\"password\" name=\"new\" minlength=\"{MIN_PASSWORD}\" autocomplete=\"new-password\" required></label>\
             <label>Otra vez<input type=\"password\" name=\"again\" minlength=\"{MIN_PASSWORD}\" autocomplete=\"new-password\" required></label>\
             <button>Cambiar</button></form></section>",
            escape(user),
            escape(password)
        ),
        None => "<section><p>NovaBridge aún no conoce el usuario de Sunshine: escríbelo abajo y el PIN de Moonlight se escribirá solo.</p></section>".into(),
    };
    format!(
        "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>NovaBridge · Sunshine</title>\
<style>\
:root{{color-scheme:dark;font-family:'Segoe UI',system-ui,sans-serif}}\
body{{margin:0;background:#070a14;color:#eef1ff;display:grid;place-items:center;min-height:100vh}}\
main{{width:min(34rem,calc(100vw - 2rem));padding:2rem 0}}\
h1{{font-size:1.8rem;margin:0 0 .3rem}}h1 span{{color:#3fd5f2}}\
.sub{{color:#9aa3c7;margin:0 0 1.5rem}}\
section{{background:#111729;border:1px solid #232c48;border-radius:1rem;padding:1.2rem 1.4rem;margin-bottom:1rem}}\
h2{{font-size:1.05rem;margin:0 0 .8rem;color:#c9cff0}}\
label{{display:block;font-size:.9rem;color:#9aa3c7;margin-bottom:.7rem}}\
input{{display:block;width:100%;box-sizing:border-box;margin-top:.3rem;padding:.65rem .8rem;border-radius:.6rem;border:1px solid #2c3658;background:#0b1020;color:#fff;font-size:1rem}}\
button{{padding:.65rem 1.2rem;border:0;border-radius:.7rem;background:linear-gradient(135deg,#7c7aff,#3fd5f2);color:#050713;font-weight:600;font-size:1rem;cursor:pointer}}\
.pass{{font-family:Consolas,monospace;background:#1b2340;padding:.1rem .4rem;border-radius:.3rem;user-select:all}}\
.ok,.bad{{padding:.8rem 1rem;border-radius:.8rem;margin:0 0 1rem}}.ok{{background:#0f2e22;color:#7cf2b4}}.bad{{background:#3a1220;color:#ffb3c4}}\
</style></head><body><main>\
<h1>Nova<span>Bridge</span> · Sunshine</h1><p class=\"sub\">El usuario de Sunshine que NovaBridge usa para escribir solo el PIN de Moonlight. Esta página solo se abre en este PC.</p>\
{banner}{current}\
<section><h2>Conectar con otro usuario de Sunshine</h2><form method=\"post\"><input type=\"hidden\" name=\"t\" value=\"{t}\"><input type=\"hidden\" name=\"action\" value=\"connect\">\
<label>Usuario<input name=\"user\" autocomplete=\"username\" required></label>\
<label>Contraseña<input type=\"password\" name=\"password\" autocomplete=\"current-password\" required></label>\
<button>Conectar</button></form></section>\
</main></body></html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forms_decode() {
        assert_eq!(field("t=ab&new=luna+roja%21&again=x", "new"), "luna roja!");
        assert_eq!(field("user=Jos%C3%A9", "user"), "José");
        assert_eq!(field("a=%ZZ", "a"), "%ZZ");
        assert_eq!(field("a=50%", "a"), "50%");
        assert_eq!(field("a=1", "b"), "");
    }

    #[test]
    fn only_this_pc() {
        assert!(local("127.0.0.1"));
        assert!(local("::1"));
        assert!(!local("192.168.1.20"));
    }
}
