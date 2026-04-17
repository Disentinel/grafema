//! Bottom-up hex placement algorithm.
//!
//! 1. Load all nodes + edges from RFDB via socket
//! 2. Build containment tree from CONTAINS edges
//! 3. Recursively place leaves first, then containers
//! 4. Compute region boundaries
//! 5. Compute streaming batch order

use std::collections::{HashMap, HashSet, VecDeque};
use crate::rfdb_client::RfdbClient;
use crate::types::*;

/// Container types that can hold other nodes via CONTAINS edges
const CONTAINER_TYPES: &[&str] = &[
    "SERVICE", "MODULE", "CLASS", "FUNCTION", "METHOD", "INTERFACE",
    "LOOP", "BRANCH", "TRY_BLOCK", "CATCH_BLOCK", "FINALLY_BLOCK",
    "SCOPE", "DO_BLOCK", "IMPL_BLOCK", "LET_BLOCK",
];

/// Compute depth = number of container ancestors in containment tree
fn compute_depth(id: &str, nodes: &HashMap<String, LayoutNode>) -> u8 {
    let mut depth = 0u8;
    let mut current = id;
    while let Some(node) = nodes.get(current) {
        if let Some(ref parent) = node.parent_id {
            depth += 1;
            current = parent;
        } else {
            break;
        }
    }
    depth
}

/// Internal node representation during layout
struct LayoutNode {
    node_type: String,
    name: String,
    file: String,
    parent_id: Option<String>,
    children: Vec<String>,
}

/// Adjacency as simple HashMap
type Adjacency = HashMap<String, Vec<(String, u32)>>;

fn neighbors_of<'a>(adj: &'a Adjacency, id: &str) -> &'a [(String, u32)] {
    adj.get(id).map(|v| v.as_slice()).unwrap_or(&[])
}

