# REG-528: Extension не выбирает базу данных автоматически — все панели показывают заглушки

**Source:** Linear REG-528, Priority: High, Labels: v0.2, Bug
**Origin:** QA demo session REG-526 (2026-02-20)

## Problem

Grafema VS Code extension connects to rfdb-server (Status: "Connected"), but does NOT select a database. All graph queries fail with:

```
findNodeAtCursor error: No database selected. Use openDatabase first.
```

All 7 panels (Value Trace, Callers, Blast Radius, Issues, Explorer, Status, Debug Log) show only placeholder text. Hover tooltip doesn't work.

## Reproduction

1. `cd demo && docker-compose up -d`
2. Open `http://localhost:8080`
3. Trust authors → open any file
4. Click on Grafema sidebar → expand panels
5. Click on any entity in code
6. All panels show placeholders, Debug Log shows error

## Expected Behavior

On connection to rfdb-server, extension should automatically select the available database (or offer selection via Command Palette).

## Current State

* Command `Grafema: Open Database` does NOT exist in Command Palette
* Available commands: Copy Tree State, Filter Tree, Find Node at Cursor, Focus on views, Open Blast Radius/Callers/Value Trace, Search Nodes
* Status bar shows "Grafema" — extension loaded but not functional

## Solution Options (from issue)

1. **Auto-select:** on server connection, automatically open the first/only available DB
2. **Command:** add `Grafema: Open Database` / `Grafema: Select Database` to Command Palette
3. **Demo config:** configure extension settings with correct DB path

## Blocks

* QA agent cannot validate any panel — all files blocked
* Full report: `_qa/reports/gap-001.md`
