//! Point-lookup index: node_id -> where that record sits in a shard's L1
//! (bottom level) node segment.
//!
//! Answers `MultiShardStore::get_node` with a binary search instead of a shard
//! fan-out, where the fan-out ends in `Shard::get_node` step 3 — a record-by-record
//! walk of the L1 id column, i.e. O(shard size) per lookup.
//!
//! SHAPE: one sorted run PER SHARD, not one array for the whole database.
//! That is a cost decision, not a taste decision. The index is refreshed during
//! compaction, and compaction touches only the shards it actually compacts. With
//! one array for the whole database, refreshing means re-reading every shard's L1
//! and re-sorting everything — work proportional to the WHOLE database on every
//! round, however little was compacted. With one run per shard, a shard whose L1
//! segment did not change keeps its run untouched (not even copied), so a round
//! costs only what it rewrote. See `MultiShardStore::maintain_global_index`.
//!
//! IDENTITY: a run carries the id of the L1 segment it was built from. That is
//! what makes "still in step" checkable: if the shard's current L1 descriptor
//! names a different segment, the run is stale and gets rebuilt.
//!
//! INCOMPLETENESS IS SAFE, WRONGNESS IS NOT: a missing entry only costs a slower
//! answer (`get_node` falls back to the fan-out), but an entry pointing at the
//! wrong position would return the WRONG RECORD. `get_node` therefore verifies
//! the id at the offset before trusting an entry.

use std::io::Cursor;

use crate::error::Result;
use crate::storage_v2::index::format::{IndexEntry, IndexFileHeader, INDEX_MAGIC, INDEX_VERSION};

/// One shard's run: the entries describing the L1 node segment that shard has
/// installed right now, sorted by node_id.
struct ShardRun {
    /// Id of the L1 segment these entries describe (the run's identity).
    segment_id: u64,
    /// Sorted by node_id. The sort is stable, so entries with equal node_ids
    /// keep their segment order and two runs built from the same segment are
    /// byte-identical.
    entries: Vec<IndexEntry>,
}

/// Point-lookup index over all shards' L1 node segments.
///
/// Maintained across compaction rounds: whole runs are replaced per shard, never
/// rebuilt for the whole database.
pub struct GlobalIndex {
    /// Indexed by shard id. `None` = that shard has no run: either it has no L1
    /// node segment, or no round has built one for it yet. Both are safe (see
    /// module docs: incompleteness only costs speed).
    runs: Vec<Option<ShardRun>>,
}

impl Default for GlobalIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl GlobalIndex {
    /// Empty index: no shard has a run yet.
    pub fn new() -> Self {
        Self { runs: Vec::new() }
    }

    /// Build from a flat entry list, grouping by `entry.shard`.
    ///
    /// A run's identity is the segment its entries describe, so all of a shard's
    /// entries must agree on it. On the maintained path they always do: every
    /// entry of a run is stamped with that run's segment id when it is created.
    ///
    /// A list where one shard's entries DISAGREE describes no single segment, so
    /// no identity is truthful for it — and a half-truthful identity is worse than
    /// none, because `maintain_global_index` decides "still in step" by comparing
    /// that one id: a run claiming a segment that only some of its entries came
    /// from would be waved through as fresh, keeping foreign entries forever.
    /// Such a shard therefore gets NO run. That is the module's rule applied
    /// literally — incompleteness only costs a slower answer, wrongness returns
    /// the wrong record — and it keeps the door safe for a future path that
    /// restores an index from disk through `from_bytes`.
    pub fn build(entries: Vec<IndexEntry>) -> Self {
        let mut idx = Self::new();
        let mut disagrees: Vec<bool> = Vec::new();
        for entry in entries {
            let shard = entry.shard;
            idx.ensure_slot(shard);
            if disagrees.len() < idx.runs.len() {
                disagrees.resize(idx.runs.len(), false);
            }
            match &mut idx.runs[shard as usize] {
                Some(run) => {
                    if run.segment_id != entry.segment_id {
                        disagrees[shard as usize] = true;
                    }
                    run.entries.push(entry);
                }
                None => {
                    idx.runs[shard as usize] = Some(ShardRun {
                        segment_id: entry.segment_id,
                        entries: vec![entry],
                    })
                }
            }
        }
        for (shard, mixed) in disagrees.iter().enumerate() {
            if *mixed {
                idx.runs[shard] = None;
            }
        }
        for run in idx.runs.iter_mut().flatten() {
            run.entries.sort_by_key(|e| e.node_id);
        }
        idx
    }