pub fn compute_layout(client: &mut RfdbClient, tile_size: f32, file_filter: Option<&str>) -> anyhow::Result<HexLayout> {
    let t0 = std::time::Instant::now();

    // 1. Load all nodes
    tracing::info!("Loading all nodes...");
    let all_nodes = client.get_all_nodes()?;
    tracing::info!("Loaded {} nodes in {:?}", all_nodes.len(), t0.elapsed());

    // Filter by file prefix if specified
    let wire_nodes: Vec<_> = if let Some(prefix) = file_filter {
        all_nodes.into_iter()
            .filter(|n| n.file.as_deref().unwrap_or("").contains(prefix))
            .collect()
    } else {
        all_nodes
    };
    tracing::info!("After filter: {} nodes", wire_nodes.len());

    // 2. Load all edges
    tracing::info!("Loading all edges...");
    let wire_edges = client.get_all_edges()?;
    tracing::info!("Loaded {} edges in {:?}", wire_edges.len(), t0.elapsed());

    // 3. Build node map
    let mut nodes_by_id: HashMap<String, LayoutNode> = HashMap::new();
    for wn in &wire_nodes {
        let nt = wn.node_type.as_deref().unwrap_or("UNKNOWN");
        nodes_by_id.insert(wn.id.clone(), LayoutNode {
            node_type: nt.to_string(),
            name: wn.name.clone().unwrap_or_default(),
            file: wn.file.clone().unwrap_or_default(),
            parent_id: None,
            children: Vec::new(),
        });
    }

    // 4. Build containment tree + collect non-structural edges
    let mut non_structural_edges: Vec<(String, String, String)> = Vec::new();

    // CONTAINS and DECLARES establish containment hierarchy
    const CONTAINMENT_EDGES: &[&str] = &["CONTAINS", "DECLARES"];

    for we in &wire_edges {
        let etype = we.edge_type.as_deref().unwrap_or("");
        if CONTAINMENT_EDGES.contains(&etype) {
            if nodes_by_id.contains_key(&we.src) && nodes_by_id.contains_key(&we.dst) {
                // Only set parent if not already set (CONTAINS takes priority)
                let dst_node = nodes_by_id.get_mut(&we.dst).unwrap();
                if dst_node.parent_id.is_none() {
                    dst_node.parent_id = Some(we.src.clone());
                }
                nodes_by_id.get_mut(&we.src).unwrap().children.push(we.dst.clone());
            }
        } else if etype != "HAS_SCOPE" {
            if nodes_by_id.contains_key(&we.src) && nodes_by_id.contains_key(&we.dst) {
                non_structural_edges.push((we.src.clone(), we.dst.clone(), etype.to_string()));
            }
        }
    }
    // Debug: count CONTAINS edges and tree stats
    let contains_count = nodes_by_id.values().filter(|n| n.parent_id.is_some()).count();
    let has_children = nodes_by_id.values().filter(|n| !n.children.is_empty()).count();
    tracing::info!("Containment tree built: {} with parent, {} with children, {} non-structural edges",
        contains_count, has_children, non_structural_edges.len());

    // 4b. Compact pass-through nodes (REFERENCE, PROPERTY_ACCESS) for visualization.
    //     These nodes add positional detail but clutter the hex map.
    //     Strategy: find their single outgoing edge target, redirect all incoming
    //     edges to that target, then exclude them from rendering.
    //
    //     REFERENCE       → READS_FROM → (VARIABLE|CONSTANT|PARAMETER|FUNCTION|IMPORT_BINDING)
    //     PROPERTY_ACCESS → WRITES_TO  → (LITERAL|PROPERTY_ACCESS|REFERENCE|CALL|...)
    {
        // Build: compactable node → its redirect target
        const COMPACT_RULES: &[(&str, &str)] = &[
            ("REFERENCE", "READS_FROM"),
            ("PROPERTY_ACCESS", "WRITES_TO"),
        ];

        // First pass: build outgoing edge map for compactable nodes
        let compactable_ids: HashSet<&str> = nodes_by_id.iter()
            .filter(|(_, n)| COMPACT_RULES.iter().any(|(nt, _)| *nt == n.node_type))
            .map(|(id, _)| id.as_str())
            .collect();

        // Map each compactable node → its redirect target via the specific edge type
        let mut redirect: HashMap<String, String> = HashMap::new();
        for (src, dst, etype) in &non_structural_edges {
            if let Some(node) = nodes_by_id.get(src.as_str()) {
                if compactable_ids.contains(src.as_str()) {
                    for &(nt, et) in COMPACT_RULES {
                        if node.node_type == nt && etype == et {
                            redirect.entry(src.clone()).or_insert_with(|| dst.clone());
                        }
                    }
                }
            }
        }

        // Resolve chains: REFERENCE → PROPERTY_ACCESS → target
        // (A compacted node may point to another compacted node)
        let mut resolved = 0;
        for _ in 0..5 {
            let mut changed = false;
            let snapshot: Vec<(String, String)> = redirect.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            for (src, dst) in snapshot {
                if let Some(further) = redirect.get(&dst) {
                    if *further != dst {
                        redirect.insert(src, further.clone());
                        changed = true;
                        resolved += 1;
                    }
                }
            }
            if !changed { break; }
        }

        // Redirect incoming edges: replace dst with redirect target
        let compacted = redirect.len();
        let mut redirected_edges = 0;
        for edge in &mut non_structural_edges {
            // If edge points TO a compacted node, redirect to its target
            if let Some(target) = redirect.get(&edge.1) {
                edge.1 = target.clone();
                redirected_edges += 1;
            }
            // If edge comes FROM a compacted node, redirect to its target
            if let Some(target) = redirect.get(&edge.0) {
                edge.0 = target.clone();
                redirected_edges += 1;
            }
        }

        // Remove self-loops created by compaction
        non_structural_edges.retain(|e| e.0 != e.1);

        // Remove compacted nodes from children lists of their parents
        for (cid, _) in &redirect {
            if let Some(node) = nodes_by_id.get(cid) {
                if let Some(ref pid) = node.parent_id {
                    let pid = pid.clone();
                    if let Some(parent) = nodes_by_id.get_mut(&pid) {
                        parent.children.retain(|c| !redirect.contains_key(c));
                    }
                }
            }
        }

        // Mark compacted nodes so step 5 excludes them
        for cid in redirect.keys() {
            if let Some(node) = nodes_by_id.get_mut(cid.as_str()) {
                node.node_type = "COMPACTED".to_string();
            }
        }

        tracing::info!("Compacted {} pass-through nodes ({} chains resolved, {} edges redirected)",
            compacted, resolved, redirected_edges);
    }

    // 5. Identify renderable nodes.
    //    - Compacted nodes are always excluded
    //    - Container types with children are excluded (they become container borders)
    //    - Container types without children: only definitions (FUNCTION, METHOD, CLASS,
    //      INTERFACE, STRUCT, ENUM) are promoted to tiles; structural containers
    //      (SCOPE, LOOP, BRANCH, etc.) are excluded even without children
    const DEFINITION_CONTAINERS: &[&str] = &[
        "FUNCTION", "METHOD", "CLASS", "INTERFACE",
    ];
    let leaf_ids: HashSet<String> = nodes_by_id.iter()
        .filter(|(_, n)| {
            if n.node_type == "COMPACTED" { return false; }
            if !CONTAINER_TYPES.contains(&n.node_type.as_str()) { return true; }
            // Container type — render only if childless AND a definition type
            n.children.is_empty() && DEFINITION_CONTAINERS.contains(&n.node_type.as_str())
        })
        .map(|(id, _)| id.clone())
        .collect();
    tracing::info!("{} renderable nodes out of {} total", leaf_ids.len(), nodes_by_id.len());

    // 6. Build leaf adjacency.
    //    - Same-file affinity: renderable nodes in same file attract each other (weight 3)
    //    - CONTAINS affinity: if a renderable node is inside a container, connect to
    //      other renderable nodes inside the same container (weight 4)
    //    - Non-structural edges: if both endpoints are renderable, connect directly;
    //      if an endpoint is a container, find its nearest renderable descendant
    let mut leaf_adj: Adjacency = HashMap::new();

    // Helper: find renderable descendants
    fn find_renderable_descendants(
        id: &str,
        nodes: &HashMap<String, LayoutNode>,
        leaf_ids: &HashSet<String>,
        out: &mut Vec<String>,
    ) {
        if leaf_ids.contains(id) {
            out.push(id.to_string());
            return;
        }
        if let Some(node) = nodes.get(id) {
            for child in &node.children {
                find_renderable_descendants(child, nodes, leaf_ids, out);
            }
        }
    }

    // Same-file affinity: group renderable nodes by file
    let mut by_file: HashMap<&str, Vec<&str>> = HashMap::new();
    for id in &leaf_ids {
        if let Some(node) = nodes_by_id.get(id) {
            by_file.entry(node.file.as_str()).or_default().push(id.as_str());
        }
    }
    for (_file, ids) in &by_file {
        // Connect nodes in same file with file-level affinity
        // For large files, sample to avoid O(n²)
        let max_links = 30;
        let step = if ids.len() > max_links { ids.len() / max_links } else { 1 };
        for i in (0..ids.len()).step_by(step) {
            for j in (i+1..ids.len()).step_by(step) {
                if j - i > max_links { break; }
                leaf_adj.entry(ids[i].to_string()).or_default().push((ids[j].to_string(), 3));
                leaf_adj.entry(ids[j].to_string()).or_default().push((ids[i].to_string(), 3));
            }
        }
    }

    // CONTAINS sibling affinity: renderable nodes under same container
    for node in nodes_by_id.values() {
        if node.children.is_empty() { continue; }
        let mut child_renderables = Vec::new();
        for child_id in &node.children {
            find_renderable_descendants(child_id, &nodes_by_id, &leaf_ids, &mut child_renderables);
        }
        if child_renderables.len() < 2 { continue; }
        let w: u32 = match node.node_type.as_str() {
            "FUNCTION" | "METHOD" => 5,
            "CLASS" | "INTERFACE" => 4,
            _ => 3,
        };
        let max_links = 20;
        let step = if child_renderables.len() > max_links { child_renderables.len() / max_links } else { 1 };
        for i in (0..child_renderables.len()).step_by(step) {
            for j in (i+1..child_renderables.len()).step_by(step) {
                if j - i > max_links { break; }
                leaf_adj.entry(child_renderables[i].clone()).or_default().push((child_renderables[j].clone(), w));
                leaf_adj.entry(child_renderables[j].clone()).or_default().push((child_renderables[i].clone(), w));
            }
        }
    }

    // Non-structural edges: lift through containers to renderables
    for (src_id, dst_id, _etype) in &non_structural_edges {
        let mut src_renderables = Vec::new();
        let mut dst_renderables = Vec::new();
        find_renderable_descendants(src_id, &nodes_by_id, &leaf_ids, &mut src_renderables);
        find_renderable_descendants(dst_id, &nodes_by_id, &leaf_ids, &mut dst_renderables);
        // Cap fanout for edges between large containers
        let max_cross = 10;
        for (si, sl) in src_renderables.iter().enumerate() {
            if si >= max_cross { break; }
            for (di, dl) in dst_renderables.iter().enumerate() {
                if di >= max_cross { break; }
                if sl != dl {
                    leaf_adj.entry(sl.clone()).or_default().push((dl.clone(), 1));
                    leaf_adj.entry(dl.clone()).or_default().push((sl.clone(), 1));
                }
            }
        }
    }

    // 7. Two-level force simulation + sequential BFS placement
    //    Level 1: Force-directed file positions → ideal seed positions
    //    Level 2: Within-file swap optimization after BFS placement

    // Build inter-file adjacency from non-structural edges
    let mut inter_file_counts: HashMap<(String, String), u32> = HashMap::new();
    for (src_id, dst_id, _) in &non_structural_edges {
        let sf = nodes_by_id.get(src_id).map(|n| n.file.as_str()).unwrap_or("");
        let df = nodes_by_id.get(dst_id).map(|n| n.file.as_str()).unwrap_or("");
        if !sf.is_empty() && !df.is_empty() && sf != df {
            let key = if sf < df { (sf.to_string(), df.to_string()) } else { (df.to_string(), sf.to_string()) };
            *inter_file_counts.entry(key).or_default() += 1;
        }
    }

    // ── Level 1: Force-directed file positioning ──
    let file_names: Vec<String> = by_file.keys().map(|s| s.to_string()).collect();
    let n_files = file_names.len();

    // Hierarchical ordering: files grouped by pkg→dir, ordered by connectivity.
    // Guarantees contiguity within directories and packages.
    let file_order = hierarchical_file_order(&file_names, &by_file, &inter_file_counts);
    tracing::info!("Hierarchical file ordering: {} files", n_files);

    // ── Sequential BFS placement — files grow touching each other ──
    // Force sim determines WHICH file neighbors WHICH (by proximity of targets).
    // BFS seeds are always adjacent to already-placed territory → no gaps.
    let mut grid: HashSet<HexCoord> = HashSet::new();
    let mut placement: HashMap<String, HexCoord> = HashMap::new();
    let mut file_coords: HashMap<String, Vec<HexCoord>> = HashMap::new();

    for (fi, file_key) in file_order.iter().enumerate() {
        let node_ids = &by_file[file_key.as_str()];

        // Intra-file adjacency
        let file_set: HashSet<&str> = node_ids.iter().copied().collect();
        let mut intra_adj: Adjacency = HashMap::new();
        for &id in node_ids {
            if let Some(neighbors) = leaf_adj.get(id) {
                for (nid, w) in neighbors {
                    if file_set.contains(nid.as_str()) {
                        intra_adj.entry(id.to_string()).or_default().push((nid.clone(), *w));
                    }
                }
            }
        }

        // BFS node ordering within file (most connected seed, then by weight)
        let seed = node_ids.iter()
            .max_by_key(|id| intra_adj.get(**id).map(|v| v.iter().map(|(_, w)| w).sum::<u32>()).unwrap_or(0))
            .copied();

        let mut node_order: Vec<String> = Vec::with_capacity(node_ids.len());
        let mut vis: HashSet<String> = HashSet::new();
        let mut q: VecDeque<String> = VecDeque::new();
        if let Some(s) = seed {
            q.push_back(s.to_string());
            vis.insert(s.to_string());
        }
        while let Some(id) = q.pop_front() {
            node_order.push(id.clone());
            let mut nbrs: Vec<_> = intra_adj.get(&id)
                .map(|v| v.iter().collect::<Vec<_>>())
                .unwrap_or_default();
            nbrs.sort_by(|a, b| b.1.cmp(&a.1));
            for (nid, _) in nbrs {
                if vis.insert(nid.clone()) {
                    q.push_back(nid.clone());
                }
            }
        }
        for id in node_ids {
            if !vis.contains(*id) {
                node_order.push(id.to_string());
            }
        }

        // Seed position: first file at origin, subsequent files grow adjacent
        // to the placed file whose force-sim target is closest to ours.
        // Direction within anchor's boundary: pick the side facing our target.
        let actual_seed = if fi == 0 {
            HexCoord::new(0, 0)
        } else {
            let my_dir = directory_from_file(file_key);
            let my_pkg = pkg_from_file(file_key);

            // Find anchor: prefer same-dir > same-pkg > most inter-file edges
            let anchor = file_order[..fi].iter()
                .filter(|f| file_coords.contains_key(f.as_str()))
                .max_by_key(|f| {
                    let f_dir = directory_from_file(f);
                    let f_pkg = pkg_from_file(f);
                    let edge_key = if f.as_str() < file_key.as_str() {
                        (f.to_string(), file_key.to_string())
                    } else {
                        (file_key.to_string(), f.to_string())
                    };
                    let edges = inter_file_counts.get(&edge_key).copied().unwrap_or(0);
                    let dir_bonus: u32 = if f_dir == my_dir { 1_000_000 } else { 0 };
                    let pkg_bonus: u32 = if f_pkg == my_pkg { 10_000 } else { 0 };
                    dir_bonus + pkg_bonus + edges
                })
                .cloned();

            if let Some(ref anchor_file) = anchor {
                // Seed on anchor's boundary (most recently placed coords → grow adjacent)
                file_coords[anchor_file].iter().rev()
                    .flat_map(|c| c.neighbors())
                    .find(|n| !grid.contains(n))
                    .unwrap_or_else(|| find_free_adjacent_to(&file_coords[anchor_file], &grid))
            } else {
                let all_coords: Vec<HexCoord> = grid.iter().copied().collect();
                if all_coords.is_empty() { HexCoord::new(0, 0) }
                else { find_free_adjacent_to(&all_coords, &grid) }
            }
        };

        // BFS growth: place all nodes expanding from seed
        grid.insert(actual_seed);
        placement.insert(node_order[0].clone(), actual_seed);

        let mut hex_visited: HashSet<HexCoord> = HashSet::new();
        hex_visited.insert(actual_seed);
        let mut hex_queue: VecDeque<HexCoord> = VecDeque::new();
        for n in actual_seed.neighbors() {
            if hex_visited.insert(n) {
                hex_queue.push_back(n);
            }
        }

        let mut coords_for_file: Vec<HexCoord> = vec![actual_seed];
        let mut placed = 1;

        while placed < node_order.len() {
            if let Some(coord) = hex_queue.pop_front() {
                if grid.contains(&coord) { continue; }
                grid.insert(coord);
                placement.insert(node_order[placed].clone(), coord);
                coords_for_file.push(coord);
                placed += 1;

                for n in coord.neighbors() {
                    if hex_visited.insert(n) {
                        hex_queue.push_back(n);
                    }
                }
            } else {
                let coord = find_nearest_free(&grid, actual_seed);
                grid.insert(coord);
                placement.insert(node_order[placed].clone(), coord);
                coords_for_file.push(coord);
                placed += 1;
            }
        }

        file_coords.insert(file_key.clone(), coords_for_file);
    }

    tracing::info!("BFS placement: {} tiles in {:?}", placement.len(), t0.elapsed());

    // ── Level 2: Within-file swap optimization ──
    // Reduce total intra-file edge length by swapping adjacent same-file nodes.
    // Contiguity is always preserved because both positions remain in the same file.
    {
        let mut coord_to_id: HashMap<HexCoord, String> = HashMap::new();
        for (id, &coord) in &placement {
            coord_to_id.insert(coord, id.clone());
        }

        // Build intra-file non-structural edge adjacency for cost computation
        let mut swap_adj: Adjacency = HashMap::new();
        for (src_id, dst_id, _etype) in &non_structural_edges {
            if !placement.contains_key(src_id) || !placement.contains_key(dst_id) { continue; }
            if nodes_by_id[src_id].file != nodes_by_id[dst_id].file { continue; }
            swap_adj.entry(src_id.clone()).or_default().push((dst_id.clone(), 1));
            swap_adj.entry(dst_id.clone()).or_default().push((src_id.clone(), 1));
        }

        let max_passes = 5;
        for pass in 0..max_passes {
            let mut swaps = 0;
            let node_ids: Vec<String> = placement.keys().cloned().collect();

            for node_id in &node_ids {
                let node_coord = placement[node_id];
                let node_file = &nodes_by_id[node_id].file;
                let current_cost = swap_edge_cost(node_id, node_coord, &placement, &swap_adj);
                if current_cost == 0.0 { continue; } // no intra-file edges

                for neighbor_coord in node_coord.neighbors() {
                    let neighbor_id = match coord_to_id.get(&neighbor_coord) {
                        Some(id) => id.clone(),
                        None => continue,
                    };
                    if &nodes_by_id[&neighbor_id].file != node_file { continue; }

                    // Cost of swapping positions
                    let old_neighbor_cost = swap_edge_cost(&neighbor_id, neighbor_coord, &placement, &swap_adj);
                    let new_node_cost = swap_edge_cost(node_id, neighbor_coord, &placement, &swap_adj);
                    let new_neighbor_cost = swap_edge_cost(&neighbor_id, node_coord, &placement, &swap_adj);

                    if new_node_cost + new_neighbor_cost < current_cost + old_neighbor_cost {
                        // Perform swap
                        placement.insert(node_id.clone(), neighbor_coord);
                        placement.insert(neighbor_id.clone(), node_coord);
                        coord_to_id.insert(node_coord, neighbor_id);
                        coord_to_id.insert(neighbor_coord, node_id.clone());
                        swaps += 1;
                        break; // re-evaluate from new position
                    }
                }
            }

            tracing::info!("Swap pass {}: {} swaps", pass, swaps);
            if swaps == 0 { break; }
        }
    }

    tracing::info!("Placed {} leaf tiles in {:?}", placement.len(), t0.elapsed());

    // 8. Build output — only leaves are tiles
    //    Regions = files (each file gets a distinct color)
    //    LOD = depth in containment tree
    let mut type_table: Vec<String> = Vec::new();
    let mut type_to_idx: HashMap<String, u8> = HashMap::new();
    let mut edge_type_table: Vec<String> = Vec::new();
    let mut edge_type_to_idx: HashMap<String, u8> = HashMap::new();

    let mut file_to_region: HashMap<String, u16> = HashMap::new();
    let mut regions: Vec<Region> = Vec::new();
    let mut tiles: Vec<PlacedTile> = Vec::new();
    let mut node_to_tile: HashMap<String, u32> = HashMap::new();
    let mut max_depth: u8 = 0;

    // Deterministic order
    let mut placed_ids: Vec<String> = placement.keys().cloned().collect();
    placed_ids.sort();

    for node_id in &placed_ids {
        let coord = placement[node_id];
        let node = &nodes_by_id[node_id];

        let _type_idx = *type_to_idx.entry(node.node_type.clone()).or_insert_with(|| {
            let idx = type_table.len() as u8;
            type_table.push(node.node_type.clone());
            idx
        });

        // Regions by file (not directory) — distinct color per file
        let file_key = node.file.clone();
        let region_idx = *file_to_region.entry(file_key.clone()).or_insert_with(|| {
            let idx = regions.len() as u16;
            let dir = directory_from_file(&file_key);
            regions.push(Region {
                path: file_key.clone(),
                depth: dir.matches('/').count().saturating_sub(1) as u8,
                tile_count: 0,
                border: Vec::new(),
                center: [0.0, 0.0],
                children: Vec::new(),
                hue: 0.0,
            });
            idx
        });
        regions[region_idx as usize].tile_count += 1;

        // Depth-based LOD
        let depth = compute_depth(node_id, &nodes_by_id);
        if depth > max_depth { max_depth = depth; }

        let tile_idx = tiles.len() as u32;
        node_to_tile.insert(node_id.clone(), tile_idx);

        tiles.push(PlacedTile {
            node_id: node_id.clone(),
            coord,
            node_type: node.node_type.clone(),
            name: node.name.clone(),
            file: node.file.clone(),
            container_idx: node.parent_id.as_ref()
                .and_then(|pid| node_to_tile.get(pid))
                .copied()
                .unwrap_or(u32::MAX),
            region_idx,
            lod_level: depth,
            pkg_idx: 0,
            dir_idx: 0,
            file_hier_idx: 0,
            fn_idx: 0,
            is_filler: false,
        });
    }
    tracing::info!("Max containment depth: {}", max_depth);

    // 9. Build edges
    let mut layout_edges: Vec<LayoutEdge> = Vec::new();
    for (src_id, dst_id, etype) in &non_structural_edges {
        if let (Some(&si), Some(&di)) = (node_to_tile.get(src_id), node_to_tile.get(dst_id)) {
            let et_idx = *edge_type_to_idx.entry(etype.clone()).or_insert_with(|| {
                let idx = edge_type_table.len() as u8;
                edge_type_table.push(etype.clone());
                idx
            });
            layout_edges.push(LayoutEdge { src_idx: si, dst_idx: di, edge_type_idx: et_idx });
        }
    }

    // 10. Region (file) borders + centroids
    for (region_idx, region) in regions.iter_mut().enumerate() {
        let region_tiles: Vec<HexCoord> = tiles.iter()
            .filter(|t| t.region_idx == region_idx as u16)
            .map(|t| t.coord)
            .collect();

        if region_tiles.is_empty() { continue; }

        region.border = compute_border(&region_tiles, tile_size);

        let (mut cx, mut cz) = (0.0f32, 0.0f32);
        for &coord in &region_tiles {
            let (x, z) = coord.to_world(tile_size);
            cx += x;
            cz += z;
        }
        let n = region_tiles.len() as f32;
        region.center = [cx / n, cz / n];
    }

    // 10b. Region hues — will be set from hierarchy after color_hierarchy() runs.
    // (Graph coloring removed: all sub-regions derive hue from their package.)

    // 11. Container metadata — for each container with placed leaves, compute border + info
    let mut containers: Vec<ContainerInfo> = Vec::new();
    for (cid, cnode) in &nodes_by_id {
        if !CONTAINER_TYPES.contains(&cnode.node_type.as_str()) { continue; }
        if cnode.children.is_empty() { continue; }

        // Collect placed leaf tile coords under this container
        let mut descendant_coords: Vec<HexCoord> = Vec::new();
        let mut stack = vec![cid.as_str()];
        while let Some(id) = stack.pop() {
            if let Some(tc) = node_to_tile.get(id) {
                descendant_coords.push(tiles[*tc as usize].coord);
            }
            if let Some(n) = nodes_by_id.get(id) {
                for child in &n.children {
                    stack.push(child.as_str());
                }
            }
        }

        if descendant_coords.len() < 2 { continue; }

        let border = compute_border(&descendant_coords, tile_size);
        let (mut cx, mut cz) = (0.0f32, 0.0f32);
        for &coord in &descendant_coords {
            let (x, z) = coord.to_world(tile_size);
            cx += x;
            cz += z;
        }
        let n = descendant_coords.len() as f32;
        let depth = compute_depth(cid, &nodes_by_id);

        // Hue will be set from hierarchy after color_hierarchy() runs
        let hue = 0.0;

        containers.push(ContainerInfo {
            name: cnode.name.clone(),
            container_type: cnode.node_type.clone(),
            depth,
            border,
            center: [cx / n, cz / n],
            tile_count: descendant_coords.len() as u32,
            hue,
            node_id: cid.clone(),
        });
    }
    // Sort by depth (shallowest first) for layered rendering
    containers.sort_by_key(|c| c.depth);

    // Build container node_id → index map (after sort so indices are stable)
    let container_node_map: HashMap<String, usize> = containers.iter().enumerate()
        .map(|(i, c)| (c.node_id.clone(), i))
        .collect();

    // 12. Aggregated inter-region edges
    let mut agg_map: HashMap<(u16, u16), HashMap<u8, u16>> = HashMap::new();
    for edge in &layout_edges {
        let sr = tiles[edge.src_idx as usize].region_idx;
        let dr = tiles[edge.dst_idx as usize].region_idx;
        if sr != dr {
            let key = if sr < dr { (sr, dr) } else { (dr, sr) };
            *agg_map.entry(key).or_default().entry(edge.edge_type_idx).or_insert(0) += 1;
        }
    }

    let agg_edges: Vec<AggEdge> = agg_map.into_iter().map(|((sr, dr), types)| {
        let total: u16 = types.values().sum();
        let dominant = types.into_iter().max_by_key(|&(_, c)| c).map(|(t, _)| t).unwrap_or(0);
        AggEdge { src_region: sr, dst_region: dr, count: total, dominant_type_idx: dominant }
    }).collect();

    // 13. Connected component detection
    let components = detect_components(&tiles, &layout_edges);
    let component_count = components.iter().copied().max().map(|m| m + 1).unwrap_or(0);

    // 14. Fill gaps between tiles of the same component
    let fillers = fill_gaps(&mut tiles, &mut grid, &regions, &components, tile_size, &mut node_to_tile, &type_table);
    tracing::info!("Gap fill: {} filler tiles added", fillers);

    // Recompute borders for regions that got filler tiles
    if fillers > 0 {
        for (region_idx, region) in regions.iter_mut().enumerate() {
            let region_tiles: Vec<HexCoord> = tiles.iter()
                .filter(|t| t.region_idx == region_idx as u16)
                .map(|t| t.coord)
                .collect();
            if region_tiles.is_empty() { continue; }
            region.border = compute_border(&region_tiles, tile_size);
            let (mut cx, mut cz) = (0.0f32, 0.0f32);
            for &coord in &region_tiles {
                let (x, z) = coord.to_world(tile_size);
                cx += x;
                cz += z;
            }
            let n = region_tiles.len() as f32;
            region.center = [cx / n, cz / n];
            region.tile_count = region_tiles.len() as u32;
        }
    }

    // Extend components vec for filler tiles
    let mut components = components;
    while components.len() < tiles.len() {
        components.push(0);
    }

    // 15. Build directory hierarchy
    tracing::info!("Building directory hierarchy...");
    let mut hierarchy = build_directory_hierarchy(&regions, &tiles, &containers, tile_size);
    tracing::info!("Hierarchy: {} nodes, coloring...", hierarchy.len());
    color_hierarchy(&mut hierarchy);

    // 15b. Propagate hierarchy hues back to regions and containers
    {
        // File hierarchy node hue → region hue
        for h in &hierarchy {
            if matches!(h.kind, RegionKind::File) {
                if let Some(&ri) = file_to_region.get(&h.id) {
                    regions[ri as usize].hue = h.hue;
                }
            }
        }
        // Container hue: find file from any tile belonging to this container
        let mut container_to_file: HashMap<u32, String> = HashMap::new();
        for tile in &tiles {
            if tile.container_idx != u32::MAX && tile.container_idx < containers.len() as u32 {
                container_to_file.entry(tile.container_idx)
                    .or_insert_with(|| tile.file.clone());
            }
        }
        for (ci, c) in containers.iter_mut().enumerate() {
            if let Some(file_path) = container_to_file.get(&(ci as u32)) {
                if let Some(&ri) = file_to_region.get(file_path) {
                    c.hue = regions[ri as usize].hue;
                }
            }
        }
    }

    // 16. Assign hierarchy indices to tiles
    {
        let mut pkg_map: HashMap<String, u8> = HashMap::new();
        let mut dir_map: HashMap<String, u8> = HashMap::new();
        let mut file_map: HashMap<String, u16> = HashMap::new();
        let mut fn_map: HashMap<String, u16> = HashMap::new();

        for (hi, h) in hierarchy.iter().enumerate() {
            match h.kind {
                RegionKind::Package => { pkg_map.entry(h.id.clone()).or_insert(hi as u8); }
                RegionKind::Directory => { dir_map.entry(h.id.clone()).or_insert(hi as u8); }
                RegionKind::File => { file_map.entry(h.id.clone()).or_insert(hi as u16); }
                RegionKind::Function => { fn_map.entry(h.id.clone()).or_insert(hi as u16); }
                _ => {}
            }
        }

        for tile in &mut tiles {
            let file_path = &tile.file;
            let parts: Vec<&str> = file_path.split('/').collect();

            if parts.len() >= 2 {
                let pkg_key = format!("{}/{}", parts[0], parts[1]);
                tile.pkg_idx = pkg_map.get(&pkg_key).copied().unwrap_or(0);
            }

            if let Some(dir_pos) = file_path.rfind('/') {
                let dir_key = &file_path[..dir_pos];
                tile.dir_idx = dir_map.get(dir_key).copied().unwrap_or(0);
            }

            tile.file_hier_idx = file_map.get(file_path).copied().unwrap_or(0);
        }

        // Build container_idx → fn_hier_idx map for O(tiles) instead of O(containers × tiles)
        let mut ci_to_fn: HashMap<u32, u16> = HashMap::new();
        for (ci, c) in containers.iter().enumerate() {
            let fn_hier_idx = fn_map.get(&c.node_id).copied().unwrap_or(0);
            ci_to_fn.insert(ci as u32, fn_hier_idx);
        }
        for tile in &mut tiles {
            if tile.container_idx != u32::MAX {
                tile.fn_idx = ci_to_fn.get(&tile.container_idx).copied().unwrap_or(0);
            }
        }
    }

    tracing::info!(
        "Layout complete: {} tiles, {} edges, {} regions (files), {} containers, {} agg_edges, {} hierarchy nodes, {} components, max_depth={} in {:?}",
        tiles.len(), layout_edges.len(), regions.len(), containers.len(), agg_edges.len(),
        hierarchy.len(), component_count, max_depth, t0.elapsed()
    );

    Ok(HexLayout {
        tiles,
        regions,
        containers,
        edges: layout_edges,
        agg_edges,
        type_table,
        edge_type_table,
        tile_size,
        max_depth,
        node_to_tile,
        container_node_map,
        hierarchy,
        components,
    })
}

