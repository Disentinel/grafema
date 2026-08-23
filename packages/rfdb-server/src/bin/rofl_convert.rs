//! `rofl-convert` — the P6 stage-1 converter CLI (rofl-fact-model.md §10.3;
//! ledger round-012-pre).
//!
//! Reads an OLD record-model (v2) RFDB base STRICTLY read-only and emits a NEW
//! fact-layout store (catalog + fact segments + `rofl_manifest.json`), verified
//! by the converter's own reader — «он обязан уметь работать без сети и без
//! движка вывода» (§10.3): no network, no derive engine, no server.
//!
//! Usage:
//!   rofl-convert --input <old-base-dir> --output <fresh-dir>
//!                --report <conversion-report.json> [--verify-c1]
//!
//! The report lands OUTSIDE the store directory (round-012-pre F4): it carries
//! wallclock, so it is deliberately not part of the output-dir byte-identity
//! gate (E7). Exit 0 on success; exit 1 with the typed `E-CONV-*` code on a
//! conversion failure; exit 2 on a CLI usage error.

use std::path::PathBuf;

use rfdb::facts::convert::{self, RunOptions};

const USAGE: &str = "usage: rofl-convert --input <dir> --output <dir> --report <path> [--verify-c1]

  --input <dir>    the OLD record-model base; opened read-only, never written
  --output <dir>   the NEW fact-layout store; MUST NOT exist (created fresh)
  --report <path>  where the JSON conversion report is written (outside the store)
  --verify-c1      run the C1 record-level round-trip after conversion";

struct Args {
    input: Option<PathBuf>,
    output: Option<PathBuf>,
    report: Option<PathBuf>,
    verify_c1: bool,
}

fn usage_error(msg: &str) -> ! {
    eprintln!("rofl-convert: {msg}");
    eprintln!("{USAGE}");
    std::process::exit(2);
}

fn parse_args() -> Args {
    let mut args = Args {
        input: None,
        output: None,
        report: None,
        verify_c1: false,
    };
    let argv: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < argv.len() {
        match argv[i].as_str() {
            "--input" => {
                i += 1;
                match argv.get(i) {
                    Some(v) => args.input = Some(PathBuf::from(v)),
                    None => usage_error("--input needs a directory"),
                }
            }
            "--output" => {
                i += 1;
                match argv.get(i) {
                    Some(v) => args.output = Some(PathBuf::from(v)),
                    None => usage_error("--output needs a directory"),
                }
            }
            "--report" => {
                i += 1;
                match argv.get(i) {
                    Some(v) => args.report = Some(PathBuf::from(v)),
                    None => usage_error("--report needs a path"),
                }
            }
            "--verify-c1" => args.verify_c1 = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => usage_error(&format!("unknown arg: {other}")),
        }
        i += 1;
    }
    args
}

fn main() {
    let args = parse_args();
    let (Some(input), Some(output), Some(report_path)) = (args.input, args.output, args.report)
    else {
        usage_error("--input, --output and --report are all required");
    };

    let opts = RunOptions {
        input,
        output,
        verify_c1: args.verify_c1,
    };
    eprintln!(
        "rofl-convert: {} -> {} (verify_c1={})",
        opts.input.display(),
        opts.output.display(),
        opts.verify_c1
    );

    let report = match convert::run(&opts) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("rofl-convert FAILED: {e}");
            std::process::exit(1);
        }
    };

    // The report is the C7 evidence artifact: write it before printing the
    // summary so a broken report path fails loudly rather than after the fact.
    let json = match serde_json::to_string_pretty(&report) {
        Ok(mut s) => {
            s.push('\n');
            s
        }
        Err(e) => {
            eprintln!("rofl-convert FAILED: report serialization: {e}");
            std::process::exit(1);
        }
    };
    if let Some(parent) = report_path.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!(
                    "rofl-convert FAILED: cannot create report directory {}: {e}",
                    parent.display()
                );
                std::process::exit(1);
            }
        }
    }
    if let Err(e) = std::fs::write(&report_path, &json) {
        eprintln!(
            "rofl-convert FAILED: cannot write report {}: {e}",
            report_path.display()
        );
        std::process::exit(1);
    }

    println!("rofl-convert OK ({:.1}s)", report.wallclock_seconds);
    println!(
        "  input   {} ({} B, manifest v{}, sha256 {})",
        report.input.path,
        report.input.size_bytes,
        report.input.manifest_version,
        report.input.recursive_sha256
    );
    println!(
        "  records {} nodes / {} edges enumerated",
        report.load.node_records_enumerated, report.load.edge_records_enumerated
    );
    println!(
        "  output  {} ({} B, {} segment files, {} predicates, {} authors, shard_count {})",
        report.output.path,
        report.output.size_bytes,
        report.output.segment_files,
        report.output.predicates,
        report.output.authors,
        report.output.shard_count
    );
    println!(
        "  metrics entities {} / facts {} / assertions {} / rows {}",
        report.metrics.entities,
        report.metrics.facts,
        report.metrics.assertions,
        report.metrics.rows
    );
    println!(
        "  growth  {:.3}x facts per record, {:.3}x bytes (doc band {})",
        report.growth.count_growth_factor,
        report.growth.byte_growth_factor,
        report.growth.doc_byte_band
    );
    println!("  conflict/5 total {}", report.conflicts.total);
    for (pred, summary) in &report.conflicts.per_predicate {
        println!("    {pred}: {}", summary.count);
    }
    println!(
        "  output sha256          {}",
        report.output.recursive_sha256
    );
    println!("  canonical_state_sha    {}", report.canonical_state_sha);
    match &report.c1 {
        Some(c1) => println!(
            "  C1  nodes {}->{} edges {}->{} equal={} exceptions={} consistent={}",
            c1.input_nodes,
            c1.reassembled_nodes,
            c1.input_edges,
            c1.reassembled_edges,
            c1.full_multiset_equal,
            c1.exceptions.len(),
            c1.resolved_view_consistent
        ),
        None => println!("  C1  not run (--verify-c1 absent)"),
    }
    println!("  report  {}", report_path.display());
}
