# REG-427: TypeScript class declarations not extracted as CLASS nodes

## Problem

When analyzing TypeScript source files, `JSASTAnalyzer` does not create `CLASS` nodes for class declarations. Running `grafema ls --type CLASS` returns 0 results on a codebase with dozens of classes.

## Impact

* Cannot query class hierarchy, inheritance, or method containment via graph
* `find_nodes --type CLASS` returns nothing
* Limits usefulness of graph for OOP codebases

## Expected Behavior

TypeScript `class` declarations should produce CLASS nodes with:

* Class name as node ID
* Methods as contained FUNCTION/METHOD nodes
* `extends`/`implements` as edges

## Context

`JSASTAnalyzer` currently extracts functions, variables, calls, branches, etc. but appears to skip `ClassDeclaration` AST nodes. This may be intentional (deferred feature) or a gap.

## Found During

Grafema dogfooding setup (2026-02-15).