// ── Adjacent seed finder ──────────────────────────────────────────

/// Find a free hex adjacent to the given territory (for sequential region placement).
/// Scans boundary of territory — hexes that have at least one free neighbor.
fn find_free_adjacent_to(territory: &[HexCoord], grid: &HashSet<HexCoord>) -> HexCoord {
    // Prefer boundary hexes (those with a free neighbor) — scan from end (most recent)
    for &coord in territory.iter().rev() {
        for n in coord.neighbors() {
            if !grid.contains(&n) {
                return n;
            }
        }
    }
    // Fallback: BFS from last placed coord
    find_nearest_free(grid, *territory.last().unwrap_or(&HexCoord::new(0, 0)))
}

fn find_nearest_free(grid: &HashSet<HexCoord>, target: HexCoord) -> HexCoord {
    if !grid.contains(&target) { return target; }
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    queue.push_back(target);
    visited.insert(target);
    while let Some(current) = queue.pop_front() {
        for neighbor in current.neighbors() {
            if visited.insert(neighbor) {
                if !grid.contains(&neighbor) { return neighbor; }
                queue.push_back(neighbor);
            }
        }
    }
    target
}

// ── Border computation ────────────────────────────────────────────

fn compute_border(tiles: &[HexCoord], tile_size: f32) -> Vec<[f32; 2]> {
    if tiles.is_empty() { return Vec::new(); }
    let tile_set: HashSet<HexCoord> = tiles.iter().copied().collect();
    let mut segments: Vec<(f32, f32, f32, f32)> = Vec::new();

    // Neighbor direction → hex edge vertex pair.
    // neighbors() returns: (+1,0), (+1,-1), (0,-1), (-1,0), (-1,+1), (0,+1)
    // World angles:          30°,    330°,   270°,   210°,    150°,    90°
    // Matching edge verts:  v0-v1,  v5-v0,  v4-v5,  v3-v4,   v2-v3,  v1-v2
    const EDGE_V1: [usize; 6] = [0, 5, 4, 3, 2, 1];
    const EDGE_V2: [usize; 6] = [1, 0, 5, 4, 3, 2]; // (EDGE_V1 + 1) % 6, but v5→v0 wraps

    let pi3 = std::f32::consts::PI / 3.0;
    let vertex_angles: Vec<f32> = (0..6).map(|v| pi3 * v as f32).collect();

    for &tile in tiles {
        let (cx, cz) = tile.to_world(tile_size);
        let neighbors = tile.neighbors();
        for (i, &neighbor) in neighbors.iter().enumerate() {
            if !tile_set.contains(&neighbor) {
                let a1 = vertex_angles[EDGE_V1[i]];
                let a2 = vertex_angles[EDGE_V2[i]];
                segments.push((
                    cx + tile_size * a1.cos(), cz + tile_size * a1.sin(),
                    cx + tile_size * a2.cos(), cz + tile_size * a2.sin(),
                ));
            }
        }
    }

    let polygon = chain_segments(&segments, tile_size * 0.01);
    simplify_polygon(&polygon, tile_size * 0.4)
}

