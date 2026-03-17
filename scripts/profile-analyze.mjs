#!/usr/bin/env node

import { readFileSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Interval Arithmetic
// ---------------------------------------------------------------------------

class Interval {
    constructor(lo, hi) {
        this.lo = lo;
        this.hi = hi;
    }
    add(other) { return new Interval(this.lo + other.lo, this.hi + other.hi); }
    mul(other) {
        const products = [this.lo * other.lo, this.lo * other.hi, this.hi * other.lo, this.hi * other.hi];
        return new Interval(Math.min(...products), Math.max(...products));
    }
    scale(n) { return new Interval(this.lo * n, this.hi * n); }
    width() { return this.hi - this.lo; }
    midpoint() { return (this.lo + this.hi) / 2; }
    contains(x) { return x >= this.lo && x <= this.hi; }
    toString() { return `[${this.lo.toFixed(1)}, ${this.hi.toFixed(1)}]`; }
}

// ---------------------------------------------------------------------------
// Minimal YAML Parser (handles the specific assumptions.yaml format)
// ---------------------------------------------------------------------------

function parseAssumptionsYaml(text) {
    const assumptions = new Map();
    const lines = text.split('\n');
    let current = null;

    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');

        // Skip comments and empty lines
        if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

        // Top-level "assumptions:" key — skip
        if (/^assumptions:\s*$/.test(line)) continue;

        // New list item: "  - id: A1"
        const itemMatch = line.match(/^\s+-\s+id:\s*(\S+)/);
        if (itemMatch) {
            current = { id: itemMatch[1] };
            continue;
        }

        if (!current) continue;

        // Key-value fields inside a list item
        const kvMatch = line.match(/^\s+(\w+):\s*(.*)/);
        if (!kvMatch) continue;

        const [, key, rawVal] = kvMatch;

        if (key === 'interval') {
            // Parse [lo, hi]
            const numMatch = rawVal.match(/\[\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*]/);
            if (numMatch) {
                current.interval = new Interval(parseFloat(numMatch[1]), parseFloat(numMatch[2]));
            }
        } else if (key === 'name') {
            current.name = rawVal.trim();
        } else if (key === 'unit') {
            current.unit = rawVal.trim();
        } else if (key === 'evidence') {
            current.evidence = rawVal.replace(/^"(.*)"$/, '$1').trim();
        }

        // When we have all fields, store it
        if (current.name && current.interval) {
            assumptions.set(current.name, current);
        }
    }

    return assumptions;
}

// ---------------------------------------------------------------------------
// Helper: filter file_analyzed events with real metrics (exclude default zeros)
// ---------------------------------------------------------------------------

function realFileEvents(events) {
    return events.filter(e =>
        e.event === 'file_analyzed' &&
        (e.total_ms > 0 || e.parse_ms > 0 || e.analyze_ms > 0)
    );
}

// ---------------------------------------------------------------------------
// 1. parseJsonl
// ---------------------------------------------------------------------------

function parseJsonl(filePath) {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    const events = [];

    for (let i = 0; i < lines.length; i++) {
        try {
            events.push(JSON.parse(lines[i]));
        } catch {
            // Crash safety: skip malformed lines (typically truncated last line)
            if (i === lines.length - 1) {
                // Expected for crash-truncated profiles
            } else {
                process.stderr.write(`Warning: skipping malformed line ${i + 1}\n`);
            }
        }
    }

    return events;
}

// ---------------------------------------------------------------------------
// 2. phaseBreakdown
// ---------------------------------------------------------------------------

function phaseBreakdown(events) {
    const phasePairs = [
        { name: 'analysis', start: 'analysis_start', end: 'analysis_complete' },
        { name: 'js_resolve', start: 'js_resolve_start', end: 'js_resolve_complete' },
        { name: 'haskell_resolve', start: 'haskell_resolve_start', end: 'haskell_resolve_complete' },
        { name: 'compact', start: 'compact_start', end: 'compact_complete' },
        { name: 'depends_on', start: 'depends_on_start', end: 'depends_on_complete' },
    ];

    const phases = [];
    const totalMs = events.length >= 2
        ? events[events.length - 1].elapsed_ms - events[0].elapsed_ms
        : 0;

    // Match start/complete pairs
    for (const { name, start, end } of phasePairs) {
        const startEvt = events.find(e => e.event === start);
        const endEvt = events.find(e => e.event === end);
        if (startEvt && endEvt) {
            const duration = endEvt.elapsed_ms - startEvt.elapsed_ms;
            phases.push({
                phase: name,
                duration_ms: duration,
                pct: totalMs > 0 ? (duration / totalMs) * 100 : 0,
            });
        }
    }

    // Individual resolve commands keyed by cmd field
    const cmdStarts = new Map();
    for (const e of events) {
        if (e.event === 'js_resolve_cmd_start' && e.cmd) {
            cmdStarts.set(e.cmd, e);
        } else if (e.event === 'js_resolve_cmd_complete' && e.cmd) {
            const startEvt = cmdStarts.get(e.cmd);
            if (startEvt) {
                const duration = e.elapsed_ms - startEvt.elapsed_ms;
                phases.push({
                    phase: `js_resolve_cmd:${e.cmd}`,
                    duration_ms: duration,
                    pct: totalMs > 0 ? (duration / totalMs) * 100 : 0,
                });
                cmdStarts.delete(e.cmd);
            }
        }
    }

    // Sort by duration descending
    phases.sort((a, b) => b.duration_ms - a.duration_ms);
    return phases;
}

