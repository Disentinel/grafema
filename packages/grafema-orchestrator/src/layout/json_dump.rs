//! JSON dump for layout results.
//!
//! Schema (matches the sandbox visualiser's expected shape):
//! ```json
//! {
//!   "coords": {
//!     "<node_id>": { "q": 0, "r": 0 },
//!     ...
//!   },
//!   "stats": {
//!     "n_nodes": 1500,
//!     "n_edges": 2243,
//!     "pack_ms": 12,
//!     ...
//!   }
//! }
//! ```
//!
//! `node_id` strings come from the caller — for synthetic input they're the
//! leaf path (`packages/api/src/file42.rs`); for an RFDB-driven run they'd be
//! the semantic id. Keeping the writer agnostic means step 6 can plug in
//! real ids without touching this module.

use std::collections::BTreeMap;
use std::io::Write;

use serde::Serialize;

use super::hex::HexCoord;
use super::runner::LayoutStats;
use super::state::NodeIdx;

/// One entry in `coords`. `BTreeMap` keys give deterministic output ordering.
#[derive(Serialize)]
struct CoordEntry {
    q: i32,
    r: i32,
}

#[derive(Serialize)]
struct LayoutDump<'a> {
    coords: BTreeMap<String, CoordEntry>,
    stats: &'a LayoutStats,
}

/// Serialise a layout result as pretty-printed JSON to `writer`.
///
/// `nodes_with_paths` provides `(NodeIdx, &str)` pairs — the same shape
/// `FolderTree::build_from_paths` consumes — so synthetic and real-input
/// callers can use a single API. `coords` is indexed by `NodeIdx`.
///
/// Ordering: `coords` keys are sorted (BTreeMap), so byte output is
/// deterministic for a given input. `stats` field order follows the
/// `LayoutStats` struct definition — also deterministic via `serde_json`.
pub fn dump_to_writer<W: Write>(
    nodes_with_paths: &[(NodeIdx, &str)],
    coords: &[HexCoord],
    stats: &LayoutStats,
    mut writer: W,
) -> Result<(), std::io::Error> {
    let mut coords_map = BTreeMap::new();
    for (idx, path) in nodes_with_paths {
        let c = coords[*idx as usize];
        coords_map.insert(
            path.to_string(),
            CoordEntry { q: c.q, r: c.r },
        );
    }
    let dump = LayoutDump {
        coords: coords_map,
        stats,
    };
    serde_json::to_writer_pretty(&mut writer, &dump)?;
    // Trailing newline so `cat` output is friendly.
    writer.write_all(b"\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::runner::LayoutStats;
    use super::*;

    fn dummy_stats() -> LayoutStats {
        LayoutStats {
            n_nodes: 3,
            n_edges: 0,
            pack_ms: 1,
            iswap_ms: 0,
            xswap_ms: 0,
            iswap_swaps: 0,
            xswap_swaps: 0,
            sigma_link_pre: 0.0,
            sigma_link_after_iswap: 0.0,
            sigma_link_after_xswap: 0.0,
        }
    }

    #[test]
    fn dump_round_trips_coords_and_stats() {
        let coords = vec![
            HexCoord::new(0, 0),
            HexCoord::new(1, -1),
            HexCoord::new(-2, 3),
        ];
        let pairs: Vec<(NodeIdx, &str)> = vec![
            (0, "src/a.rs"),
            (1, "src/b.rs"),
            (2, "lib/c.rs"),
        ];
        let stats = dummy_stats();

        let mut buf: Vec<u8> = Vec::new();
        dump_to_writer(&pairs, &coords, &stats, &mut buf).unwrap();

        // Parse back as JSON value and verify shape.
        let v: serde_json::Value =
            serde_json::from_slice(&buf).expect("output must be valid JSON");

        // coords["src/a.rs"]["q"] == 0
        assert_eq!(v["coords"]["src/a.rs"]["q"], 0);
        assert_eq!(v["coords"]["src/a.rs"]["r"], 0);
        assert_eq!(v["coords"]["src/b.rs"]["q"], 1);
        assert_eq!(v["coords"]["src/b.rs"]["r"], -1);
        assert_eq!(v["coords"]["lib/c.rs"]["q"], -2);
        assert_eq!(v["coords"]["lib/c.rs"]["r"], 3);

        // stats fields present.
        assert_eq!(v["stats"]["n_nodes"], 3);
        assert_eq!(v["stats"]["pack_ms"], 1);
    }

    #[test]
    fn dump_is_deterministic_for_same_input() {
        let coords = vec![HexCoord::new(2, 3), HexCoord::new(-1, 4)];
        let pairs: Vec<(NodeIdx, &str)> = vec![(0, "z.rs"), (1, "a.rs")];
        let stats = dummy_stats();

        let mut buf1: Vec<u8> = Vec::new();
        let mut buf2: Vec<u8> = Vec::new();
        dump_to_writer(&pairs, &coords, &stats, &mut buf1).unwrap();
        dump_to_writer(&pairs, &coords, &stats, &mut buf2).unwrap();
        assert_eq!(buf1, buf2, "JSON output must be byte-identical for same input");

        // Sorted keys: "a.rs" appears before "z.rs" in the output stream.
        let s = std::str::from_utf8(&buf1).unwrap();
        let pos_a = s.find("a.rs").expect("a.rs key in output");
        let pos_z = s.find("z.rs").expect("z.rs key in output");
        assert!(pos_a < pos_z, "BTreeMap should sort keys lexicographically");
    }

    #[test]
    fn empty_dump_writes_valid_json() {
        let coords: Vec<HexCoord> = Vec::new();
        let pairs: Vec<(NodeIdx, &str)> = Vec::new();
        let mut stats = dummy_stats();
        stats.n_nodes = 0;

        let mut buf: Vec<u8> = Vec::new();
        dump_to_writer(&pairs, &coords, &stats, &mut buf).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert!(v["coords"].is_object());
        assert_eq!(v["coords"].as_object().unwrap().len(), 0);
        assert_eq!(v["stats"]["n_nodes"], 0);
    }
}
