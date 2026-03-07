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

    // CONTAINS and DECLARES both establish containment hierarchy
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

    // 5. Identify renderable nodes — container types are never rendered.
    //    They exist only as grouping abstractions (regions, borders).
    let leaf_ids: HashSet<String> = nodes_by_id.iter()
        .filter(|(_, n)| !CONTAINER_TYPES.contains(&n.node_type.as_str()))
        .map(|(id, _)| id.clone())
        .collect();
    tracing::info!("{} renderable (non-container) nodes out of {} total", leaf_ids.len(), nodes_by_id.len());

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

    let file_target_hex: HashMap<String, HexCoord> = if n_files > 1 {
        force_sim_files(&file_names, &by_file, &inter_file_counts, tile_size)
    } else {
        file_names.iter().map(|f| (f.clone(), HexCoord::new(0, 0))).collect()
    };

    // File order: center-most first (by distance from origin in force sim)
    let mut file_order: Vec<String> = file_names.clone();
    file_order.sort_by_key(|f| {
        let c = file_target_hex.get(f).copied().unwrap_or(HexCoord::new(0, 0));
        c.distance(HexCoord::new(0, 0))
    });
    tracing::info!("Force sim complete for {} files", n_files);

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
            let my_target = file_target_hex.get(file_key).copied().unwrap_or(HexCoord::new(0, 0));

            // Find anchor: placed file whose force-sim target is nearest to mine
            let anchor = file_order[..fi].iter()
                .filter(|f| file_coords.contains_key(f.as_str()))
                .min_by_key(|f| {
                    file_target_hex.get(f.as_str()).copied()
                        .unwrap_or(HexCoord::new(0, 0))
                        .distance(my_target)
                })
                .cloned();

            if let Some(ref anchor_file) = anchor {
                // Find free hex on anchor's boundary, closest to our force-sim target
                let best = file_coords[anchor_file].iter().rev()
                    .flat_map(|c| c.neighbors())
                    .filter(|n| !grid.contains(n))
                    .min_by_key(|n| n.distance(my_target));
                best.unwrap_or_else(|| find_free_adjacent_to(&file_coords[anchor_file], &grid))
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

    // 10b. Graph coloring — assign hues so adjacent regions have distinct colors
    {
        // Build coord → region map
        let mut coord_to_region: HashMap<HexCoord, u16> = HashMap::new();
        for tile in &tiles {
            coord_to_region.insert(tile.coord, tile.region_idx);
        }

        // Build region adjacency
        let mut region_adj: Vec<HashSet<u16>> = vec![HashSet::new(); regions.len()];
        for tile in &tiles {
            for neighbor in tile.coord.neighbors() {
                if let Some(&nr) = coord_to_region.get(&neighbor) {
                    if nr != tile.region_idx {
                        region_adj[tile.region_idx as usize].insert(nr);
                    }
                }
            }
        }

        // Greedy coloring with 12 color slots
        let n_slots: u8 = 12;
        // Golden-angle hues for max perceptual distance between slots
        let slot_hues: Vec<f32> = (0..n_slots).map(|i| (i as f32 * 137.508) % 360.0).collect();

        // Order regions by degree (most-constrained first) for better coloring
        let mut order: Vec<usize> = (0..regions.len()).collect();
        order.sort_by(|a, b| region_adj[*b].len().cmp(&region_adj[*a].len()));

        let mut region_slot: Vec<u8> = vec![255; regions.len()];
        for ri in order {
            let used: HashSet<u8> = region_adj[ri].iter()
                .filter_map(|&ni| {
                    let s = region_slot[ni as usize];
                    if s < 255 { Some(s) } else { None }
                })
                .collect();
            for c in 0..n_slots {
                if !used.contains(&c) {
                    region_slot[ri] = c;
                    break;
                }
            }
            if region_slot[ri] == 255 { region_slot[ri] = 0; }
            regions[ri].hue = slot_hues[region_slot[ri] as usize];
        }
    }

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

        // Use file's region hue so container fill color matches tile color
        let hue = file_to_region.get(&cnode.file)
            .map(|&ri| regions[ri as usize].hue)
            .unwrap_or((containers.len() as f32 * 137.508) % 360.0);

        containers.push(ContainerInfo {
            name: cnode.name.clone(),
            container_type: cnode.node_type.clone(),
            depth,
            border,
            center: [cx / n, cz / n],
            tile_count: descendant_coords.len() as u32,
            hue,
        });
    }
    // Sort by depth (shallowest first) for layered rendering
    containers.sort_by_key(|c| c.depth);

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

    tracing::info!(
        "Layout complete: {} tiles, {} edges, {} regions (files), {} containers, {} agg_edges, max_depth={} in {:?}",
        tiles.len(), layout_edges.len(), regions.len(), containers.len(), agg_edges.len(), max_depth, t0.elapsed()
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

// ── Spiral generator ──────────────────────────────────────────────

/// Generate hex positions in spiral order from center (compact, gap-free).
fn generate_hex_spiral(center: HexCoord, count: usize) -> Vec<HexCoord> {
    let dirs: [(i32, i32); 6] = [(1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)];
    let mut result = Vec::with_capacity(count);
    result.push(center);
    let mut ring: i32 = 1;
    while result.len() < count {
        let mut q = center.q + ring;
        let mut r = center.r;
        for (dir_idx, &(dq, dr)) in dirs.iter().enumerate() {
            let side_len = if dir_idx == 0 { ring - 1 } else { ring };
            for _ in 0..side_len {
                if result.len() >= count { return result; }
                result.push(HexCoord::new(q, r));
                q += dq;
                r += dr;
            }
        }
        if result.len() >= count { return result; }
        result.push(HexCoord::new(q, r));
        ring += 1;
    }
    result
}

// ── Placement helpers ─────────────────────────────────────────────

/// Sum of weights to already-placed neighbors
fn connectivity_to_placed(
    node_id: &str,
    adj: &Adjacency,
    placement: &HashMap<String, HexCoord>,
) -> u32 {
    neighbors_of(adj, node_id).iter()
        .filter(|(nid, _)| placement.contains_key(nid.as_str()))
        .map(|(_, w)| w)
        .sum()
}

/// Find best free hex position near placed neighbors (weighted centroid + local search)
fn find_best_position(
    node_id: &str,
    adj: &Adjacency,
    grid: &HashSet<HexCoord>,
    placement: &HashMap<String, HexCoord>,
    fallback: HexCoord,
) -> HexCoord {
    let placed: Vec<(HexCoord, u32)> = neighbors_of(adj, node_id).iter()
        .filter_map(|(nid, w)| placement.get(nid.as_str()).map(|&c| (c, *w)))
        .collect();

    if placed.is_empty() {
        return find_nearest_free(grid, fallback);
    }

    let total_w: f64 = placed.iter().map(|(_, w)| *w as f64).sum();
    let avg_q = placed.iter().map(|(c, w)| c.q as f64 * *w as f64).sum::<f64>() / total_w;
    let avg_r = placed.iter().map(|(c, w)| c.r as f64 * *w as f64).sum::<f64>() / total_w;
    let target = HexCoord::new(avg_q.round() as i32, avg_r.round() as i32);

    let mut best = find_nearest_free(grid, target);
    let mut best_cost = placement_cost(&best, &placed);

    // Check neighbors of target and placed nodes for better spots
    let mut candidates: Vec<HexCoord> = target.neighbors().to_vec();
    for &(pc, _) in &placed {
        candidates.extend_from_slice(&pc.neighbors());
    }

    for nc in candidates {
        if !grid.contains(&nc) {
            let cost = placement_cost(&nc, &placed);
            if cost < best_cost { best_cost = cost; best = nc; }
        }
    }

    best
}

fn placement_cost(candidate: &HexCoord, placed: &[(HexCoord, u32)]) -> f64 {
    placed.iter().map(|(c, w)| candidate.distance(*c) as f64 * *w as f64).sum()
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

/// Place nodes in a hex spiral pattern (O(n) total, no BFS search)
fn place_in_spiral(
    ids: &[String],
    grid: &mut HashSet<HexCoord>,
    placement: &mut HashMap<String, HexCoord>,
    center: HexCoord,
) {
    if ids.is_empty() { return; }
    let dirs: [(i32, i32); 6] = [(1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)];
    let mut idx = 0;

    // Place center
    let mut coord = center;
    if !grid.contains(&coord) {
        grid.insert(coord);
        placement.insert(ids[idx].clone(), coord);
        idx += 1;
    }

    let mut ring = 1;
    while idx < ids.len() {
        // Move to start of ring
        coord = HexCoord::new(center.q + ring, center.r);
        for (dir_idx, &(dq, dr)) in dirs.iter().enumerate() {
            let side_len = if dir_idx == 0 { ring - 1 } else { ring };
            for _ in 0..side_len {
                if idx >= ids.len() { return; }
                if !grid.contains(&coord) {
                    grid.insert(coord);
                    placement.insert(ids[idx].clone(), coord);
                    idx += 1;
                }
                coord = HexCoord::new(coord.q + dq, coord.r + dr);
            }
        }
        // Last step of first direction
        if idx >= ids.len() { return; }
        if !grid.contains(&coord) {
            grid.insert(coord);
            placement.insert(ids[idx].clone(), coord);
            idx += 1;
        }
        ring += 1;
    }
}

// ── Border computation ────────────────────────────────────────────

fn compute_border(tiles: &[HexCoord], tile_size: f32) -> Vec<[f32; 2]> {
    if tiles.is_empty() { return Vec::new(); }
    let tile_set: HashSet<HexCoord> = tiles.iter().copied().collect();
    let mut segments: Vec<(f32, f32, f32, f32)> = Vec::new();

    for &tile in tiles {
        let (cx, cz) = tile.to_world(tile_size);
        let neighbors = tile.neighbors();
        for (i, &neighbor) in neighbors.iter().enumerate() {
            if !tile_set.contains(&neighbor) {
                let a1 = std::f32::consts::PI / 3.0 * i as f32;
                let a2 = std::f32::consts::PI / 3.0 * (i as f32 + 1.0);
                segments.push((
                    cx + tile_size * a1.cos(), cz + tile_size * a1.sin(),
                    cx + tile_size * a2.cos(), cz + tile_size * a2.sin(),
                ));
            }
        }
    }

    chain_segments(&segments, tile_size * 0.01)
}

fn chain_segments(segments: &[(f32, f32, f32, f32)], epsilon: f32) -> Vec<[f32; 2]> {
    if segments.is_empty() { return Vec::new(); }
    let mut remaining = segments.to_vec();
    let mut polygon: Vec<[f32; 2]> = Vec::new();
    let first = remaining.remove(0);
    polygon.push([first.0, first.1]);
    polygon.push([first.2, first.3]);
    let eps2 = epsilon * epsilon;

    while !remaining.is_empty() {
        let [lx, lz] = *polygon.last().unwrap();
        let mut found = false;
        for i in 0..remaining.len() {
            let s = remaining[i];
            if (s.0 - lx).powi(2) + (s.1 - lz).powi(2) < eps2 {
                polygon.push([s.2, s.3]);
                remaining.remove(i);
                found = true;
                break;
            } else if (s.2 - lx).powi(2) + (s.3 - lz).powi(2) < eps2 {
                polygon.push([s.0, s.1]);
                remaining.remove(i);
                found = true;
                break;
            }
        }
        if !found { break; }
    }

    polygon
}

// ── Batch computation ─────────────────────────────────────────────

pub fn compute_batches(layout: &HexLayout) -> Vec<StreamBatch> {
    let mut batches = Vec::new();

    // Batch 0: Region metadata
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
    };
    batches.push(StreamBatch {
        batch_type: 0,
        payload: serde_json::to_vec(&meta).unwrap_or_default(),
    });

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

        // Tile: [globalIdx:u32LE][typeIdx:u8][q:i16LE][r:i16LE][degree:u16LE][flags:u8][lodLevel:u8] = 13 bytes
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

// ── Force simulation ──────────────────────────────────────────────

/// Level 1: Force-directed file positioning.
/// Returns ideal hex coordinates for each file based on inter-file connectivity.
fn force_sim_files(
    file_names: &[String],
    by_file: &HashMap<&str, Vec<&str>>,
    inter_file_counts: &HashMap<(String, String), u32>,
    tile_size: f32,
) -> HashMap<String, HexCoord> {
    let n = file_names.len();
    if n == 0 { return HashMap::new(); }

    let file_idx: HashMap<&str, usize> = file_names.iter().enumerate()
        .map(|(i, f)| (f.as_str(), i)).collect();

    let sizes: Vec<f64> = file_names.iter().map(|f| {
        by_file.get(f.as_str()).map(|v| v.len() as f64).unwrap_or(1.0)
    }).collect();

    let total_nodes: f64 = sizes.iter().sum();
    // Compact initial spread: files start close, sim pushes apart as needed
    let spread = (total_nodes / std::f64::consts::PI).sqrt() * tile_size as f64 * 0.5;

    // Initial positions: circular layout
    let mut pos: Vec<[f64; 2]> = (0..n).map(|i| {
        let angle = 2.0 * std::f64::consts::PI * i as f64 / n as f64;
        [spread * angle.cos(), spread * angle.sin()]
    }).collect();

    let mut vel: Vec<[f64; 2]> = vec![[0.0, 0.0]; n];

    // Weak repulsion, strong attraction → compact clusters
    let k_repel = spread * spread * 0.1;
    let k_attract = 0.01;
    let k_gravity = 0.03;
    let dt = 1.0;
    let damping = 0.85;
    let max_disp = spread * 0.05;

    for _iter in 0..300 {
        let mut forces: Vec<[f64; 2]> = vec![[0.0, 0.0]; n];

        // Repulsion: all pairs (Coulomb-like)
        for i in 0..n {
            for j in (i + 1)..n {
                let dx = pos[i][0] - pos[j][0];
                let dy = pos[i][1] - pos[j][1];
                let dist2 = (dx * dx + dy * dy).max(1.0);
                let dist = dist2.sqrt();
                let f = k_repel * sizes[i].sqrt() * sizes[j].sqrt() / dist2;
                let fx = f * dx / dist;
                let fy = f * dy / dist;
                forces[i][0] += fx; forces[i][1] += fy;
                forces[j][0] -= fx; forces[j][1] -= fy;
            }
        }

        // Attraction: connected files (spring toward ideal distance)
        for ((f1, f2), count) in inter_file_counts {
            if let (Some(&i), Some(&j)) = (file_idx.get(f1.as_str()), file_idx.get(f2.as_str())) {
                let dx = pos[j][0] - pos[i][0];
                let dy = pos[j][1] - pos[i][1];
                let dist = (dx * dx + dy * dy).sqrt().max(1.0);
                let ideal = (sizes[i].sqrt() + sizes[j].sqrt()) * tile_size as f64 * 0.8;
                let f = k_attract * (*count as f64).sqrt() * (dist - ideal);
                let fx = f * dx / dist;
                let fy = f * dy / dist;
                forces[i][0] += fx; forces[i][1] += fy;
                forces[j][0] -= fx; forces[j][1] -= fy;
            }
        }

        // Center gravity
        for i in 0..n {
            forces[i][0] -= pos[i][0] * k_gravity;
            forces[i][1] -= pos[i][1] * k_gravity;
        }

        // Update
        for i in 0..n {
            vel[i][0] = (vel[i][0] + forces[i][0] * dt) * damping;
            vel[i][1] = (vel[i][1] + forces[i][1] * dt) * damping;
            let v_mag = (vel[i][0] * vel[i][0] + vel[i][1] * vel[i][1]).sqrt();
            if v_mag > max_disp {
                vel[i][0] *= max_disp / v_mag;
                vel[i][1] *= max_disp / v_mag;
            }
            pos[i][0] += vel[i][0] * dt;
            pos[i][1] += vel[i][1] * dt;
        }
    }

    // Convert world coords → hex coords
    file_names.iter().enumerate().map(|(i, f)| {
        let coord = world_to_hex(pos[i][0], pos[i][1], tile_size as f64);
        (f.clone(), coord)
    }).collect()
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