fn chain_segments(segments: &[(f32, f32, f32, f32)], epsilon: f32) -> Vec<[f32; 2]> {
    chain_segments_fast(segments, epsilon)
}

fn chain_segments_fast(segments: &[(f32, f32, f32, f32)], epsilon: f32) -> Vec<[f32; 2]> {
    if segments.is_empty() { return Vec::new(); }

    let inv_eps = 1.0 / epsilon;
    let quantize = |x: f32, y: f32| -> (i32, i32) {
        ((x * inv_eps).round() as i32, (y * inv_eps).round() as i32)
    };

    // Index: quantized start-point → list of (segment_index)
    let mut start_map: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
    let mut end_map: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
    for (i, s) in segments.iter().enumerate() {
        start_map.entry(quantize(s.0, s.1)).or_default().push(i);
        end_map.entry(quantize(s.2, s.3)).or_default().push(i);
    }

    let mut used = vec![false; segments.len()];
    let mut polygon: Vec<[f32; 2]> = Vec::new();

    used[0] = true;
    polygon.push([segments[0].0, segments[0].1]);
    polygon.push([segments[0].2, segments[0].3]);

    loop {
        let [lx, lz] = *polygon.last().unwrap();
        let key = quantize(lx, lz);
        let mut found = false;

        // Check segments whose start matches our current endpoint
        if let Some(indices) = start_map.get(&key) {
            for &idx in indices {
                if !used[idx] {
                    used[idx] = true;
                    polygon.push([segments[idx].2, segments[idx].3]);
                    found = true;
                    break;
                }
            }
        }

        if !found {
            // Check segments whose end matches our current endpoint (reverse)
            if let Some(indices) = end_map.get(&key) {
                for &idx in indices {
                    if !used[idx] {
                        used[idx] = true;
                        polygon.push([segments[idx].0, segments[idx].1]);
                        found = true;
                        break;
                    }
                }
            }
        }

        if !found { break; }
    }

    polygon
}

