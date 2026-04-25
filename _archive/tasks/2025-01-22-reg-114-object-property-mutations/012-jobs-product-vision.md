# Computed Property Names: Product Vision

**Author:** Steve Jobs (Product Design)
**Date:** 2025-01-22
**Topic:** Should we resolve computed property names in data flow tracking?

---

## The Real Question

Before we talk about features, let me ask the question nobody's asking:

**What problem does `'<computed>'` solve for the user?**

None. It's a surrender. It says "I don't know." And every time a user sees `'<computed>'` in their query results, they have to go back to reading code. That's exactly what Grafema promises to eliminate.

---

## User Stories That Matter

### 1. The Event Handler Hunt

You're an engineer joining a legacy Node.js codebase. Millions of lines. The bug report says "the onMessage handler sometimes doesn't fire."

**Today:**
```
> Find what flows into socket
Result: myHandler FLOWS_INTO socket (propertyName: '<computed>')
```

You see the mutation. But which handler? `onMessage`? `onError`? `onClose`?
You're forced to read the code. Grafema failed you.

**Tomorrow:**
```
> Find what flows into socket.onMessage
Result: handleIncomingMessage FLOWS_INTO socket.onMessage

> Find what flows into socket.onError
Result: errorHandler FLOWS_INTO socket.onError
```

Specific. Actionable. No code reading required.

### 2. The Configuration Maze

Legacy enterprise apps love configuration objects. They're built piece by piece across dozens of files.

```javascript
// In file 1
const CONFIG_KEYS = {
  DATABASE: 'database',
  CACHE: 'cache',
  AUTH: 'auth'
};

// In file 2
config[CONFIG_KEYS.DATABASE] = postgresConfig;

// In file 3
config[CONFIG_KEYS.CACHE] = redisConfig;

// In file 4
startServer(config);
```

**Today:** You ask "what database config flows into startServer?" Grafema shrugs.

**Tomorrow:** Grafema traces `CONFIG_KEYS.DATABASE` -> `'database'` -> shows exactly that `postgresConfig` flows into `config.database` which flows into `startServer`.

This is the difference between a tool and a toy.

### 3. The Dependency Injection Container

This is where legacy codebases live or die. Handwritten DI containers, service locators, registry patterns:

```javascript
// Registration
const SERVICE_NAME = 'PaymentProcessor';
container.register(SERVICE_NAME, PayPalProcessor);

// Resolution (somewhere else entirely)
const processor = container.resolve(SERVICE_NAME);
```

**Today:** Grafema sees `PayPalProcessor` flows into `container`, but loses the thread at `'<computed>'`. You can't answer "what implementations exist for PaymentProcessor service?"

**Tomorrow:** You can query: "find all registrations for 'PaymentProcessor'" and get concrete answers.

---

## The Query Experience Transformation

Let me be crystal clear about what changes:

### Before (Current State)

```datalog
% "Show me socket event handlers"
node(X, 'CALL'),
attr(X, 'propertyName', '<computed>').  % Useless. Everything's computed.
```

You get a list of mutations with no meaning attached. You're back to `grep`.

### After (With Resolution)

```datalog
% "Show me socket event handlers"
node(X, 'CALL'),
attr(X, 'propertyName', P),
starts_with(P, 'on').  % onMessage, onError, onClose...
```

You can filter, search, pattern match on actual property names. The graph becomes queryable by *meaning*, not just structure.

---

## Real-World Patterns Where This Is Critical

### Pattern 1: EventEmitter (Node.js Heart)

```javascript
const EVENTS = {
  USER_CREATED: 'user:created',
  ORDER_PLACED: 'order:placed'
};

emitter.on(EVENTS.USER_CREATED, handleUserCreated);
emitter.emit(EVENTS.ORDER_PLACED, orderData);
```

Every Node.js codebase. Every one. And in legacy code, these event names are computed from constants, concatenated from strings, derived from configurations.

Without resolution: "Which handlers listen for user:created?" -> "I don't know."
With resolution: Direct, precise answers.

### Pattern 2: Express Route Handlers

```javascript
const ROUTES = {
  USERS: '/api/users',
  ORDERS: '/api/orders'
};

router[method](ROUTES.USERS, authenticate, validateUser, createUser);
```

You want to know "what middleware protects the users endpoint?" Today: reading code. Tomorrow: one query.

### Pattern 3: Redux Action Types (or any state management)