    /// Replace one shard's run. Entries may arrive in any order; they are sorted
    /// by node_id here, which is what makes the lookup a binary search.
    ///
    /// This is the whole point of the per-shard shape: refreshing one shard does
    /// not read, copy or re-sort any other shard.
    pub fn set_shard_run(&mut self, shard: u16, segment_id: u64, mut entries: Vec<IndexEntry>) {
        entries.sort_by_key(|e| e.node_id);
        self.ensure_slot(shard);
        self.runs[shard as usize] = Some(ShardRun { segment_id, entries });
    }

    /// Drop one shard's run (its L1 node segment is gone).
    pub fn clear_shard_run(&mut self, shard: u16) {
        if (shard as usize) < self.runs.len() {
            self.runs[shard as usize] = None;
        }
    }

    /// Id of the L1 segment one shard's run was built from, if it has a run.
    ///
    /// The maintainer compares this with the shard's current L1 descriptor to
    /// decide whether the run is still in step.
    pub fn shard_run_segment(&self, shard: u16) -> Option<u64> {
        self.runs
            .get(shard as usize)
            .and_then(|r| r.as_ref())
            .map(|r| r.segment_id)
    }

    /// One shard's run as (segment id, entries sorted by node_id).
    pub fn shard_run(&self, shard: u16) -> Option<(u64, &[IndexEntry])> {
        self.runs
            .get(shard as usize)
            .and_then(|r| r.as_ref())
            .map(|r| (r.segment_id, r.entries.as_slice()))
    }

    /// Number of shard slots the index has room for (highest shard id + 1 among
    /// the shards it has ever been told about).
    pub fn shard_slots(&self) -> usize {
        self.runs.len()
    }

    /// Point lookup inside ONE shard's run. O(log n) in that shard's L1 size.
    pub fn lookup_in_shard(&self, shard: u16, node_id: u128) -> Option<&IndexEntry> {
        let run = self.runs.get(shard as usize)?.as_ref()?;
        run.entries
            .binary_search_by_key(&node_id, |e| e.node_id)
            .ok()
            .map(|i| &run.entries[i])
    }

    /// Point lookup across all shards: probes runs in shard order, first hit wins.
    ///
    /// Deterministic on purpose — the same node id can, in a corner case, sit in
    /// two shards' L1 (a node whose file moved between shards, before the stale
    /// copy is compacted away), and "lowest shard id wins" is at least an answer
    /// that does not change between runs.
    ///
    /// `get_node` does not call this: it prunes with each L1's bloom filter first,
    /// so it pays one binary search, not one per shard.
    pub fn lookup(&self, node_id: u128) -> Option<&IndexEntry> {
        for shard in 0..self.runs.len() {
            if let Some(entry) = self.lookup_in_shard(shard as u16, node_id) {
                return Some(entry);
            }
        }
        None
    }

    /// Total number of entries across all shard runs.
    pub fn len(&self) -> usize {
        self.runs
            .iter()
            .flatten()
            .map(|run| run.entries.len())
            .sum()
    }

