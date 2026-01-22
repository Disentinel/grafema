# REG-119: Analyzer doesn't process files with only imports

## Source

Discovered during REG-118 fix. Test "should handle file with only imports" fails.

## Problem

Files that contain only import statements (no functions, classes, or variables) are not being analyzed. The analyzer skips them, resulting in 0 nodes.

## Expected Behavior

File with `import { readFile } from 'fs'` should create:

* IMPORT node
* EXTERNAL_MODULE node

## Actual Behavior

0 nodes created. File appears to be skipped entirely.

## Investigation Needed

* Check why JSASTAnalyzer skips import-only files
* May be related to dependency tree building logic

## Linear Issue

https://linear.app/reginaflow/issue/REG-119/analyzer-doesnt-process-files-with-only-imports
