//! NOVA's plugin host. Plugins are written in TypeScript with @novatv/sdk
//! (sdk/ in this repository) and run here, each one isolated in its own
//! QuickJS engine, with only the permissions its manifest declares.

pub mod http;
pub mod manifest;
pub mod runtime;
pub mod storage;