    /// True if no shard run holds any entry.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Serialize to bytes: all runs flattened in shard order. Each entry carries
    /// its own shard and segment id, so `from_bytes` can regroup.
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        let flat: Vec<IndexEntry> = self
            .runs
            .iter()
            .flatten()
            .flat_map(|run| run.entries.iter().copied())
            .collect();
        let mut buf = Cursor::new(Vec::new());
        let header = IndexFileHeader {
            magic: INDEX_MAGIC,
            version: INDEX_VERSION,
            entry_count: flat.len() as u64,
            lookup_count: 0, // no lookup table for global index
            _reserved: [0u8; 12],
        };
        header.write_to(&mut buf)?;
        IndexEntry::write_batch(&flat, &mut buf)?;
        Ok(buf.into_inner())
    }

    /// Load from bytes, regrouping entries into per-shard runs.
    pub fn from_bytes(data: &[u8]) -> Result<Self> {
        let mut cursor = Cursor::new(data);
        let header = IndexFileHeader::read_from(&mut cursor)?;
        let entries = IndexEntry::read_batch(&mut cursor, header.entry_count as usize)?;
        Ok(Self::build(entries))
    }

    fn ensure_slot(&mut self, shard: u16) {
        if self.runs.len() <= shard as usize {
            self.runs.resize_with(shard as usize + 1, || None);
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_v2::index::format::IndexEntry;

    #[test]
    fn test_global_index_build_and_lookup() {
        let entries = vec![
            IndexEntry::new(300, 1, 0, 0),
            IndexEntry::new(100, 1, 1, 0),
            IndexEntry::new(200, 2, 0, 1),
        ];

        let idx = GlobalIndex::build(entries);
        assert_eq!(idx.len(), 3);

        // Lookup existing
        let found = idx.lookup(100).unwrap();
        assert_eq!(found.segment_id, 1);
        assert_eq!(found.offset, 1);
        assert_eq!(found.shard, 0);

        let found = idx.lookup(200).unwrap();
        assert_eq!(found.segment_id, 2);
        assert_eq!(found.offset, 0);
        assert_eq!(found.shard, 1);

        let found = idx.lookup(300).unwrap();
        assert_eq!(found.segment_id, 1);
        assert_eq!(found.offset, 0);

        // Lookup missing
        assert!(idx.lookup(999).is_none());
        assert!(idx.lookup(0).is_none());
    }

    #[test]
    fn test_global_index_roundtrip() {
        // Shard 0's two entries share segment 1, shard 1's entry is segment 2 —
        // the shape the maintained path always produces (one segment per shard run).
        let entries = vec![
            IndexEntry::new(50, 1, 0, 0),
            IndexEntry::new(250, 1, 2, 0),
            IndexEntry::new(150, 2, 1, 1),
        ];

        let idx = GlobalIndex::build(entries);
        let bytes = idx.to_bytes().unwrap();

        let idx2 = GlobalIndex::from_bytes(&bytes).unwrap();
        assert_eq!(idx2.len(), 3);

        // Verify lookups still work after roundtrip
        assert_eq!(idx2.lookup(50).unwrap().segment_id, 1);
        assert_eq!(idx2.lookup(150).unwrap().segment_id, 2);
        assert_eq!(idx2.lookup(250).unwrap().offset, 2);
        assert!(idx2.lookup(999).is_none());
        // Run identities survive too, which is what "still in step" is decided on.
        assert_eq!(idx2.shard_run_segment(0), Some(1));
        assert_eq!(idx2.shard_run_segment(1), Some(2));
    }

    /// A list whose entries for ONE shard name different segments describes no
    /// single segment for that shard. Giving the run one of those ids anyway would
    /// make `maintain_global_index` wave it through as "still in step" — it decides
    /// on that id alone — and the foreign entries would survive every later round.
    /// So that shard gets no run at all: a missing run only costs a fan-out, a
    /// mislabelled one costs correctness.
    #[test]
    fn test_build_refuses_a_run_whose_entries_disagree_on_the_segment() {
        let idx = GlobalIndex::build(vec![
            IndexEntry::new(10, 5, 0, 0),
            IndexEntry::new(20, 9, 1, 0), // same shard, DIFFERENT segment
            IndexEntry::new(30, 7, 0, 1), // a clean shard alongside it
        ]);

        assert!(
            idx.shard_run(0).is_none(),
            "shard 0's entries named segments 5 and 9; the run must be dropped, not \
             labelled with one of them"
        );
        assert!(idx.lookup(10).is_none());
        assert!(idx.lookup(20).is_none());

        // The clean shard is unaffected: one bad shard does not cost the others.
        assert_eq!(idx.shard_run_segment(1), Some(7));
        assert_eq!(idx.lookup(30).unwrap().offset, 0);
        assert_eq!(idx.len(), 1);
    }

    #[test]
    fn test_global_index_empty() {
        let idx = GlobalIndex::build(vec![]);
        assert!(idx.is_empty());
        assert_eq!(idx.len(), 0);
        assert!(idx.lookup(1).is_none());

        // Roundtrip empty
        let bytes = idx.to_bytes().unwrap();
        let idx2 = GlobalIndex::from_bytes(&bytes).unwrap();
        assert!(idx2.is_empty());
    }

    #[test]
    fn test_global_index_sorted_after_build() {
        // Build with unsorted input
        let entries = vec![
            IndexEntry::new(999, 1, 0, 0),
            IndexEntry::new(1, 1, 1, 0),
            IndexEntry::new(500, 1, 2, 0),
        ];

        let idx = GlobalIndex::build(entries);

        // Should find all by binary search (implies sorted)
        assert!(idx.lookup(1).is_some());
        assert!(idx.lookup(500).is_some());
        assert!(idx.lookup(999).is_some());
    }

    /// Replacing one shard's run must leave every other shard's run exactly as it
    /// was — that is the property the whole per-shard shape exists for.
    #[test]
    fn test_set_shard_run_touches_only_that_shard() {
        let mut idx = GlobalIndex::build(vec![
            IndexEntry::new(10, 7, 0, 0),
            IndexEntry::new(20, 7, 1, 0),
            IndexEntry::new(30, 8, 0, 1),
        ]);
        let (seg_before, entries_before) = idx.shard_run(1).unwrap();
        let entries_before: Vec<IndexEntry> = entries_before.to_vec();

        idx.set_shard_run(0, 9, vec![IndexEntry::new(11, 9, 0, 0)]);

        // Shard 0 replaced wholesale: old ids gone, new id present.
        assert!(idx.lookup_in_shard(0, 10).is_none());
        assert!(idx.lookup_in_shard(0, 20).is_none());
        assert_eq!(idx.lookup_in_shard(0, 11).unwrap().offset, 0);
        assert_eq!(idx.shard_run_segment(0), Some(9));

        // Shard 1 untouched, byte for byte.
        let (seg_after, entries_after) = idx.shard_run(1).unwrap();
        assert_eq!(seg_after, seg_before);
        assert_eq!(entries_after, entries_before.as_slice());
        assert_eq!(idx.len(), 2);
    }

    #[test]
    fn test_clear_shard_run() {
        let mut idx = GlobalIndex::build(vec![
            IndexEntry::new(10, 7, 0, 0),
            IndexEntry::new(30, 8, 0, 1),
        ]);
        idx.clear_shard_run(0);
        assert!(idx.shard_run(0).is_none());
        assert!(idx.shard_run_segment(0).is_none());
        assert!(idx.lookup(10).is_none());
        // Clearing a shard the index never heard of is a no-op, not a panic.
        idx.clear_shard_run(9);
        assert_eq!(idx.len(), 1);
        assert!(idx.lookup(30).is_some());
    }

    /// A run built from an unsorted list and a run built from the same list in a
    /// different order must come out identical — the equality proof in
    /// `multi_shard.rs` compares maintained runs against freshly built ones, so a
    /// build that depended on input order would make that proof meaningless.
    #[test]
    fn test_set_shard_run_is_order_independent() {
        let mut a = GlobalIndex::new();
        a.set_shard_run(
            0,
            5,
            vec![
                IndexEntry::new(300, 5, 0, 0),
                IndexEntry::new(100, 5, 1, 0),
                IndexEntry::new(200, 5, 2, 0),
            ],
        );
        let mut b = GlobalIndex::new();
        b.set_shard_run(
            0,
            5,
            vec![
                IndexEntry::new(200, 5, 2, 0),
                IndexEntry::new(300, 5, 0, 0),
                IndexEntry::new(100, 5, 1, 0),
            ],
        );
        assert_eq!(a.shard_run(0).unwrap().1, b.shard_run(0).unwrap().1);
    }
}
