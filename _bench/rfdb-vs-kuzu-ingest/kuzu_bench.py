#!/usr/bin/env python3
"""Kuzu ingest-throughput benchmark.

For each scale point N: fresh DB, NODE table (id INT64 PK, name STRING, file STRING)
+ REL table CALLS, ingest N nodes + ~2N edges.

Two ingest paths measured separately:
  1. COPY FROM CSV   -- Kuzu's recommended bulk fast path (whole-file, one shot)
  2. batched CREATE  -- prepared CREATE in chunks inside ONE transaction
                        (NOT the fast path; used to get a per-bucket curve so we
                        can see whether cost/node rises as the graph grows, the
                        "slows at 50k" signature)

All timings use time.monotonic(). CSV generation time is EXCLUDED from ingest
timing (we time only the COPY / CREATE calls).
"""
import csv
import os
import shutil
import sys
import tempfile
import time

import kuzu

SCALE_POINTS = [10_000, 50_000, 100_000, 500_000]
EDGES_PER_NODE = 2
BUCKET = 10_000  # per-bucket size for the degradation curve


def gen_csv(n, edges_per_node, ndir):
    """Write nodes.csv and edges.csv for N nodes. Returns (node_csv, edge_csv)."""
    node_csv = os.path.join(ndir, "nodes.csv")
    edge_csv = os.path.join(ndir, "edges.csv")
    with open(node_csv, "w", newline="") as f:
        w = csv.writer(f)
        for i in range(n):
            w.writerow([i, f"fn_{i}", f"src/pkg{i % 53}/file_{i % 211}.ts"])
    with open(edge_csv, "w", newline="") as f:
        w = csv.writer(f)
        for i in range(n):
            for k in range(edges_per_node):
                dst = (i * 7 + k * 13 + 1) % n
                w.writerow([i, dst])
    return node_csv, edge_csv


def fresh_db():
    d = tempfile.mkdtemp(prefix="kuzu-bench-")
    dbfile = os.path.join(d, "db")
    db = kuzu.Database(dbfile)
    conn = kuzu.Connection(db)
    conn.execute(
        "CREATE NODE TABLE N(id INT64, name STRING, file STRING, PRIMARY KEY(id))"
    )
    conn.execute("CREATE REL TABLE CALLS(FROM N TO N)")
    return d, db, conn


def run_copy(n):
    """COPY FROM CSV fast path. Returns dict of timings."""
    gendir = tempfile.mkdtemp(prefix="kuzu-csv-")
    node_csv, edge_csv = gen_csv(n, EDGES_PER_NODE, gendir)
    d, db, conn = fresh_db()
    try:
        t0 = time.monotonic()
        conn.execute(f'COPY N FROM "{node_csv}"')
        t1 = time.monotonic()
        conn.execute(f'COPY CALLS FROM "{edge_csv}"')
        t2 = time.monotonic()
        node_s = t1 - t0
        edge_s = t2 - t1
        total = t2 - t0
        return {
            "n": n,
            "edges": n * EDGES_PER_NODE,
            "node_copy_s": node_s,
            "edge_copy_s": edge_s,
            "total_s": total,
            "nodes_per_s": n / node_s if node_s > 0 else float("inf"),
            "elems_per_s": (n + n * EDGES_PER_NODE) / total if total > 0 else float("inf"),
        }
    finally:
        conn.close()
        db.close()
        shutil.rmtree(d, ignore_errors=True)
        shutil.rmtree(gendir, ignore_errors=True)


def run_batched_buckets(n, bucket=BUCKET):
    """Batched CREATE in one transaction; time each bucket of `bucket` nodes.
    NOT the COPY fast path. Returns list of per-bucket dicts + summary.
    """
    d, db, conn = fresh_db()
    buckets = []
    try:
        conn.execute("BEGIN TRANSACTION")
        node_total = 0
        for start in range(0, n, bucket):
            end = min(start + bucket, n)
            tb = time.monotonic()
            for i in range(start, end):
                conn.execute(
                    "CREATE (:N {id: $id, name: $nm, file: $fl})",
                    {"id": i, "nm": f"fn_{i}", "fl": f"src/file_{i % 211}.ts"},
                )
            te = time.monotonic()
            cnt = end - start
            node_total += cnt
            buckets.append(
                {
                    "graph_size_after": node_total,
                    "bucket_nodes": cnt,
                    "bucket_s": te - tb,
                    "nodes_per_s": cnt / (te - tb) if te > tb else float("inf"),
                }
            )
        conn.execute("COMMIT")
        return buckets
    finally:
        conn.close()
        db.close()
        shutil.rmtree(d, ignore_errors=True)


def main():
    print("# Kuzu", kuzu.__version__, "ingest benchmark")
    print("python", sys.version.split()[0])
    print()

    # 1) COPY fast-path throughput across all scale points
    print("## COPY FROM CSV (fast path)")
    print("| N nodes | edges | node COPY s | edge COPY s | total s | nodes/s (COPY) | elems/s |")
    print("|--------:|------:|------------:|------------:|--------:|---------------:|--------:|")
    copy_rows = []
    for n in SCALE_POINTS:
        r = run_copy(n)
        copy_rows.append(r)
        print(
            f"| {r['n']:>7} | {r['edges']:>5} | {r['node_copy_s']:>11.4f} | "
            f"{r['edge_copy_s']:>11.4f} | {r['total_s']:>7.4f} | "
            f"{r['nodes_per_s']:>14,.0f} | {r['elems_per_s']:>7,.0f} |"
        )
        sys.stdout.flush()

    print()
    # 2) Per-bucket degradation curve via batched CREATE.
    # Use a moderate N so the O(N) loop in python doesn't run forever, but big
    # enough to cross 50k (the claimed degradation point).
    curve_n = 60_000
    print(f"## Per-bucket batched CREATE curve (single txn), N={curve_n}, bucket={BUCKET}")
    print("(NOTE: batched CREATE is NOT Kuzu's COPY fast path; used only to test")
    print(" whether per-node cost rises as the graph grows.)")
    print()
    print("| graph size after | bucket nodes | bucket s | nodes/s |")
    print("|-----------------:|-------------:|---------:|--------:|")
    buckets = run_batched_buckets(curve_n, BUCKET)
    for b in buckets:
        print(
            f"| {b['graph_size_after']:>16} | {b['bucket_nodes']:>12} | "
            f"{b['bucket_s']:>8.4f} | {b['nodes_per_s']:>7,.0f} |"
        )
        sys.stdout.flush()


if __name__ == "__main__":
    main()