// ---------------------------------------------------------------------------
// 3. fileDistribution
// ---------------------------------------------------------------------------

function fileDistribution(events) {
    const allFileEvents = events.filter(e => e.event === 'file_analyzed');
    const fileEvents = realFileEvents(events);

    if (allFileEvents.length === 0) {
        return { histogram: [], percentiles: null, count: 0, instrumented: 0, total: 0 };
    }

    const buckets = [
        { label: '0-10ms', lo: 0, hi: 10 },
        { label: '10-50ms', lo: 10, hi: 50 },
        { label: '50-100ms', lo: 50, hi: 100 },
        { label: '100-500ms', lo: 100, hi: 500 },
        { label: '500ms-1s', lo: 500, hi: 1000 },
        { label: '1-5s', lo: 1000, hi: 5000 },
        { label: '5-10s', lo: 5000, hi: 10000 },
        { label: '10s+', lo: 10000, hi: Infinity },
    ];

    const totals = fileEvents.map(e => e.total_ms ?? 0).sort((a, b) => a - b);
    const parses = fileEvents.map(e => e.parse_ms ?? 0).sort((a, b) => a - b);
    const analyzes = fileEvents.map(e => e.analyze_ms ?? 0).sort((a, b) => a - b);

    const histogram = buckets.map(b => ({
        label: b.label,
        count: totals.filter(t => t >= b.lo && t < b.hi).length,
    }));

    function percentile(sorted, p) {
        if (sorted.length === 0) return 0;
        const idx = Math.ceil(sorted.length * p / 100) - 1;
        return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
    }

    return {
        histogram,
        count: fileEvents.length,
        total: allFileEvents.length,
        uninstrumented: allFileEvents.length - fileEvents.length,
        percentiles: {
            total: {
                p50: percentile(totals, 50),
                p90: percentile(totals, 90),
                p99: percentile(totals, 99),
                max: totals[totals.length - 1],
            },
            parse: {
                p50: percentile(parses, 50),
                p90: percentile(parses, 90),
                p99: percentile(parses, 99),
                max: parses[parses.length - 1],
            },
            analyze: {
                p50: percentile(analyzes, 50),
                p90: percentile(analyzes, 90),
                p99: percentile(analyzes, 99),
                max: analyzes[analyzes.length - 1],
            },
        },
    };
}

// ---------------------------------------------------------------------------
// 4. outlierDetection
// ---------------------------------------------------------------------------

function outlierDetection(events) {
    const fileEvents = realFileEvents(events);

    if (fileEvents.length < 3) return [];

    const totals = fileEvents.map(e => e.total_ms ?? 0);
    const mean = totals.reduce((s, v) => s + v, 0) / totals.length;
    const variance = totals.reduce((s, v) => s + (v - mean) ** 2, 0) / totals.length;
    const stddev = Math.sqrt(variance);
    const threshold = mean + 3 * stddev;

    const outliers = [];

    for (const e of fileEvents) {
        const totalMs = e.total_ms ?? 0;
        const astExpansion = (e.ast_size_bytes && e.file_size_bytes && e.file_size_bytes > 0)
            ? e.ast_size_bytes / e.file_size_bytes
            : null;

        const reasons = [];
        if (totalMs > threshold) {
            reasons.push(`>3\u03C3 (threshold: ${threshold.toFixed(0)}ms)`);
        }
        if (astExpansion !== null && astExpansion > 30) {
            reasons.push(`high AST expansion: ${astExpansion.toFixed(1)}x`);
        }

        if (reasons.length > 0) {
            outliers.push({
                file: e.file ?? '<unknown>',
                total_ms: totalMs,
                parse_ms: e.parse_ms ?? 0,
                analyze_ms: e.analyze_ms ?? 0,
                ast_expansion: astExpansion,
                reason: reasons.join('; '),
            });
        }
    }

    outliers.sort((a, b) => b.total_ms - a.total_ms);
    return outliers;
}

