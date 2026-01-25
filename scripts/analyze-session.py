#!/usr/bin/env python3
"""
Analyze Claude Code session JSONL files.
Extracts tool usage statistics and token consumption.

Usage:
    python scripts/analyze-session.py <session.jsonl>
    python scripts/analyze-session.py ~/.claude/projects/-Users-vadimr-grafema/*.jsonl
"""

import sys
import json
import argparse
from pathlib import Path
from collections import defaultdict
from datetime import datetime


def analyze_session(jsonl_path: Path) -> dict:
    """Analyze a single session JSONL file."""
    stats = {
        'session_id': None,
        'file': str(jsonl_path),
        'messages': {'user': 0, 'assistant': 0, 'system': 0},
        'tool_calls': defaultdict(int),
        'tool_result_sizes': defaultdict(lambda: {'count': 0, 'total_chars': 0}),
        'tokens': {
            'input': 0,
            'output': 0,
            'cache_read': 0,
            'cache_creation': 0,
        },
        'models': defaultdict(lambda: {'input': 0, 'output': 0, 'calls': 0}),
        'timestamps': {'first': None, 'last': None},
    }

    # Read all lines for two-pass processing
    with open(jsonl_path, 'r') as f:
        lines = f.readlines()

    # First pass: map tool_use_id to tool name and collect basic stats
    tool_names = {}
    for line in lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        record_type = obj.get('type')

        # Track session ID
        if 'sessionId' in obj and not stats['session_id']:
            stats['session_id'] = obj['sessionId']

        # Track timestamps
        if 'timestamp' in obj:
            ts = obj['timestamp']
            if stats['timestamps']['first'] is None or ts < stats['timestamps']['first']:
                stats['timestamps']['first'] = ts
            if stats['timestamps']['last'] is None or ts > stats['timestamps']['last']:
                stats['timestamps']['last'] = ts

        # Count message types
        if record_type in ('user', 'assistant', 'system'):
            stats['messages'][record_type] += 1

        # Process assistant messages
        if record_type == 'assistant' and 'message' in obj:
            msg = obj['message']

            # Token usage
            usage = msg.get('usage', {})
            stats['tokens']['input'] += usage.get('input_tokens', 0)
            stats['tokens']['output'] += usage.get('output_tokens', 0)
            stats['tokens']['cache_read'] += usage.get('cache_read_input_tokens', 0)
            stats['tokens']['cache_creation'] += usage.get('cache_creation_input_tokens', 0)

            # Model tracking
            model = msg.get('model', 'unknown')
            stats['models'][model]['input'] += usage.get('input_tokens', 0)
            stats['models'][model]['output'] += usage.get('output_tokens', 0)
            stats['models'][model]['calls'] += 1

            # Tool calls - map id to name
            for block in msg.get('content', []):
                if isinstance(block, dict) and block.get('type') == 'tool_use':
                    tool_name = block.get('name', 'unknown')
                    tool_id = block.get('id')
                    stats['tool_calls'][tool_name] += 1
                    if tool_id:
                        tool_names[tool_id] = tool_name

    # Second pass: measure tool result sizes
    for line in lines:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        if obj.get('type') == 'user' and 'message' in obj:
            msg = obj['message']
            if isinstance(msg.get('content'), list):
                for block in msg['content']:
                    if isinstance(block, dict) and block.get('type') == 'tool_result':
                        tool_id = block.get('tool_use_id')
                        tool_name = tool_names.get(tool_id, 'unknown')
                        content = block.get('content', '')

                        # Calculate content size
                        if isinstance(content, str):
                            size = len(content)
                        elif isinstance(content, list):
                            size = sum(len(json.dumps(b)) for b in content)
                        else:
                            size = len(json.dumps(content))

                        stats['tool_result_sizes'][tool_name]['count'] += 1
                        stats['tool_result_sizes'][tool_name]['total_chars'] += size

    # Convert defaultdicts to regular dicts for JSON serialization
    stats['tool_calls'] = dict(stats['tool_calls'])
    stats['tool_result_sizes'] = {k: dict(v) for k, v in stats['tool_result_sizes'].items()}
    stats['models'] = {k: dict(v) for k, v in stats['models'].items()}

    return stats


