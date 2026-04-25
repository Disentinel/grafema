# User Revision to Plan

- Method calls also in scope (handle CALLS_ON edges)
- Unresolved calls should raise an ISSUE node (not silently skip)
- Rest parameters included (link them)
- More args than params — current matching is correct, but also raise an ISSUE
- Spread arguments in scope
- Destructured parameters in scope