// ---------------------------------------------------------------------------
// 5. memoryProfile
// ---------------------------------------------------------------------------

function memoryProfile(events) {
    if (events.length === 0) {
        return { peak_rss_mb: 0, max_delta_mb: 0, phase_attribution: null, per_file_estimate_kb: 0 };
    }

    const rssValues = events.filter(e => e.rss_mb != null).map(e => ({
        rss: e.rss_mb,
        event: e.event,
        elapsed: e.elapsed_ms,
    }));

    if (rssValues.length === 0) {
        return { peak_rss_mb: 0, max_delta_mb: 0, phase_attribution: null, per_file_estimate_kb: 0 };
    }

    const peakRss = Math.max(...rssValues.map(r => r.rss));

    let maxDelta = 0;
    let maxDeltaEvent = '';
    for (let i = 1; i < rssValues.length; i++) {
        const delta = rssValues[i].rss - rssValues[i - 1].rss;
        if (delta > maxDelta) {
            maxDelta = delta;
            maxDeltaEvent = rssValues[i].event;
        }
    }

    // Attribute memory to phases
    const phaseStarts = new Map();
    const phaseDeltas = new Map();
    for (const e of events) {
        if (e.event?.endsWith('_start') && e.rss_mb != null) {
            const phase = e.event.replace(/_start$/, '');
            phaseStarts.set(phase, e.rss_mb);
        } else if (e.event?.endsWith('_complete') && e.rss_mb != null) {
            const phase = e.event.replace(/_complete$/, '');
            const startRss = phaseStarts.get(phase);
            if (startRss != null) {
                phaseDeltas.set(phase, e.rss_mb - startRss);
            }
        }
    }

    let phaseAttribution = null;
    if (phaseDeltas.size > 0) {
        const sorted = [...phaseDeltas.entries()].sort((a, b) => b[1] - a[1]);
        phaseAttribution = sorted.map(([phase, delta]) => ({ phase, delta_mb: delta }));
    }

    // Per-file memory estimate from file_analyzed events
    const fileEvents = events.filter(e => e.event === 'file_analyzed' && e.rss_mb != null);
    let perFileEstimateKb = 0;
    if (fileEvents.length >= 2) {
        const rssDeltas = [];
        for (let i = 1; i < fileEvents.length; i++) {
            rssDeltas.push((fileEvents[i].rss_mb - fileEvents[i - 1].rss_mb) * 1024);
        }
        // Use median of positive deltas as estimate (negative deltas are GC)
        const positiveDeltas = rssDeltas.filter(d => d > 0).sort((a, b) => a - b);
        if (positiveDeltas.length > 0) {
            perFileEstimateKb = positiveDeltas[Math.floor(positiveDeltas.length / 2)];
        }
    }

    return {
        peak_rss_mb: peakRss,
        max_delta_mb: maxDelta,
        max_delta_event: maxDeltaEvent,
        phase_attribution: phaseAttribution,
        per_file_estimate_kb: perFileEstimateKb,
    };
}

// ---------------------------------------------------------------------------
// 6. criticalPath
// ---------------------------------------------------------------------------

function criticalPath(events) {
    const phaseDefs = [
        { name: 'discovery', start: 'discovery_start', end: 'discovery_complete', parallel: false },
        { name: 'analysis', start: 'analysis_start', end: 'analysis_complete', parallel: true },
        { name: 'js_resolve', start: 'js_resolve_start', end: 'js_resolve_complete', parallel: false },
        { name: 'haskell_resolve', start: 'haskell_resolve_start', end: 'haskell_resolve_complete', parallel: false },
        { name: 'compact', start: 'compact_start', end: 'compact_complete', parallel: false },
        { name: 'depends_on', start: 'depends_on_start', end: 'depends_on_complete', parallel: false },
    ];

    const phases = [];
    let totalMs = 0;

    for (const def of phaseDefs) {
        const startEvt = events.find(e => e.event === def.start);
        const endEvt = events.find(e => e.event === def.end);
        if (startEvt && endEvt) {
            const duration = endEvt.elapsed_ms - startEvt.elapsed_ms;
            phases.push({
                name: def.name,
                duration_ms: duration,
                parallel: def.parallel,
            });
            totalMs += duration;
        }
    }

    // If no phases found, compute total from first/last event
    if (phases.length === 0 && events.length >= 2) {
        totalMs = events[events.length - 1].elapsed_ms - events[0].elapsed_ms;
    }

    // Bottleneck: longest sequential phase
    const sequential = phases.filter(p => !p.parallel);
    const bottleneck = sequential.length > 0
        ? sequential.reduce((max, p) => p.duration_ms > max.duration_ms ? p : max).name
        : null;

    return { total_ms: totalMs, phases, bottleneck };
}