def format_tokens(n: int) -> str:
    """Format token count with K/M suffix."""
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    elif n >= 1_000:
        return f"{n/1_000:.1f}K"
    return str(n)


def print_stats(stats: dict, verbose: bool = False):
    """Print formatted statistics."""
    print(f"\n{'='*60}")
    print(f"Session: {stats['session_id'] or 'unknown'}")
    print(f"File: {stats['file']}")

    if stats['timestamps']['first'] and stats['timestamps']['last']:
        try:
            first = datetime.fromisoformat(stats['timestamps']['first'].replace('Z', '+00:00'))
            last = datetime.fromisoformat(stats['timestamps']['last'].replace('Z', '+00:00'))
            duration = last - first
            print(f"Duration: {duration}")
        except:
            pass

    print(f"\n--- Messages ---")
    print(f"  User: {stats['messages']['user']}")
    print(f"  Assistant: {stats['messages']['assistant']}")
    print(f"  System: {stats['messages']['system']}")

    print(f"\n--- Tokens ---")
    print(f"  Input:          {format_tokens(stats['tokens']['input']):>8}")
    print(f"  Output:         {format_tokens(stats['tokens']['output']):>8}")
    print(f"  Cache read:     {format_tokens(stats['tokens']['cache_read']):>8}")
    print(f"  Cache creation: {format_tokens(stats['tokens']['cache_creation']):>8}")
    total = sum(stats['tokens'].values())
    print(f"  TOTAL:          {format_tokens(total):>8}")

    if stats['models']:
        print(f"\n--- Models ---")
        for model, usage in sorted(stats['models'].items()):
            print(f"  {model}:")
            print(f"    Calls: {usage['calls']}, In: {format_tokens(usage['input'])}, Out: {format_tokens(usage['output'])}")

    if stats['tool_calls']:
        print(f"\n--- Tool Calls ---")
        # Group by category
        read_tools = ['Read', 'Glob', 'Grep']
        edit_tools = ['Edit', 'Write', 'NotebookEdit']

        read_total = sum(stats['tool_calls'].get(t, 0) for t in read_tools)
        edit_total = sum(stats['tool_calls'].get(t, 0) for t in edit_tools)

        print(f"  [Read/Search: {read_total}]")
        for tool in read_tools:
            if tool in stats['tool_calls']:
                print(f"    {tool}: {stats['tool_calls'][tool]}")

        print(f"  [Edit/Write: {edit_total}]")
        for tool in edit_tools:
            if tool in stats['tool_calls']:
                print(f"    {tool}: {stats['tool_calls'][tool]}")

        print(f"  [Other]")
        for tool, count in sorted(stats['tool_calls'].items(), key=lambda x: -x[1]):
            if tool not in read_tools and tool not in edit_tools:
                print(f"    {tool}: {count}")


