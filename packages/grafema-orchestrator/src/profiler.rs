//! Incremental JSONL profiler for analysis pipeline observability.
//!
//! Writes events to `.grafema/analysis-profile.jsonl` as they happen.
//! If the process crashes or hangs, the last event shows where it stopped.
//!
//! Each event includes wall-clock time, RSS, and CPU time.
//!
//! Usage:
//! ```no_run
//! use grafema_orchestrator::profiler::Profiler;
//!
//! # fn main() -> std::io::Result<()> {
//! let profiler = Profiler::new(".grafema/analysis-profile.jsonl")?;
//! profiler.event("phase_start", &[("phase", "js_analysis"), ("files", "204")]);
//! // ... do work ...
//! profiler.event("phase_end", &[("phase", "js_analysis"), ("nodes", "45000")]);
//! # Ok(())
//! # }
//! ```

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

/// Process resource snapshot: RSS and CPU time.
#[derive(Debug, Clone, Copy)]
pub struct ProcessStats {
    /// Resident set size in bytes.
    pub rss_bytes: u64,
    /// User CPU time in seconds.
    pub cpu_seconds: f64,
}

/// Collect current process RSS and CPU time.
pub fn get_process_stats() -> ProcessStats {
    #[cfg(target_os = "macos")]
    {
        macos_stats()
    }
    #[cfg(target_os = "linux")]
    {
        linux_stats()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        ProcessStats { rss_bytes: 0, cpu_seconds: 0.0 }
    }
}

#[cfg(target_os = "macos")]
fn macos_stats() -> ProcessStats {
    // mach_task_basic_info gives RSS and CPU time in one syscall.
    #[repr(C)]
    struct TimeValue {
        seconds: i32,
        microseconds: i32,
    }

    #[repr(C)]
    struct MachTaskBasicInfo {
        virtual_size: u64,
        resident_size: u64,
        resident_size_max: u64,
        user_time: TimeValue,
        system_time: TimeValue,
        policy: i32,
        suspend_count: i32,
    }

    const MACH_TASK_BASIC_INFO: u32 = 20;

    extern "C" {
        fn mach_task_self() -> u32;
        fn task_info(
            target_task: u32,
            flavor: u32,
            task_info_out: *mut MachTaskBasicInfo,
            task_info_count: *mut u32,
        ) -> i32;
    }

    unsafe {
        let mut info: MachTaskBasicInfo = std::mem::zeroed();
        let mut count = (std::mem::size_of::<MachTaskBasicInfo>() / 4) as u32;
        let kr = task_info(
            mach_task_self(),
            MACH_TASK_BASIC_INFO,
            &mut info as *mut _,
            &mut count,
        );
        if kr == 0 {
            ProcessStats {
                rss_bytes: info.resident_size,
                cpu_seconds: info.user_time.seconds as f64
                    + info.user_time.microseconds as f64 / 1_000_000.0
                    + info.system_time.seconds as f64
                    + info.system_time.microseconds as f64 / 1_000_000.0,
            }
        } else {
            ProcessStats { rss_bytes: 0, cpu_seconds: 0.0 }
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_stats() -> ProcessStats {
    use std::fs;

    let rss_bytes = fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|s| {
            let pages: u64 = s.split_whitespace().nth(1)?.parse().ok()?;
            Some(pages * 4096)
        })
        .unwrap_or(0);

    let cpu_seconds = fs::read_to_string("/proc/self/stat")
        .ok()
        .and_then(|s| {
            let fields: Vec<&str> = s.split_whitespace().collect();
            let utime: f64 = fields.get(13)?.parse().ok()?;
            let stime: f64 = fields.get(14)?.parse().ok()?;
            let ticks = 100.0; // sysconf(_SC_CLK_TCK), usually 100
            Some((utime + stime) / ticks)
        })
        .unwrap_or(0.0);

    ProcessStats { rss_bytes, cpu_seconds }
}

/// JSONL profiler that writes events incrementally to a file.
pub struct Profiler {
    file: Mutex<File>,
    start: Instant,
}

impl Profiler {
    /// Create a new profiler writing to the given path.
    /// Overwrites any existing file.
    pub fn new(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)?;
        Ok(Self {
            file: Mutex::new(file),
            start: Instant::now(),
        })
    }

    /// Write a profiling event with arbitrary key-value fields.
    ///
    /// Always includes: `ts` (ISO timestamp), `elapsed_ms`, `rss_mb`, `cpu_s`.
    pub fn event(&self, event_name: &str, fields: &[(&str, &str)]) {
        let stats = get_process_stats();
        let elapsed = self.start.elapsed();

        let mut json = format!(
            r#"{{"ts":"{}","elapsed_ms":{},"event":"{}","rss_mb":{:.1},"cpu_s":{:.2}"#,
            chrono_now(),
            elapsed.as_millis(),
            escape_json(event_name),
            stats.rss_bytes as f64 / (1024.0 * 1024.0),
            stats.cpu_seconds,
        );

        for &(key, value) in fields {
            // Try to format as number if it parses, otherwise string
            if value.parse::<f64>().is_ok() && !value.is_empty() {
                json.push_str(&format!(r#","{}":{}"#, escape_json(key), value));
            } else {
                json.push_str(&format!(r#","{}":"{}""#, escape_json(key), escape_json(value)));
            }
        }
        json.push_str("}\n");

        if let Ok(mut f) = self.file.lock() {
            let _ = f.write_all(json.as_bytes());
            let _ = f.flush();
        }
    }
}

/// Simple JSON string escaping (quotes, backslashes, newlines).
fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

/// Current UTC timestamp in ISO 8601 format without external crate.
fn chrono_now() -> String {
    use std::time::SystemTime;
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    // Simple UTC formatting: seconds since epoch → YYYY-MM-DDTHH:MM:SSZ
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Days since 1970-01-01 → year/month/day
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    //算法 from https://howardhinnant.github.io/date_algorithms.html
    days += 719468;
    let era = days / 146097;
    let doe = days % 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_stats_returns_nonzero_rss() {
        let stats = get_process_stats();
        assert!(stats.rss_bytes > 0, "RSS should be > 0, got {}", stats.rss_bytes);
    }

    #[test]
    fn profiler_writes_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-profile.jsonl");
        let p = Profiler::new(&path).unwrap();
        p.event("test_event", &[("key", "value"), ("count", "42")]);
        p.event("another", &[]);

        let content = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"event\":\"test_event\""));
        assert!(lines[0].contains("\"rss_mb\":"));
        assert!(lines[1].contains("\"event\":\"another\""));
    }

    #[test]
    fn chrono_now_format() {
        let ts = chrono_now();
        // Should look like 2026-03-16T10:22:00Z
        assert!(ts.ends_with('Z'));
        assert_eq!(ts.len(), 20);
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[7..8], "-");
        assert_eq!(&ts[10..11], "T");
    }
}