/// Ramer-Douglas-Peucker polygon simplification.
/// Removes vertices that deviate less than `epsilon` from the straight line
/// between kept vertices, turning hex-edge zigzags into clean polylines.
fn simplify_polygon(polygon: &[[f32; 2]], epsilon: f32) -> Vec<[f32; 2]> {
    if polygon.len() < 4 { return polygon.to_vec(); }

    // For closed polygons, simplify as open polyline then re-close
    let is_closed = polygon.len() > 2
        && (polygon[0][0] - polygon[polygon.len() - 1][0]).abs() < 0.01
        && (polygon[0][1] - polygon[polygon.len() - 1][1]).abs() < 0.01;

    let points = if is_closed { &polygon[..polygon.len() - 1] } else { polygon };
    if points.len() < 3 {
        return polygon.to_vec();
    }

    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;

    rdp_recurse(points, 0, points.len() - 1, epsilon * epsilon, &mut keep);

    let mut result: Vec<[f32; 2]> = points.iter().enumerate()
        .filter(|(i, _)| keep[*i])
        .map(|(_, p)| *p)
        .collect();

    if is_closed && !result.is_empty() {
        result.push(result[0]);
    }

    result
}

fn rdp_recurse(points: &[[f32; 2]], start: usize, end: usize, eps_sq: f32, keep: &mut [bool]) {
    if end <= start + 1 { return; }

    let (sx, sz) = (points[start][0], points[start][1]);
    let (ex, ez) = (points[end][0], points[end][1]);
    let dx = ex - sx;
    let dz = ez - sz;
    let len_sq = dx * dx + dz * dz;

    let mut max_dist_sq = 0.0f32;
    let mut max_idx = start;

    for i in (start + 1)..end {
        let (px, pz) = (points[i][0] - sx, points[i][1] - sz);
        let dist_sq = if len_sq < 1e-10 {
            px * px + pz * pz
        } else {
            let t = (px * dx + pz * dz) / len_sq;
            let t = t.clamp(0.0, 1.0);
            let proj_x = px - t * dx;
            let proj_z = pz - t * dz;
            proj_x * proj_x + proj_z * proj_z
        };
        if dist_sq > max_dist_sq {
            max_dist_sq = dist_sq;
            max_idx = i;
        }
    }

    if max_dist_sq > eps_sq {
        keep[max_idx] = true;
        rdp_recurse(points, start, max_idx, eps_sq, keep);
        rdp_recurse(points, max_idx, end, eps_sq, keep);
    }
}

// ── Connected components ──────────────────────────────────────────

fn detect_components(tiles: &[PlacedTile], edges: &[LayoutEdge]) -> Vec<u32> {
    let n = tiles.len();
    let mut comp = vec![u32::MAX; n];
    let mut adj: HashMap<u32, Vec<u32>> = HashMap::new();

    for edge in edges {
        adj.entry(edge.src_idx).or_default().push(edge.dst_idx);
        adj.entry(edge.dst_idx).or_default().push(edge.src_idx);
    }

    let mut component_id: u32 = 0;
    for start in 0..n {
        if comp[start] != u32::MAX { continue; }
        let mut queue = VecDeque::new();
        queue.push_back(start as u32);
        comp[start] = component_id;
        while let Some(cur) = queue.pop_front() {
            if let Some(neighbors) = adj.get(&cur) {
                for &nb in neighbors {
                    if comp[nb as usize] == u32::MAX {
                        comp[nb as usize] = component_id;
                        queue.push_back(nb);
                    }
                }
            }
        }
        component_id += 1;
    }

    comp
}

// ── Gap filling ──────────────────────────────────────────────────

fn fill_gaps(
    tiles: &mut Vec<PlacedTile>,
    grid: &mut HashSet<HexCoord>,
    regions: &[Region],
    components: &[u32],
    tile_size: f32,
    node_to_tile: &mut HashMap<String, u32>,
    type_table: &[String],
) -> usize {
    let max_fillers = tiles.len() / 5; // cap at 20%
    let mut added = 0;

    // Build coord → tile index map
    let mut coord_to_tile: HashMap<HexCoord, u32> = HashMap::new();
    for (i, tile) in tiles.iter().enumerate() {
        coord_to_tile.insert(tile.coord, i as u32);
    }

    // Region centers for nearest-region assignment
    let region_centers: Vec<HexCoord> = regions.iter().map(|r| {
        world_to_hex(r.center[0] as f64, r.center[1] as f64, tile_size as f64)
    }).collect();

    // Find empty hexes adjacent to ≥2 occupied hexes of same component
    let mut candidates: Vec<(HexCoord, u32, u16)> = Vec::new(); // (coord, component, region)

    let all_coords: Vec<HexCoord> = grid.iter().copied().collect();
    let mut checked: HashSet<HexCoord> = HashSet::new();

    for &coord in &all_coords {
        for neighbor in coord.neighbors() {
            if grid.contains(&neighbor) || !checked.insert(neighbor) { continue; }

            // Count adjacent occupied hexes by component
            let mut comp_counts: HashMap<u32, Vec<u16>> = HashMap::new();
            for adj in neighbor.neighbors() {
                if let Some(&ti) = coord_to_tile.get(&adj) {
                    if (ti as usize) < components.len() {
                        let c = components[ti as usize];
                        comp_counts.entry(c).or_default().push(tiles[ti as usize].region_idx);
                    }
                }
            }

            for (comp, region_indices) in &comp_counts {
                if region_indices.len() >= 2 {
                    // Assign to nearest region
                    let nearest_region = region_indices.iter()
                        .min_by_key(|&&ri| {
                            if (ri as usize) < region_centers.len() {
                                neighbor.distance(region_centers[ri as usize])
                            } else {
                                i32::MAX
                            }
                        })
                        .copied()
                        .unwrap_or(region_indices[0]);
                    candidates.push((neighbor, *comp, nearest_region));
                    break;
                }
            }
        }
    }

    // Sort by distance to region center (closest first)
    candidates.sort_by_key(|(coord, _, ri)| {
        if (*ri as usize) < region_centers.len() {
            coord.distance(region_centers[*ri as usize])
        } else {
            i32::MAX
        }
    });

    for (coord, _comp, region_idx) in candidates {
        if added >= max_fillers { break; }
        if grid.contains(&coord) { continue; }

        grid.insert(coord);
        let filler_id = format!("__filler_{}", tiles.len());
        let tile_idx = tiles.len() as u32;
        node_to_tile.insert(filler_id.clone(), tile_idx);

        tiles.push(PlacedTile {
            node_id: filler_id,
            coord,
            node_type: type_table.first().cloned().unwrap_or_else(|| "FILLER".to_string()),
            name: String::new(),
            file: regions.get(region_idx as usize).map(|r| r.path.clone()).unwrap_or_default(),
            container_idx: u32::MAX,
            region_idx,
            lod_level: 0,
            pkg_idx: 0,
            dir_idx: 0,
            file_hier_idx: 0,
            fn_idx: 0,
            is_filler: true,
        });

        coord_to_tile.insert(coord, tile_idx);
        added += 1;
    }

    added
}

