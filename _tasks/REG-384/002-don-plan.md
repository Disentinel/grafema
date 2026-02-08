# Don Plan — REG-384

## Goal
Improve HTTP request↔route matching accuracy by:
- Parsing HTTP method from fetch/axios options more reliably
- Supporting parametric path matching without false positives
- Allowing GET fallback only when method is truly unspecified

## Current Reality (from code read)
- FetchAnalyzer defaults `method` to GET whenever it cannot extract a method from options.
- HTTPConnectionEnricher uses `request.method || 'GET'` and `route.method || 'GET'` and requires equality.
- Path matching already normalizes `:param` and `${...}` to `{param}` and uses a regex to match concrete values.

## External Prior Art (WebSearch summary)
- Fetch RequestInit defaults method to GET if not specified. (MDN)
- Axios request config defaults method to GET if not specified. (Axios docs)
- Express route params use `:param` segments and `-`/`.` are literal, not wildcards. (Express docs)

Sources:
- https://developer.mozilla.org/en-US/docs/Web/API/RequestInit
- https://axios-http.com/docs/req_config
- https://expressjs.com/en/guide/routing.html

## Proposed Direction (High Level)
1. **Method detection**
   - Parse `method` from options object literal using AST.
   - Resolve simple const identifiers in the same module (e.g., `const METHOD = 'POST'`).
   - Distinguish three states:
     - `explicit`: method parsed to a string
     - `default`: method omitted (runtime default GET)
     - `unknown`: method specified but not statically resolved

2. **Matching policy**
   - If `explicit`: require exact method match.
   - If `default`: allow match only when route method is explicitly GET.
   - If `unknown`: do not match (avoid false positives).

3. **Path matching correctness**
   - Keep current parametric matching, but escape regex metacharacters in static segments so `.` remains literal, per Express semantics.

4. **Tests-first**
   - Unit tests for method extraction states in FetchAnalyzer.
   - Unit tests for method fallback behavior in HTTPConnectionEnricher.
   - Keep existing param matching tests; add coverage for `.` in paths if we change regex escaping.

## Risks / Tradeoffs
- Slightly lower recall for requests with dynamic method values (intentional to reduce false positives).
- Minor extra AST work per module to resolve const method values (bounded, no new graph-wide passes).

## Non-goals
- Full data-flow resolution of dynamic methods.
- Changing routing framework support beyond Express.

## Note on Dogfooding
To locate the matching logic I had to read source files directly; Grafema queries could not surface plugin implementation details. This is a product gap worth tracking if you want.