```javascript
const ACTIONS = {
  SET_USER: 'SET_USER',
  CLEAR_CART: 'CLEAR_CART'
};

function reducer(state, action) {
  switch(action.type) {
    case ACTIONS.SET_USER:
      return { ...state, user: action.payload };
  }
}
```

"What reducers handle SET_USER action?" is a legitimate question. Without computed resolution, unanswerable.

### Pattern 4: Internationalization Keys

```javascript
const I18N_KEYS = {
  WELCOME: 'welcome_message',
  ERROR: 'error_generic'
};

translations[I18N_KEYS.WELCOME] = getWelcomeText();
```

"Is 'welcome_message' defined in all locales?" Requires knowing that `I18N_KEYS.WELCOME` equals `'welcome_message'`.

---

## The Demo That Wins Hearts

Here's how I would demonstrate this feature on stage:

### Setup

A real legacy Node.js application. Socket.IO handlers everywhere. Event emitters galore. Configuration objects built across 50 files.

### The Question

"Show me every handler that processes incoming messages from WebSocket connections."

### The Journey

**Step 1:** Without computed resolution
```
> grafema query "flows_into(X, socket)"
Results: 12 handlers, all with propertyName: '<computed>'
```

Audience: "So... you found 12 things. Which ones are message handlers?"

Me: "We don't know. Let me read the code." *Opens 12 files*

*Audience loses interest*

**Step 2:** With computed resolution
```
> grafema query "flows_into(X, socket), attr(X, 'propertyName', 'onMessage')"
Results:
  - handleIncomingMessage (file: handlers/websocket.js:45)
  - processClientMessage (file: legacy/client-handler.js:123)
```

Audience: "Wait, it knows the actual property names?"

Me: "It resolves them. Constants, string concatenation, configuration values. The graph knows."

### The Wow Moment

"Now tell me: is there any path from user input to an eval() call through these message handlers?"

```
> grafema check "path_exists(MessageHandler, Eval),
>                flows_into(MessageHandler, socket),
>                attr(MessageHandler, 'propertyName', 'onMessage'),
>                node(Eval, 'CALL'), attr(Eval, 'name', 'eval')"

VIOLATION FOUND:
  handleIncomingMessage
    -> parseCommand
    -> executeUserScript
    -> eval(userCode)
```

*Silence. Then applause.*

That's the demo. That's the product.

---

## Priority Assessment

**For Grafema's target audience (massive legacy codebases), this is CRITICAL.**

Why? Because:

1. **Legacy code uses indirection obsessively.** Constants, configuration, abstraction layers. Every property access is through a computed key.

2. **The competition (reading code) doesn't scale.** A human can't grep 10 million lines looking for "what resolves to 'onMessage'".

3. **It unlocks the promise.** Grafema says "query the graph, don't read code." Without computed resolution, that promise has a massive asterisk: *"except for the 80% of property accesses that use variables."*

### Priority Matrix

| Impact Area | Without Resolution | With Resolution |
|------------|-------------------|-----------------|
| Event handlers | Blind | Full visibility |
| Configuration | Partial | Complete tracing |
| DI containers | Useless | Fully queryable |
| State management | Limited | Action-aware |
| I18n | Guessing | Deterministic |

---

## Recommended Scope

Don't try to solve everything. Start with what matters:

### Phase 1: Constant Resolution (High Impact, Lower Complexity)

Resolve property names when the key is:
- A direct constant: `obj[CONST]` where `const CONST = 'value'`
- A simple member access: `obj[CONFIG.KEY]` where `CONFIG.KEY = 'value'`

This covers 70% of real-world computed properties.

### Phase 2: String Operations (Medium Impact, Medium Complexity)

Resolve when the key involves:
- Concatenation: `'on' + eventName`
- Template literals: `\`user_\${action}\``

### Phase 3: Complex Expressions (Lower Priority)

Function calls, conditional logic, etc. These are edge cases. Don't let them block shipping Phase 1.

---

## The Bottom Line

Every `'<computed>'` in our output is a moment where we failed the user.

The user came to Grafema because they don't want to read millions of lines of code. When we say `'<computed>'`, we're telling them "go read the code." We're breaking our promise.

Computed property resolution isn't a nice-to-have feature. It's table stakes for the product vision. Without it, we're a fancy grep. With it, we're the tool that actually understands code.

Ship it.

---

*"People don't know what they want until you show it to them."*
*But they definitely know what they DON'T want: another tool that makes them read code.*
