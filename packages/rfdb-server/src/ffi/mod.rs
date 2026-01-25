//! Node.js FFI bindings via napi-rs
//!
//! This module provides JavaScript API for GraphEngine

#[cfg(feature = "napi")]
pub mod napi_bindings;

#[cfg(feature = "napi")]
pub mod rust_parser;

#[cfg(feature = "napi")]
pub use napi_bindings::*;

#[cfg(feature = "napi")]
pub use rust_parser::*;
