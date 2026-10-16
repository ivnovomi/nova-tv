//! Shared HTTP client for public data (TDT, iptv-org, YouTube, Twitch, game
//! art). ureq has no timeouts by default: here every request has one, follows
//! only a few redirects and never leaves HTTPS.

use std::sync::OnceLock;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: u32 = 4;

pub fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .max_redirects(MAX_REDIRECTS)
            .https_only(true)
            .build()
            .into()
    })
}