// ── Directory hierarchy ──────────────────────────────────────────

fn build_directory_hierarchy(
    regions: &[Region],
    tiles: &[PlacedTile],
    containers: &[ContainerInfo],
    tile_size: f32,
) -> Vec<HierarchyNode> {
    let mut hierarchy: Vec<HierarchyNode> = Vec::new();
    let mut id_to_idx: HashMap<String, u32> = HashMap::new();

    // Root node
    hierarchy.push(HierarchyNode {
        id: "/".to_string(),
        level: 0,
        kind: RegionKind::Root,
        parent_idx: None,
        children_indices: Vec::new(),
        all_tile_count: tiles.len() as u32,
        border: Vec::new(),
        center: [0.0, 0.0],
        hue: 0.0,
        saturation: 0.0,
        lightness: 0.0,
    });
    id_to_idx.insert("/".to_string(), 0);

    // Collect tiles per region for coordinate lookups
    let mut region_tile_coords: HashMap<u16, Vec<HexCoord>> = HashMap::new();
    for tile in tiles {
        region_tile_coords.entry(tile.region_idx).or_default().push(tile.coord);
    }

    // Parse each region (file) path to build package and directory nodes
    let mut pkg_set: HashSet<String> = HashSet::new();
    let mut dir_set: HashSet<String> = HashSet::new();

    for region in regions {
        let parts: Vec<&str> = region.path.split('/').collect();
        if parts.len() < 2 { continue; }

        // Package = first 2 path segments
        let pkg_key = format!("{}/{}", parts[0], parts[1]);
        if pkg_set.insert(pkg_key.clone()) {
            let idx = hierarchy.len() as u32;
            hierarchy.push(HierarchyNode {
                id: pkg_key.clone(),
                level: 1,
                kind: RegionKind::Package,
                parent_idx: Some(0),
                children_indices: Vec::new(),
                all_tile_count: 0,
                border: Vec::new(),
                center: [0.0, 0.0],
                hue: 0.0,
                saturation: 0.0,
                lightness: 0.0,
            });
            id_to_idx.insert(pkg_key.clone(), idx);
            hierarchy[0].children_indices.push(idx);
        }

        // Directories: build each intermediate directory level
        for depth in 2..parts.len() {
            let dir_key = parts[..depth].join("/");
            if dir_set.insert(dir_key.clone()) {
                let parent_key = if depth == 2 {
                    pkg_key.clone()
                } else {
                    parts[..depth - 1].join("/")
                };
                let parent_idx = id_to_idx.get(&parent_key).copied();
                let idx = hierarchy.len() as u32;
                hierarchy.push(HierarchyNode {
                    id: dir_key.clone(),
                    level: depth as u8,
                    kind: RegionKind::Directory,
                    parent_idx,
                    children_indices: Vec::new(),
                    all_tile_count: 0,
                    border: Vec::new(),
                    center: [0.0, 0.0],
                    hue: 0.0,
                    saturation: 0.0,
                    lightness: 0.0,
                });
                id_to_idx.insert(dir_key, idx);
                if let Some(pi) = parent_idx {
                    hierarchy[pi as usize].children_indices.push(idx);
                }
            }
        }

        // File node
        let file_key = region.path.clone();
        if !id_to_idx.contains_key(&file_key) {
            let parent_key = if parts.len() >= 2 {
                parts[..parts.len() - 1].join("/")
            } else {
                "/".to_string()
            };
            let parent_idx = id_to_idx.get(&parent_key).copied();
            let idx = hierarchy.len() as u32;
            hierarchy.push(HierarchyNode {
                id: file_key.clone(),
                level: parts.len() as u8,
                kind: RegionKind::File,
                parent_idx,
                children_indices: Vec::new(),
                all_tile_count: region.tile_count,
                border: region.border.clone(),
                center: region.center,
                hue: region.hue,
                saturation: 80.0,
                lightness: 35.0,
            });
            id_to_idx.insert(file_key, idx);
            if let Some(pi) = parent_idx {
                hierarchy[pi as usize].children_indices.push(idx);
            }
        }
    }

    // Pre-build container node_id → file path map (O(containers) via ContainerInfo which has hue matching a file)
    // ContainerInfo already tracks which file it belongs to via matching region hue, but we need
    // to find the file directly. Use tiles: find any tile whose container matches.
    let mut container_file_map: HashMap<&str, &str> = HashMap::new();
    for tile in tiles {
        if tile.container_idx != u32::MAX && tile.container_idx < containers.len() as u32 {
            let c = &containers[tile.container_idx as usize];
            container_file_map.entry(c.node_id.as_str()).or_insert(tile.file.as_str());
        }
    }

    // Function/container nodes
    for container in containers {
        let ct = container.container_type.as_str();
        let kind = match ct {
            "FUNCTION" | "METHOD" | "CLASS" | "INTERFACE" => RegionKind::Function,
            _ => RegionKind::Block,
        };

        // Find file parent for this container via pre-built map
        let file_parent = container_file_map.get(container.node_id.as_str())
            .and_then(|file| id_to_idx.get(*file).copied());

        let idx = hierarchy.len() as u32;
        hierarchy.push(HierarchyNode {
            id: container.node_id.clone(),
            level: container.depth + 3,
            kind,
            parent_idx: file_parent,
            children_indices: Vec::new(),
            all_tile_count: container.tile_count,
            border: container.border.clone(),
            center: container.center,
            hue: container.hue,
            saturation: 80.0,
            lightness: 35.0,
        });
        id_to_idx.insert(container.node_id.clone(), idx);
        if let Some(pi) = file_parent {
            hierarchy[pi as usize].children_indices.push(idx);
        }
    }

    // Pre-build file → coords map for fast hierarchy border computation
    let mut file_coords_map: HashMap<&str, Vec<HexCoord>> = HashMap::new();
    for tile in tiles.iter() {
        file_coords_map.entry(tile.file.as_str()).or_default().push(tile.coord);
    }

    // Bottom-up: compute all_tile_count, border, center for non-leaf nodes
    let order: Vec<usize> = {
        let mut o: Vec<usize> = (0..hierarchy.len()).collect();
        o.sort_by(|a, b| hierarchy[*b].level.cmp(&hierarchy[*a].level));
        o
    };

    // Pre-collect file paths per hierarchy node for O(files) instead of O(tiles)
    let file_paths: Vec<&str> = file_coords_map.keys().copied().collect();

    for &hi in &order {
        if hierarchy[hi].children_indices.is_empty() { continue; }

        let child_indices = hierarchy[hi].children_indices.clone();
        let mut total_tiles = 0u32;
        let mut cx_sum = 0.0f32;
        let mut cz_sum = 0.0f32;
        let mut point_count = 0u32;

        for &ci in &child_indices {
            let child = &hierarchy[ci as usize];
            total_tiles += child.all_tile_count;
            cx_sum += child.center[0] * child.all_tile_count as f32;
            cz_sum += child.center[1] * child.all_tile_count as f32;
            point_count += child.all_tile_count;
        }

        hierarchy[hi].all_tile_count = total_tiles;
        if point_count > 0 {
            hierarchy[hi].center = [cx_sum / point_count as f32, cz_sum / point_count as f32];
        }

        // Collect coords from matching files (O(files) not O(tiles))
        // Skip Root border — too expensive and not visually useful
        if matches!(hierarchy[hi].kind, RegionKind::Root) { continue; }

        let hier_id = &hierarchy[hi].id;
        let prefix = format!("{}/", hier_id);
        let mut all_coords: Vec<HexCoord> = Vec::new();
        for &fp in &file_paths {
            if fp.starts_with(prefix.as_str()) || fp == hier_id.as_str() {
                if let Some(coords) = file_coords_map.get(fp) {
                    all_coords.extend_from_slice(coords);
                }
            }
        }

        if !all_coords.is_empty() {
            hierarchy[hi].border = compute_border(&all_coords, tile_size);
        }
    }

    hierarchy
}

// ── Multi-level graph coloring ───────────────────────────────────

