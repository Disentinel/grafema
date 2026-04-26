# REG-209: Socket.IO events not searchable

## Problem

Overview shows Socket.IO events exist:

```
Socket.IO: 27 emit, 33 listeners
```

But no way to find which events go where.

## Expected Behavior

Ability to search and trace events:

* `grafema query "emit:slotBooked"` → find all emitters
* `grafema query "on:slotBooked"` → find all listeners
* `grafema trace slotBooked --type event` → show emit→listener flow

## Use Case

Understanding real-time communication flow:

* "What happens when slotBooked is emitted?"
* "Who listens to userJoined event?"
* "Show all events in this room"

## Acceptance Criteria

- [ ] Socket.IO events searchable
- [ ] Can find emitters and listeners by event name
- [ ] Can trace event flow
- [ ] Tests pass