// ---------------------------------------------------------------------------
// 7. sensitivityAnalysis
// ---------------------------------------------------------------------------

function sensitivityAnalysis(events) {
    const phasePairs = [
        { name: 'analysis', start: 'analysis_start', end: 'analysis_complete' },
        { name: 'js_resolve', start: 'js_resolve_start', end: 'js_resolve_complete' },
        { name: 'haskell_resolve', start: 'haskell_resolve_start', end: 'haskell_resolve_complete' },
        { name: 'compact', start: 'compact_start', end: 'compact_complete' },
        { name: 'depends_on', start: 'depends_on_start', end: 'depends_on_complete' },
    ];

    const totalMs = events.length >= 2
        ? events[events.length - 1].elapsed_ms - events[0].elapsed_ms
        : 0;

    if (totalMs === 0) return [];

    const results = [];

    for (const { name, start, end } of phasePairs) {
        const startEvt = events.find(e => e.event === start);
        const endEvt = events.find(e => e.event === end);
        if (!startEvt || !endEvt) continue;

        const currentMs = endEvt.elapsed_ms - startEvt.elapsed_ms;
        const impact2x = totalMs + currentMs;        // phase doubles = adds currentMs
        const impact10x = totalMs + currentMs * 9;    // phase 10x = adds 9*currentMs

        results.push({
            phase: name,
            current_ms: currentMs,
            impact_2x_ms: impact2x,
            impact_10x_ms: impact10x,
            sensitivity_pct: (currentMs / totalMs) * 100,
        });
    }

    results.sort((a, b) => b.sensitivity_pct - a.sensitivity_pct);
    return results;
}

// ---------------------------------------------------------------------------
// 8. scalingPredictions
// ---------------------------------------------------------------------------