fn color_hierarchy(hierarchy: &mut Vec<HierarchyNode>) {
    let slot_hues: Vec<f32> = (0..12).map(|i| (i as f32 * 137.508) % 360.0).collect();

    // Level 1 (packages): golden-angle hues — each package gets a distinct base hue
    let mut pkg_idx = 0u8;
    for h in hierarchy.iter_mut() {
        if matches!(h.kind, RegionKind::Package) {
            h.hue = slot_hues[(pkg_idx as usize) % 12];
            h.saturation = 75.0;
            h.lightness = 30.0;
            pkg_idx += 1;
        }
    }

    // Level 2+ (directories): SAME hue as parent package, vary lightness/saturation
    let len = hierarchy.len();
    for i in 0..len {
        if !matches!(hierarchy[i].kind, RegionKind::Directory) { continue; }
        let parent_hue = hierarchy[i].parent_idx
            .map(|pi| hierarchy[pi as usize].hue)
            .unwrap_or(0.0);

        let (sibling_order, sibling_count) = hierarchy[i].parent_idx
            .map(|pi| {
                let children = &hierarchy[pi as usize].children_indices;
                let order = children.iter()
                    .position(|&ci| ci == i as u32)
                    .unwrap_or(0);
                (order, children.len())
            })
            .unwrap_or((0, 1));

        // Spread lightness evenly across siblings: 20..45 range
        let t = if sibling_count > 1 {
            sibling_order as f32 / (sibling_count - 1) as f32
        } else {
            0.5
        };
        hierarchy[i].hue = parent_hue;
        hierarchy[i].saturation = 65.0 + t * 20.0; // 65..85
        hierarchy[i].lightness = 20.0 + t * 25.0;  // 20..45
    }

    // Level 3+ (files): SAME hue as parent directory, vary lightness within dir range
    for i in 0..len {
        if !matches!(hierarchy[i].kind, RegionKind::File) { continue; }
        let parent_hue = hierarchy[i].parent_idx
            .map(|pi| hierarchy[pi as usize].hue)
            .unwrap_or(0.0);
        let parent_sat = hierarchy[i].parent_idx
            .map(|pi| hierarchy[pi as usize].saturation)
            .unwrap_or(75.0);
        let parent_light = hierarchy[i].parent_idx
            .map(|pi| hierarchy[pi as usize].lightness)
            .unwrap_or(30.0);

        let (sibling_order, sibling_count) = hierarchy[i].parent_idx
            .map(|pi| {
                let children = &hierarchy[pi as usize].children_indices;
                let order = children.iter()
                    .position(|&ci| ci == i as u32)
                    .unwrap_or(0);
                (order, children.len())
            })
            .unwrap_or((0, 1));

        // Files vary lightness ±8 around parent lightness, saturation ±10
        let t = if sibling_count > 1 {
            sibling_order as f32 / (sibling_count - 1) as f32
        } else {
            0.5
        };
        hierarchy[i].hue = parent_hue; // NO hue shift
        hierarchy[i].saturation = (parent_sat - 10.0 + t * 20.0).clamp(40.0, 95.0);
        hierarchy[i].lightness = (parent_light - 8.0 + t * 16.0).clamp(15.0, 50.0);
    }

    // Function/Block: inherit from file parent
    for i in 0..len {
        if !matches!(hierarchy[i].kind, RegionKind::Function | RegionKind::Block) { continue; }
        if let Some(pi) = hierarchy[i].parent_idx {
            hierarchy[i].hue = hierarchy[pi as usize].hue;
            hierarchy[i].saturation = hierarchy[pi as usize].saturation;
            hierarchy[i].lightness = hierarchy[pi as usize].lightness;
        }
    }

    // Root
    if !hierarchy.is_empty() {
        hierarchy[0].hue = 0.0;
        hierarchy[0].saturation = 0.0;
        hierarchy[0].lightness = 50.0;
    }
}

// ── Batch computation ─────────────────────────────────────────────

pub fn compute_batches(layout: &HexLayout) -> Vec<StreamBatch> {
    let mut batches = Vec::new();

    // Batch 0: Region metadata
    let component_count = layout.components.iter().copied().max().map(|m| m + 1).unwrap_or(0);
    let meta = RegionMetaBatch {
        regions: layout.regions.clone(),
        containers: layout.containers.clone(),
        type_table: layout.type_table.clone(),
        edge_type_table: layout.edge_type_table.clone(),
        tile_size: layout.tile_size,
        total_tiles: layout.tiles.len() as u32,
        total_edges: layout.edges.len() as u32,
        max_depth: layout.max_depth,
        agg_edges: layout.agg_edges.iter().map(|a| AggEdgeSer {
            src: a.src_region, dst: a.dst_region, count: a.count, type_idx: a.dominant_type_idx,
        }).collect(),
        hierarchy: layout.hierarchy.clone(),
        component_count,
    };
    batches.push(StreamBatch {
        batch_type: 0,
        payload: serde_json::to_vec(&meta).unwrap_or_default(),
    });

    // Batch 2: Hierarchy metadata (binary)
    {
        let mut payload = Vec::new();
        payload.extend_from_slice(&(layout.hierarchy.len() as u32).to_le_bytes());

        for h in &layout.hierarchy {
            let id_bytes = h.id.as_bytes();
            payload.extend_from_slice(&(id_bytes.len() as u16).to_le_bytes());
            payload.extend_from_slice(id_bytes);
            payload.push(h.level);
            payload.push(match h.kind {
                RegionKind::Root => 0,
                RegionKind::Package => 1,
                RegionKind::Directory => 2,
                RegionKind::File => 3,
                RegionKind::Function => 4,
                RegionKind::Block => 5,
            });
            payload.extend_from_slice(&h.parent_idx.unwrap_or(0xFFFFFFFF).to_le_bytes());
            payload.extend_from_slice(&h.all_tile_count.to_le_bytes());
            payload.extend_from_slice(&(h.border.len() as u16).to_le_bytes());
            for pt in &h.border {
                payload.extend_from_slice(&pt[0].to_le_bytes());
                payload.extend_from_slice(&pt[1].to_le_bytes());
            }
            payload.extend_from_slice(&h.center[0].to_le_bytes());
            payload.extend_from_slice(&h.center[1].to_le_bytes());
            payload.extend_from_slice(&h.hue.to_le_bytes());
            payload.extend_from_slice(&h.saturation.to_le_bytes());
            payload.extend_from_slice(&h.lightness.to_le_bytes());
        }

        batches.push(StreamBatch { batch_type: 2, payload });
    }

    // Sort regions by distance from center
    let mut region_order: Vec<(u16, f32)> = layout.regions.iter().enumerate()
        .map(|(i, r)| (i as u16, (r.center[0].powi(2) + r.center[1].powi(2)).sqrt()))
        .collect();
    region_order.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut tiles_by_region: HashMap<u16, Vec<u32>> = HashMap::new();
    for (idx, tile) in layout.tiles.iter().enumerate() {
        tiles_by_region.entry(tile.region_idx).or_default().push(idx as u32);
    }

    // Precompute degree per tile (O(edges) instead of O(tiles × edges))
    let mut degree_map: HashMap<u32, u16> = HashMap::new();
    for edge in &layout.edges {
        *degree_map.entry(edge.src_idx).or_default() += 1;
        *degree_map.entry(edge.dst_idx).or_default() += 1;
    }

    // Precompute type_idx lookup
    let type_to_idx: HashMap<&str, u8> = layout.type_table.iter().enumerate()
        .map(|(i, t)| (t.as_str(), i as u8)).collect();

    let mut sent_tiles: HashSet<u32> = HashSet::new();

    for (region_idx, _) in &region_order {
        let tile_indices = match tiles_by_region.get(region_idx) {
            Some(v) if !v.is_empty() => v,
            _ => continue,
        };

        let tile_set: HashSet<u32> = tile_indices.iter().copied().collect();

        let batch_edges: Vec<&LayoutEdge> = layout.edges.iter().filter(|e| {
            let si = tile_set.contains(&e.src_idx);
            let di = tile_set.contains(&e.dst_idx);
            (si && di) || (si && sent_tiles.contains(&e.dst_idx)) || (di && sent_tiles.contains(&e.src_idx))
        }).collect();

        let mut payload = Vec::new();
        payload.extend_from_slice(&region_idx.to_le_bytes());
        payload.extend_from_slice(&(tile_indices.len() as u32).to_le_bytes());

        // Tile: [globalIdx:u32LE][typeIdx:u8][q:i16LE][r:i16LE][degree:u16LE][flags:u8][lodLevel:u8]
        //        [pkg_idx:u8][dir_idx:u8][file_hier_idx:u16LE][fn_idx:u16LE][is_filler:u8] = 20 bytes
        for &ti in tile_indices {
            let tile = &layout.tiles[ti as usize];
            let type_idx = type_to_idx.get(tile.node_type.as_str()).copied().unwrap_or(0);
            let degree = degree_map.get(&ti).copied().unwrap_or(0);
            let flags: u8 = if CONTAINER_TYPES.contains(&tile.node_type.as_str()) { 0x02 } else { 0x00 };

            payload.extend_from_slice(&ti.to_le_bytes());
            payload.push(type_idx);
            payload.extend_from_slice(&(tile.coord.q as i16).to_le_bytes());
            payload.extend_from_slice(&(tile.coord.r as i16).to_le_bytes());
            payload.extend_from_slice(&degree.to_le_bytes());
            payload.push(flags);
            payload.push(tile.lod_level);
            payload.push(tile.pkg_idx);
            payload.push(tile.dir_idx);
            payload.extend_from_slice(&tile.file_hier_idx.to_le_bytes());
            payload.extend_from_slice(&tile.fn_idx.to_le_bytes());
            payload.push(if tile.is_filler { 1 } else { 0 });
        }

        payload.extend_from_slice(&(batch_edges.len() as u32).to_le_bytes());
        for edge in &batch_edges {
            payload.extend_from_slice(&edge.src_idx.to_le_bytes());
            payload.extend_from_slice(&edge.dst_idx.to_le_bytes());
            payload.push(edge.edge_type_idx);
        }

        batches.push(StreamBatch { batch_type: 1, payload });
        sent_tiles.extend(tile_indices);
    }

    batches
}