def print_summary(all_stats: list):
    """Print aggregate summary across all sessions."""
    print(f"\n{'='*60}")
    print(f"AGGREGATE SUMMARY ({len(all_stats)} sessions)")
    print(f"{'='*60}")

    totals = {
        'messages': {'user': 0, 'assistant': 0, 'system': 0},
        'tokens': {'input': 0, 'output': 0, 'cache_read': 0, 'cache_creation': 0},
        'tool_calls': defaultdict(int),
        'tool_result_sizes': defaultdict(lambda: {'count': 0, 'total_chars': 0}),
    }

    for stats in all_stats:
        for k, v in stats['messages'].items():
            totals['messages'][k] += v
        for k, v in stats['tokens'].items():
            totals['tokens'][k] += v
        for tool, count in stats['tool_calls'].items():
            totals['tool_calls'][tool] += count
        for tool, data in stats.get('tool_result_sizes', {}).items():
            totals['tool_result_sizes'][tool]['count'] += data['count']
            totals['tool_result_sizes'][tool]['total_chars'] += data['total_chars']

    print(f"\n--- Total Messages ---")
    print(f"  User: {totals['messages']['user']}")
    print(f"  Assistant: {totals['messages']['assistant']}")

    print(f"\n--- Total Tokens ---")
    print(f"  Input:          {format_tokens(totals['tokens']['input']):>8}")
    print(f"  Output:         {format_tokens(totals['tokens']['output']):>8}")
    print(f"  Cache read:     {format_tokens(totals['tokens']['cache_read']):>8}")
    print(f"  Cache creation: {format_tokens(totals['tokens']['cache_creation']):>8}")

    print(f"\n--- Total Tool Calls ---")
    read_tools = ['Read', 'Glob', 'Grep']
    read_total = sum(totals['tool_calls'].get(t, 0) for t in read_tools)
    print(f"  Read/Search tools: {read_total}")
    for tool in read_tools:
        if totals['tool_calls'][tool]:
            print(f"    {tool}: {totals['tool_calls'][tool]}")

    print(f"\n  All tools:")
    for tool, count in sorted(totals['tool_calls'].items(), key=lambda x: -x[1])[:15]:
        print(f"    {tool}: {count}")

    # Tool result sizes (input to model)
    if totals['tool_result_sizes']:
        print(f"\n--- Tool Result Sizes (chars returned to model) ---")
        read_tools = ['Read', 'Glob', 'Grep']
        read_chars = sum(totals['tool_result_sizes'].get(t, {}).get('total_chars', 0) for t in read_tools)
        total_chars = sum(d['total_chars'] for d in totals['tool_result_sizes'].values())

        print(f"  Read/Search tools: {read_chars:,} chars ({read_chars*100//total_chars if total_chars else 0}% of total)")
        for tool in read_tools:
            data = totals['tool_result_sizes'].get(tool, {})
            if data.get('total_chars'):
                avg = data['total_chars'] // data['count'] if data['count'] else 0
                print(f"    {tool}: {data['total_chars']:,} chars (avg {avg:,}/call)")

        print(f"\n  All tools by size:")
        for tool, data in sorted(totals['tool_result_sizes'].items(), key=lambda x: -x[1]['total_chars'])[:10]:
            avg = data['total_chars'] // data['count'] if data['count'] else 0
            pct = data['total_chars'] * 100 // total_chars if total_chars else 0
            print(f"    {tool}: {data['total_chars']:,} chars ({pct}%, avg {avg:,}/call)")


def find_grafema_sessions(worktree: str = None) -> list:
    """Find all Grafema session files, optionally filtered by worktree."""
    claude_dir = Path.home() / '.claude' / 'projects'
    files = []

    if worktree:
        # Specific worktree
        pattern = f'-Users-vadimr-grafema-worker-{worktree}'
        project_dir = claude_dir / pattern
        if project_dir.exists():
            files.extend(project_dir.glob('*.jsonl'))
    else:
        # All grafema projects
        for project_dir in claude_dir.glob('-Users-vadimr-grafema*'):
            files.extend(project_dir.glob('*.jsonl'))

    return sorted(files)


def export_snapshot(all_stats: list, output_path: Path, append: bool = True,
                    grafema_mcp: bool = False, note: str = None):
    """Export a dated snapshot of statistics to a JSONL file."""
    from datetime import datetime, timezone

    # Aggregate totals
    totals = {
        'tool_calls': defaultdict(int),
        'tool_result_sizes': defaultdict(lambda: {'count': 0, 'total_chars': 0}),
        'tokens': {'input': 0, 'output': 0, 'cache_read': 0, 'cache_creation': 0},
        'messages': {'user': 0, 'assistant': 0},
    }

    for stats in all_stats:
        for k, v in stats['messages'].items():
            if k in totals['messages']:
                totals['messages'][k] += v
        for k, v in stats['tokens'].items():
            totals['tokens'][k] += v
        for tool, count in stats['tool_calls'].items():
            totals['tool_calls'][tool] += count
        for tool, data in stats.get('tool_result_sizes', {}).items():
            totals['tool_result_sizes'][tool]['count'] += data['count']
            totals['tool_result_sizes'][tool]['total_chars'] += data['total_chars']

    # Create snapshot record
    snapshot = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'grafema_mcp_enabled': grafema_mcp,
        'sessions_count': len(all_stats),
        'messages': totals['messages'],
        'tokens': totals['tokens'],
        'tool_calls': dict(totals['tool_calls']),
        'tool_result_sizes': {k: dict(v) for k, v in totals['tool_result_sizes'].items()},
        # Summary metrics for quick comparison
        'summary': {
            'read_search_calls': sum(totals['tool_calls'].get(t, 0) for t in ['Read', 'Glob', 'Grep']),
            'read_search_chars': sum(totals['tool_result_sizes'].get(t, {}).get('total_chars', 0) for t in ['Read', 'Glob', 'Grep']),
            'total_tool_result_chars': sum(d['total_chars'] for d in totals['tool_result_sizes'].values()),
        }
    }

    if note:
        snapshot['note'] = note

    # Append or write
    mode = 'a' if append and output_path.exists() else 'w'
    with open(output_path, mode) as f:
        f.write(json.dumps(snapshot) + '\n')

    return snapshot