function scalingPredictions(events, targetN, assumptions) {
    const fileEvents = realFileEvents(events);
    const currentN = fileEvents.length;

    if (currentN === 0) {
        return {
            target_files: targetN,
            current_files: 0,
            predicted_time: null,
            predicted_memory: null,
            note: 'No file_analyzed events found, cannot predict',
        };
    }

    const totals = fileEvents.map(e => e.total_ms ?? 0).sort((a, b) => a - b);
    const medianPerFile = totals[Math.floor(totals.length / 2)];

    // Estimate parallelism from analysis phase
    const analysisStart = events.find(e => e.event === 'analysis_start');
    const analysisEnd = events.find(e => e.event === 'analysis_complete');
    let parallelism = 1;
    if (analysisStart && analysisEnd) {
        const analysisDuration = analysisEnd.elapsed_ms - analysisStart.elapsed_ms;
        const totalFileTime = totals.reduce((s, v) => s + v, 0);
        if (analysisDuration > 0) {
            parallelism = Math.max(1, totalFileTime / analysisDuration);
        }
    }

    // Resolve time estimation
    const resolveStart = events.find(e => e.event === 'js_resolve_start');
    const resolveEnd = events.find(e => e.event === 'js_resolve_complete');
    let resolveTimePerFile = 0;
    if (resolveStart && resolveEnd && currentN > 0) {
        resolveTimePerFile = (resolveEnd.elapsed_ms - resolveStart.elapsed_ms) / currentN;
    }

    // Compact time estimation (N log N scaling)
    const compactStart = events.find(e => e.event === 'compact_start');
    const compactEnd = events.find(e => e.event === 'compact_complete');
    let compactBase = 0;
    if (compactStart && compactEnd) {
        compactBase = compactEnd.elapsed_ms - compactStart.elapsed_ms;
    }

    const scaleFactor = targetN / Math.max(1, currentN);
    const compactScale = currentN > 0
        ? (targetN * Math.log2(targetN)) / (currentN * Math.log2(Math.max(2, currentN)))
        : scaleFactor;

    // Point estimates
    const analysisTime = (medianPerFile * targetN) / parallelism;
    const resolveTime = resolveTimePerFile * targetN;
    const compactTime = compactBase * compactScale;
    const pointEstimate = analysisTime + resolveTime + compactTime;

    // Memory estimate
    const memProfile = memoryProfile(events);
    const memoryPoint = (memProfile.per_file_estimate_kb * targetN) / 1024; // MB

    let predictedTime;
    let predictedMemory;

    if (assumptions) {
        // Use interval arithmetic for bounds
        const analyzeInterval = assumptions.get('analyze_time_per_file')?.interval
            ?? new Interval(medianPerFile * 0.5, medianPerFile * 2);
        const resolveInterval = assumptions.get('resolve_time_per_node')?.interval
            ?? new Interval(resolveTimePerFile * 0.5, resolveTimePerFile * 2);
        const memInterval = assumptions.get('memory_per_file')?.interval
            ?? new Interval(memProfile.per_file_estimate_kb * 0.5, memProfile.per_file_estimate_kb * 2);
        const compactInterval = assumptions.get('compact_time_per_1k_nodes')?.interval
            ?? new Interval(compactBase * 0.5, compactBase * 2);

        const analysisInterval = analyzeInterval.scale(targetN / parallelism);
        const resolveScaled = resolveInterval.scale(targetN);
        const compactScaled = compactInterval.scale(compactScale / 1000); // per 1k nodes
        const totalInterval = analysisInterval.add(resolveScaled).add(compactScaled);

        predictedTime = { lo: totalInterval.lo, hi: totalInterval.hi };
        predictedMemory = {
            lo: (memInterval.lo * targetN) / 1024,
            hi: (memInterval.hi * targetN) / 1024,
        };
    } else {
        // Without assumptions, use +/- 30% as naive bounds
        predictedTime = { lo: pointEstimate * 0.7, hi: pointEstimate * 1.3 };
        predictedMemory = { lo: memoryPoint * 0.7, hi: memoryPoint * 1.3 };
    }

    return {
        target_files: targetN,
        current_files: currentN,
        scale_factor: scaleFactor,
        parallelism: Math.round(parallelism * 10) / 10,
        median_per_file_ms: medianPerFile,
        predicted_time: predictedTime,
        predicted_memory: predictedMemory,
    };
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

function calibrate(events, assumptions) {
    const fileEvents = realFileEvents(events);
    const violations = [];
    const confirmations = [];

    if (fileEvents.length === 0) {
        return { violations, confirmations, note: 'No file_analyzed events for calibration' };
    }

    // A1: parse_time_per_kb
    const a1 = assumptions.get('parse_time_per_kb');
    if (a1) {
        const ratios = fileEvents
            .filter(e => e.parse_ms != null && e.file_size_bytes > 0)
            .map(e => e.parse_ms / (e.file_size_bytes / 1024));
        if (ratios.length > 0) {
            ratios.sort((a, b) => a - b);
            const p5 = ratios[Math.floor(ratios.length * 0.05)];
            const p95 = ratios[Math.floor(ratios.length * 0.95)];
            const check = checkInterval(a1, p5, p95, 'parse_time_per_kb');
            (check.violated ? violations : confirmations).push(check);
        }
    }

    // A2: analyze_time_per_file
    const a2 = assumptions.get('analyze_time_per_file');
    if (a2) {
        const times = fileEvents.filter(e => e.analyze_ms != null).map(e => e.analyze_ms);
        if (times.length > 0) {
            times.sort((a, b) => a - b);
            const p5 = times[Math.floor(times.length * 0.05)];
            const p95 = times[Math.floor(times.length * 0.95)];
            const check = checkInterval(a2, p5, p95, 'analyze_time_per_file');
            (check.violated ? violations : confirmations).push(check);
        }
    }

    // A4: memory_per_file
    const a4 = assumptions.get('memory_per_file');
    if (a4 && fileEvents.length >= 2) {
        const deltas = [];
        for (let i = 1; i < fileEvents.length; i++) {
            if (fileEvents[i].rss_mb != null && fileEvents[i - 1].rss_mb != null) {
                deltas.push((fileEvents[i].rss_mb - fileEvents[i - 1].rss_mb) * 1024); // KB
            }
        }
        const positive = deltas.filter(d => d > 0).sort((a, b) => a - b);
        if (positive.length > 0) {
            const p5 = positive[Math.floor(positive.length * 0.05)];
            const p95 = positive[Math.floor(positive.length * 0.95)];
            const check = checkInterval(a4, p5, p95, 'memory_per_file');
            (check.violated ? violations : confirmations).push(check);
        }
    }

    // A5: ast_expansion_ratio
    const a5 = assumptions.get('ast_expansion_ratio');
    if (a5) {
        const ratios = fileEvents
            .filter(e => e.ast_size_bytes > 0 && e.file_size_bytes > 0)
            .map(e => e.ast_size_bytes / e.file_size_bytes);
        if (ratios.length > 0) {
            ratios.sort((a, b) => a - b);
            const p5 = ratios[Math.floor(ratios.length * 0.05)];
            const p95 = ratios[Math.floor(ratios.length * 0.95)];
            const observedMax = ratios[ratios.length - 1];
            const check = checkInterval(a5, p5, p95, 'ast_expansion_ratio');
            if (observedMax > a5.interval.hi) {
                check.violated = true;
                check.note = `observed max = ${observedMax.toFixed(1)}x, assumed max = ${a5.interval.hi}x`;
            }
            (check.violated ? violations : confirmations).push(check);
        }
    }

    return { violations, confirmations };
}

function checkInterval(assumption, observedP5, observedP95, name) {
    const { interval } = assumption;
    const violated = observedP5 < interval.lo || observedP95 > interval.hi;
    const suggested = violated
        ? new Interval(
            Math.min(interval.lo, observedP5 * 0.9),
            Math.max(interval.hi, observedP95 * 1.1)
        )
        : null;

    return {
        id: assumption.id,
        name,
        assumed: interval.toString(),
        observed_p5: observedP5,
        observed_p95: observedP95,
        violated,
        suggested: suggested?.toString() ?? null,
        note: null,
    };
}

// ---------------------------------------------------------------------------
// 9. printReport
// ---------------------------------------------------------------------------

function printReport(analysis) {
    const lines = [];
    const hr = '='.repeat(72);
    const hr2 = '-'.repeat(72);

    lines.push(hr);
    lines.push('  GRAFEMA ANALYSIS PROFILE REPORT');
    lines.push(hr);
    lines.push('');

    // Phase breakdown
    lines.push('## Phase Breakdown');
    lines.push(hr2);
    if (analysis.phases.length === 0) {
        lines.push('  No phase events found');
    } else {
        const maxDur = Math.max(...analysis.phases.map(p => p.duration_ms));
        for (const p of analysis.phases) {
            const barLen = maxDur > 0 ? Math.round((p.duration_ms / maxDur) * 40) : 0;
            const bar = '\u2588'.repeat(barLen);
            lines.push(
                `  ${p.phase.padEnd(28)} ${formatMs(p.duration_ms).padStart(10)}  ${p.pct.toFixed(1).padStart(5)}%  ${bar}`
            );
        }
    }
    lines.push('');

    // File distribution
    lines.push('## File Analysis Distribution');
    lines.push(hr2);
    const fd = analysis.files;
    if (fd.count === 0) {
        lines.push('  No file_analyzed events found (old profiler format?)');
    } else {
        lines.push(`  Files with metrics: ${fd.count}${fd.uninstrumented ? ` (${fd.uninstrumented} without metrics — non-JS languages)` : ''}`);
        lines.push('');

        // Histogram
        const maxCount = Math.max(...fd.histogram.map(b => b.count), 1);
        for (const b of fd.histogram) {
            const barLen = Math.round((b.count / maxCount) * 40);
            const bar = '\u2588'.repeat(barLen);
            lines.push(
                `  ${b.label.padEnd(12)} ${String(b.count).padStart(6)} files  ${bar}`
            );
        }
        lines.push('');

        // Percentiles table
        lines.push('  Percentiles:');
        lines.push('  ' + ''.padEnd(14) + 'P50'.padStart(10) + 'P90'.padStart(10) + 'P99'.padStart(10) + 'Max'.padStart(10));
        for (const [label, data] of [['total_ms', fd.percentiles.total], ['parse_ms', fd.percentiles.parse], ['analyze_ms', fd.percentiles.analyze]]) {
            lines.push(
                `  ${label.padEnd(14)}${formatMs(data.p50).padStart(10)}${formatMs(data.p90).padStart(10)}${formatMs(data.p99).padStart(10)}${formatMs(data.max).padStart(10)}`
            );
        }
    }
    lines.push('');

    // Outliers
    lines.push('## Outliers');
    lines.push(hr2);
    if (analysis.outliers.length === 0) {
        lines.push('  No outliers detected');
    } else {
        lines.push(`  Found ${analysis.outliers.length} outlier(s):`);
        lines.push('');
        for (const o of analysis.outliers.slice(0, 20)) { // Show top 20
            lines.push(`  * ${o.file}`);
            lines.push(`    total=${formatMs(o.total_ms)}  parse=${formatMs(o.parse_ms)}  analyze=${formatMs(o.analyze_ms)}${o.ast_expansion != null ? `  ast_expansion=${o.ast_expansion.toFixed(1)}x` : ''}`);
            lines.push(`    reason: ${o.reason}`);
        }
        if (analysis.outliers.length > 20) {
            lines.push(`  ... and ${analysis.outliers.length - 20} more`);
        }
    }
    lines.push('');

    // Memory
    lines.push('## Memory Profile');
    lines.push(hr2);
    const mem = analysis.memory;
    if (mem.peak_rss_mb === 0) {
        lines.push('  No RSS data in events');
    } else {
        lines.push(`  Peak RSS:            ${mem.peak_rss_mb.toFixed(1)} MB`);
        lines.push(`  Max RSS delta:       ${mem.max_delta_mb.toFixed(1)} MB (at: ${mem.max_delta_event ?? 'unknown'})`);
        if (mem.per_file_estimate_kb > 0) {
            lines.push(`  Per-file estimate:   ${mem.per_file_estimate_kb.toFixed(0)} KB (median of positive deltas)`);
        }
        if (mem.phase_attribution) {
            lines.push('');
            lines.push('  Memory attribution by phase:');
            for (const pa of mem.phase_attribution) {
                const sign = pa.delta_mb >= 0 ? '+' : '';
                lines.push(`    ${pa.phase.padEnd(24)} ${sign}${pa.delta_mb.toFixed(1)} MB`);
            }
        }
    }
    lines.push('');

    // Critical path
    lines.push('## Critical Path');
    lines.push(hr2);
    const cp = analysis.criticalPath;
    if (cp.phases.length === 0) {
        lines.push(`  Total elapsed: ${formatMs(cp.total_ms)}`);
        lines.push('  No phase breakdown available');
    } else {
        lines.push(`  Total pipeline: ${formatMs(cp.total_ms)}`);
        lines.push('');
        for (const p of cp.phases) {
            const marker = p.parallel ? ' [parallel]' : ' [sequential]';
            lines.push(`  ${p.name.padEnd(24)} ${formatMs(p.duration_ms).padStart(10)}${marker}`);
        }
        if (cp.bottleneck) {
            lines.push('');
            lines.push(`  >>> Bottleneck: ${cp.bottleneck}`);
        }
    }
    lines.push('');

    // Sensitivity
    lines.push('## Sensitivity Analysis');
    lines.push(hr2);
    if (analysis.sensitivity.length === 0) {
        lines.push('  No phase data for sensitivity analysis');
    } else {
        lines.push('  What happens if a phase gets slower?');
        lines.push('');
        lines.push('  ' + 'Phase'.padEnd(22) + 'Current'.padStart(10) + 'If 2x'.padStart(12) + 'If 10x'.padStart(12) + 'Weight'.padStart(10));
        for (const s of analysis.sensitivity) {
            lines.push(
                `  ${s.phase.padEnd(22)}${formatMs(s.current_ms).padStart(10)}${formatMs(s.impact_2x_ms).padStart(12)}${formatMs(s.impact_10x_ms).padStart(12)}${(s.sensitivity_pct.toFixed(1) + '%').padStart(10)}`
            );
        }
    }
    lines.push('');

    // Predictions
    if (analysis.predictions) {
        lines.push('## Scaling Predictions');
        lines.push(hr2);
        const pred = analysis.predictions;
        if (pred.predicted_time === null) {
            lines.push(`  ${pred.note}`);
        } else {
            lines.push(`  Current:     ${pred.current_files} files`);
            lines.push(`  Target:      ${pred.target_files} files (${pred.scale_factor.toFixed(1)}x scale)`);
            lines.push(`  Parallelism: ${pred.parallelism}x (estimated from analysis phase)`);
            lines.push(`  Median/file: ${formatMs(pred.median_per_file_ms)}`);
            lines.push('');
            lines.push(`  Predicted time:   ${formatMs(pred.predicted_time.lo)} - ${formatMs(pred.predicted_time.hi)}`);
            lines.push(`  Predicted memory: ${pred.predicted_memory.lo.toFixed(0)} MB - ${pred.predicted_memory.hi.toFixed(0)} MB`);
        }
        lines.push('');
    }

    // Calibration
    if (analysis.calibration) {
        lines.push('## Calibration');
        lines.push(hr2);
        const cal = analysis.calibration;

        if (cal.note) {
            lines.push(`  ${cal.note}`);
        }

        if (cal.violations.length > 0) {
            lines.push('');
            lines.push('  VIOLATIONS (assumptions not matching observed data):');
            for (const v of cal.violations) {
                lines.push(`    [${v.id}] ${v.name}`);
                lines.push(`      assumed:  ${v.assumed}`);
                lines.push(`      observed: P5=${formatNum(v.observed_p5)}, P95=${formatNum(v.observed_p95)}`);
                if (v.note) lines.push(`      note:     ${v.note}`);
                if (v.suggested) lines.push(`      suggest:  ${v.suggested}`);
            }
        }

        if (cal.confirmations.length > 0) {
            lines.push('');
            lines.push('  CONFIRMED (observed within assumed range):');
            for (const c of cal.confirmations) {
                lines.push(`    [${c.id}] ${c.name}: P5=${formatNum(c.observed_p5)}, P95=${formatNum(c.observed_p95)} within ${c.assumed}`);
            }
        }
        lines.push('');
    }

    lines.push(hr);
    console.log(lines.join('\n'));
}

function formatMs(ms) {
    if (ms == null) return 'N/A';
    if (ms < 1) return `${(ms * 1000).toFixed(0)}\u00B5s`;
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const min = Math.floor(ms / 60000);
    const sec = ((ms % 60000) / 1000).toFixed(0);
    return `${min}m${sec}s`;
}

function formatNum(n) {
    if (n == null) return 'N/A';
    if (Number.isInteger(n)) return String(n);
    if (Math.abs(n) < 0.01) return n.toExponential(2);
    if (Math.abs(n) < 1) return n.toFixed(3);
    if (Math.abs(n) < 100) return n.toFixed(1);
    return n.toFixed(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printUsage() {
    console.log(`Usage: node profile-analyze.mjs <profile.jsonl> [options]

Options:
  --predict N         Predict scaling to N files
  --json              Output raw JSON instead of formatted report
  --assumptions PATH  Load assumptions YAML for interval arithmetic
  --help              Show this help

Examples:
  node scripts/profile-analyze.mjs .grafema/analysis-profile.jsonl
  node scripts/profile-analyze.mjs .grafema/analysis-profile.jsonl --predict 50000
  node scripts/profile-analyze.mjs .grafema/analysis-profile.jsonl --json
  node scripts/profile-analyze.mjs .grafema/analysis-profile.jsonl --assumptions scripts/assumptions.yaml`);
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printUsage();
    process.exit(0);
}

// Parse arguments
let profilePath = null;
let predictN = null;
let jsonMode = false;
let assumptionsPath = null;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--predict') {
        predictN = parseInt(args[++i], 10);
        if (isNaN(predictN) || predictN <= 0) {
            console.error('Error: --predict requires a positive integer');
            process.exit(1);
        }
    } else if (args[i] === '--json') {
        jsonMode = true;
    } else if (args[i] === '--assumptions') {
        assumptionsPath = args[++i];
        if (!assumptionsPath) {
            console.error('Error: --assumptions requires a path');
            process.exit(1);
        }
    } else if (!args[i].startsWith('--')) {
        profilePath = args[i];
    } else {
        console.error(`Unknown option: ${args[i]}`);
        printUsage();
        process.exit(1);
    }
}

if (!profilePath) {
    console.error('Error: profile JSONL path is required');
    printUsage();
    process.exit(1);
}

profilePath = resolve(profilePath);

// Load assumptions if provided
let assumptions = null;
if (assumptionsPath) {
    try {
        const yamlText = readFileSync(resolve(assumptionsPath), 'utf-8');
        assumptions = parseAssumptionsYaml(yamlText);
    } catch (err) {
        console.error(`Error loading assumptions: ${err.message}`);
        process.exit(1);
    }
}

// Parse profile
let events;
try {
    events = parseJsonl(profilePath);
} catch (err) {
    console.error(`Error reading profile: ${err.message}`);
    process.exit(1);
}

if (events.length === 0) {
    console.error('No events found in profile');
    process.exit(1);
}

// Run analysis
const analysis = {
    phases: phaseBreakdown(events),
    files: fileDistribution(events),
    outliers: outlierDetection(events),
    memory: memoryProfile(events),
    criticalPath: criticalPath(events),
    sensitivity: sensitivityAnalysis(events),
};

if (predictN) {
    analysis.predictions = scalingPredictions(events, predictN, assumptions);
}

if (assumptions) {
    analysis.calibration = calibrate(events, assumptions);
}

if (jsonMode) {
    console.log(JSON.stringify(analysis, null, 2));
} else {
    printReport(analysis);
}
