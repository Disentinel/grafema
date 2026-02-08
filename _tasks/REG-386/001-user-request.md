# REG-386: Expose plugin implementations via graph queries (avoid reading source)

## Goal

Make plugin implementations discoverable via Grafema graph queries so agents don't need to open source files to understand analyzer/enricher behavior.

## Acceptance Criteria

* `grafema query` can locate a plugin by name (e.g., `HTTPConnectionEnricher`) and return its source file path and line.
* Plugin metadata (phase, creates, dependencies) is queryable as node attributes.
* Provide a short doc snippet with example queries for discovering plugin behavior.

## Context

While planning REG-384, I had to read `HTTPConnectionEnricher.ts` and `FetchAnalyzer.ts` directly because Grafema could not surface plugin implementation details. This contradicts the project vision "AI should query the graph, not read code."
