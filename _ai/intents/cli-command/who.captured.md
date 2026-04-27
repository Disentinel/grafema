<!-- captured-at: 2026-04-27 -->
<!-- fixture: this repo (Grafema itself) -->

## find-callers-of-a-function
```
handleRequest — 1 caller

  packages/util/src/api/GraphAPI.ts:105 <anonymous>          [resolved]
```

## json-output-for-scripts
```
{
  "symbol": "handleRequest",
  "targetNode": {
    "id": "grafema://github.com/Disentinel/grafema/packages/util/src/api/GraphAPI.ts#METHOD-%3EhandleRequest%5Bin:GraphAPI%5D",
    "type": "METHOD",
    "name": "handleRequest",
    "file": "packages/util/src/api/GraphAPI.ts"
  },
  "callers": [
    {
      "file": "packages/util/src/api/GraphAPI.ts",
      "line": 105,
      "caller": "<anonymous>",
      "resolved": true
    }
  ],
  "total": 1
}
```