fn directory_from_file(file: &str) -> String {
    if file.is_empty() { return "/".to_string(); }
    match file.rfind('/') { Some(pos) => file[..pos].to_string(), None => "/".to_string() }
}

fn pkg_from_file(file: &str) -> String {
    let parts: Vec<&str> = file.split('/').collect();
    if parts.len() >= 2 { format!("{}/{}", parts[0], parts[1]) } else { file.to_string() }
}

// ── Adjacency-driven hierarchical ordering ───────────────────────

/// Adjacency-driven hierarchical file ordering.
///
/// Groups files by package→directory hierarchy and orders them by
/// inter-file/inter-dir/inter-pkg connectivity.  Guarantees:
///   - All files of the same directory are consecutive
///   - All directories of the same package are consecutive
///   - First file of each group seeds near the most-connected placed territory
///   - Cross-package high-connectivity files placed first in their dir
///     (so they dock at the package boundary facing the connected package)
fn hierarchical_file_order(
    file_names: &[String],
    by_file: &HashMap<&str, Vec<&str>>,
    inter_file_counts: &HashMap<(String, String), u32>,
) -> Vec<String> {
    if file_names.is_empty() { return Vec::new(); }

    // ── Build hierarchy groups ──
    let mut pkg_dirs: HashMap<String, Vec<String>> = HashMap::new();
    let mut dir_files_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut file_to_pkg: HashMap<String, String> = HashMap::new();

    for f in file_names {
        let pkg = pkg_from_file(f);
        let dir = directory_from_file(f);
        file_to_pkg.insert(f.clone(), pkg.clone());
        dir_files_map.entry(dir.clone()).or_default().push(f.clone());
        let dirs = pkg_dirs.entry(pkg).or_default();
        if !dirs.contains(&dir) { dirs.push(dir); }
    }

    // ── Pre-build file adjacency for fast connectivity lookups ──
    let mut file_adj: HashMap<String, Vec<(String, u32)>> = HashMap::new();
    for ((f1, f2), &count) in inter_file_counts {
        file_adj.entry(f1.clone()).or_default().push((f2.clone(), count));
        file_adj.entry(f2.clone()).or_default().push((f1.clone(), count));
    }

    // ── Inter-package connectivity ──
    let mut inter_pkg: HashMap<(String, String), u32> = HashMap::new();
    for ((f1, f2), &count) in inter_file_counts {
        let p1 = file_to_pkg.get(f1).cloned().unwrap_or_default();
        let p2 = file_to_pkg.get(f2).cloned().unwrap_or_default();
        if !p1.is_empty() && !p2.is_empty() && p1 != p2 {
            let key = if p1 < p2 { (p1, p2) } else { (p2, p1) };
            *inter_pkg.entry(key).or_default() += count;
        }
    }

    // ── Inter-directory connectivity ──
    let mut inter_dir: HashMap<(String, String), u32> = HashMap::new();
    for ((f1, f2), &count) in inter_file_counts {
        let d1 = directory_from_file(f1);
        let d2 = directory_from_file(f2);
        if d1 != d2 {
            let key = if d1 < d2 { (d1, d2) } else { (d2, d1) };
            *inter_dir.entry(key).or_default() += count;
        }
    }

    // Tile count for a package
    let pkg_tile_count = |pkg: &str| -> usize {
        pkg_dirs.get(pkg).map(|dirs| {
            dirs.iter().flat_map(|d| dir_files_map.get(d).into_iter().flatten())
                .map(|f| by_file.get(f.as_str()).map(|v| v.len()).unwrap_or(1))
                .sum()
        }).unwrap_or(0)
    };

    // ── Order packages: BFS from largest, most-connected next ──
    let mut pkg_order: Vec<String> = Vec::new();
    let mut remaining_pkgs: HashSet<String> = pkg_dirs.keys().cloned().collect();

    if let Some(first) = remaining_pkgs.iter()
        .max_by_key(|p| pkg_tile_count(p))
        .cloned()
    {
        pkg_order.push(first.clone());
        remaining_pkgs.remove(&first);
    }

    while !remaining_pkgs.is_empty() {
        let next = remaining_pkgs.iter()
            .max_by_key(|p| {
                let conn: u32 = pkg_order.iter().map(|placed| {
                    let key = if p.as_str() < placed.as_str() {
                        (p.to_string(), placed.clone())
                    } else {
                        (placed.clone(), p.to_string())
                    };
                    inter_pkg.get(&key).copied().unwrap_or(0)
                }).sum();
                (conn, pkg_tile_count(p))
            })
            .cloned()
            .unwrap();
        pkg_order.push(next.clone());
        remaining_pkgs.remove(&next);
    }

    // ── Build result: pkgs → dirs → files ──
    let mut result: Vec<String> = Vec::with_capacity(file_names.len());
    let mut placed: HashSet<String> = HashSet::new();

    for pkg in &pkg_order {
        let dirs = match pkg_dirs.get(pkg) {
            Some(d) => d.clone(),
            None => continue,
        };

        // Order dirs within package: largest first, then most-connected-to-placed
        let mut dir_order: Vec<String> = Vec::new();
        let mut remaining_dirs: HashSet<String> = dirs.into_iter().collect();

        if let Some(seed) = remaining_dirs.iter()
            .max_by_key(|d| {
                dir_files_map.get(d.as_str()).map(|files| {
                    files.iter().map(|f| by_file.get(f.as_str()).map(|v| v.len()).unwrap_or(1)).sum::<usize>()
                }).unwrap_or(0)
            })
            .cloned()
        {
            dir_order.push(seed.clone());
            remaining_dirs.remove(&seed);
        }

        while !remaining_dirs.is_empty() {
            let next = remaining_dirs.iter()
                .max_by_key(|d| {
                    let conn: u32 = dir_order.iter().map(|pd| {
                        let key = if d.as_str() < pd.as_str() {
                            (d.to_string(), pd.clone())
                        } else {
                            (pd.clone(), d.to_string())
                        };
                        inter_dir.get(&key).copied().unwrap_or(0)
                    }).sum();
                    let size = dir_files_map.get(d.as_str()).map(|v| v.len()).unwrap_or(0);
                    (conn, size)
                })
                .cloned()
                .unwrap();
            dir_order.push(next.clone());
            remaining_dirs.remove(&next);
        }

        // Order files within each dir by connectivity to already-placed files
        for dir in &dir_order {
            let files = match dir_files_map.get(dir) {
                Some(f) => f.clone(),
                None => continue,
            };

            let mut remaining_files: HashSet<String> = files.into_iter().collect();

            // Seed: file most connected to already-placed files (docks at boundary)
            if let Some(seed) = remaining_files.iter()
                .max_by_key(|f| {
                    let conn: u32 = file_adj.get(f.as_str()).map(|adj| {
                        adj.iter().filter(|(nf, _)| placed.contains(nf)).map(|(_, c)| *c).sum()
                    }).unwrap_or(0);
                    let size = by_file.get(f.as_str()).map(|v| v.len()).unwrap_or(1) as u32;
                    conn * 1000 + size
                })
                .cloned()
            {
                result.push(seed.clone());
                remaining_files.remove(&seed);
                placed.insert(seed);
            }

            while !remaining_files.is_empty() {
                let next = remaining_files.iter()
                    .max_by_key(|f| {
                        let conn: u32 = file_adj.get(f.as_str()).map(|adj| {
                            adj.iter().filter(|(nf, _)| placed.contains(nf)).map(|(_, c)| *c).sum()
                        }).unwrap_or(0);
                        let size = by_file.get(f.as_str()).map(|v| v.len()).unwrap_or(1) as u32;
                        conn * 1000 + size
                    })
                    .cloned()
                    .unwrap();
                result.push(next.clone());
                remaining_files.remove(&next);
                placed.insert(next);
            }
        }
    }

    // Any remaining files not in hierarchy groups
    for f in file_names {
        if !placed.contains(f) {
            result.push(f.clone());
        }
    }

    result
}

/// Convert world (x, z) to nearest hex coordinate (axial flat-top)
fn world_to_hex(wx: f64, wz: f64, tile_size: f64) -> HexCoord {
    let q_frac = wx / (1.5 * tile_size);
    let r_frac = (wz / (3.0_f64.sqrt() * tile_size)) - q_frac / 2.0;
    // Cube round
    let s_frac = -q_frac - r_frac;
    let mut qi = q_frac.round();
    let mut ri = r_frac.round();
    let si = s_frac.round();
    let dq = (qi - q_frac).abs();
    let dr = (ri - r_frac).abs();
    let ds = (si - s_frac).abs();
    if dq > dr && dq > ds {
        qi = -ri - si;
    } else if dr > ds {
        ri = -qi - si;
    }
    HexCoord::new(qi as i32, ri as i32)
}

/// Compute edge cost for a node at a given position (sum of weighted hex distances)
fn swap_edge_cost(
    node_id: &str,
    at_coord: HexCoord,
    placement: &HashMap<String, HexCoord>,
    adj: &Adjacency,
) -> f64 {
    neighbors_of(adj, node_id).iter()
        .filter_map(|(nid, w)| placement.get(nid.as_str()).map(|&c| (c, *w)))
        .map(|(c, w)| at_coord.distance(c) as f64 * w as f64)
        .sum()
}
