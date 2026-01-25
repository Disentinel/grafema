# REG-208: Impact analysis for classes should aggregate callers of all methods

## Problem

Impact analysis for classes shows 0 callers even when methods are called:

```
[CLASS] SocketService → 0 direct callers
[CLASS] UserModel → 0 direct callers
```

But method shows callers correctly:

```
findById (method of UserModel) → 2 callers ✓
```

## Expected Behavior

Class impact should aggregate:

* Direct class references (new, instanceof)
* All method callers
* Static method callers

```
[CLASS] UserModel → 5 total usages
  - 2 via findById()
  - 1 via create()
  - 2 via new UserModel()
```

## Acceptance Criteria

- [ ] Class impact includes method callers
- [ ] Breakdown by usage type (method calls, instantiation, etc.)
- [ ] Tests pass
