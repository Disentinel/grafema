# REG-325: Node name shows JSON metadata instead of readable name

## Problem

Some node names display raw JSON metadata instead of human-readable names.

## Example

```
grafema get 'http:route#GET:/invitations/received#...#346'

[http:route] {"originalId":"LITERAL#return#...","value":true,"valueType":"boolean","line":108}
```

Expected:

```
[http:route] GET /invitations/received
```

## Impact

* CLI output is unreadable
* VS Code extension shows corrupted labels
* Debugging graph structure is difficult

## Acceptance Criteria

- [ ] `grafema get` shows readable node names
- [ ] `grafema ls` shows readable node names
- [ ] Identify where name gets overwritten with JSON