def main():
    parser = argparse.ArgumentParser(
        description='Analyze Claude Code session JSONL files',
        epilog='''
Examples:
  analyze-session.py --grafema                    # All grafema sessions
  analyze-session.py --worktree 1                 # Worker 1 only
  analyze-session.py --worktree 1 2 3             # Workers 1, 2, 3
  analyze-session.py session.jsonl                # Specific file
  analyze-session.py *.jsonl --summary-only       # Summary only
  analyze-session.py --grafema --export           # Export snapshot to stats/
        '''
    )
    parser.add_argument('files', nargs='*', help='JSONL files to analyze')
    parser.add_argument('-v', '--verbose', action='store_true', help='Verbose output')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    parser.add_argument('--summary-only', action='store_true', help='Only show aggregate summary')
    parser.add_argument('--grafema', action='store_true', help='Analyze all Grafema sessions')
    parser.add_argument('--worktree', '-w', nargs='+', help='Analyze specific worktree(s): 1, 2, ..., 8')
    parser.add_argument('--export', '-e', action='store_true', help='Export snapshot to stats/session-stats.jsonl')
    parser.add_argument('--export-path', type=Path, help='Custom export path (default: stats/session-stats.jsonl)')
    parser.add_argument('--grafema-mcp', action='store_true', help='Mark this snapshot as having Grafema MCP enabled')
    parser.add_argument('--note', type=str, help='Add a note to the exported snapshot')
    args = parser.parse_args()

    all_stats = []
    files_to_analyze = []

    # Collect files based on arguments
    if args.grafema:
        files_to_analyze = find_grafema_sessions()
    elif args.worktree:
        for w in args.worktree:
            files_to_analyze.extend(find_grafema_sessions(w))
    else:
        files_to_analyze = [Path(f) for f in args.files]

    if not files_to_analyze:
        print("No files to analyze. Use --grafema, --worktree, or specify files.")
        sys.exit(1)

    for path in files_to_analyze:
        if path.exists():
            stats = analyze_session(path)
            all_stats.append(stats)
            if not args.summary_only and not args.json:
                print_stats(stats, args.verbose)

    if args.json:
        print(json.dumps(all_stats, indent=2))
    elif len(all_stats) > 1:
        print_summary(all_stats)

    # Export snapshot if requested
    if args.export and all_stats:
        # Determine export path
        if args.export_path:
            export_path = args.export_path
        else:
            # Default: stats/session-stats.jsonl in script's parent directory
            script_dir = Path(__file__).resolve().parent.parent
            stats_dir = script_dir / 'stats'
            stats_dir.mkdir(exist_ok=True)
            export_path = stats_dir / 'session-stats.jsonl'

        snapshot = export_snapshot(
            all_stats,
            export_path,
            grafema_mcp=args.grafema_mcp,
            note=args.note
        )
        print(f"\nExported snapshot to {export_path}")
        print(f"  Sessions: {snapshot['sessions_count']}")
        print(f"  Read/Search: {snapshot['summary']['read_search_calls']} calls, {snapshot['summary']['read_search_chars']:,} chars")
        if args.grafema_mcp:
            print(f"  Grafema MCP: enabled")


if __name__ == '__main__':
    main()
