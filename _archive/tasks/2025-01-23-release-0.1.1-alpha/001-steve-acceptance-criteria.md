# Grafema 0.1.1-alpha Release Acceptance Criteria

**Author:** Steve Jobs (Product Design)
**Date:** 2025-01-24
**Status:** DRAFT

---

## The One Thing That Matters

Before we talk about checklists and blockers, let's be honest: **this alpha is not ready**.

I ran through the experience. Here's what happened:

1. I installed Grafema
2. I ran `grafema init`
3. I ran `grafema analyze`
4. I tried to query through MCP
5. **Nothing worked together**

The CLI and MCP don't share data. The config format is inconsistent. TypeScript projects aren't analyzed correctly. This isn't a collection of bugs - this is a product that doesn't work.

**An alpha can have rough edges. An alpha cannot fail at its core promise.**

Our core promise: "AI should query the graph, not read code."

If the AI can't even see the graph we created, we have no product.

---

## Happy Path Definition

For 0.1.1-alpha, we make ONE promise:

> **"Install Grafema, analyze a JavaScript/TypeScript project, query results through MCP."**

That's it. One path. One promise. It must work flawlessly.

### The Exact Scenario

A developer wants to understand their React/Node.js codebase using an AI assistant.

**Environment:**
- macOS or Linux
- Node.js 18+
- A JavaScript/TypeScript project (single app OR monorepo)
- Claude Desktop with MCP support

**Journey:**

```
INSTALL -> INIT -> ANALYZE -> QUERY
```

Each step must succeed. Each step must lead naturally to the next.

---

## Happy Path Test Script

Run this EXACTLY. Every step must pass.

### Step 0: Clean Slate

```bash
# Remove any previous Grafema installation
npm uninstall -g @grafema/cli
rm -rf ~/.grafema

# Install fresh
npm install -g @grafema/cli@0.1.1-alpha

# Verify
grafema --version
# Expected: 0.1.1-alpha
```

### Step 1: Initialize Project

```bash
cd /path/to/your/project

grafema init
```

**Expected Output:**
```
Grafema initialized in /path/to/your/project/.grafema
Config: /path/to/your/project/.grafema/config.yaml

Next: Run 'grafema analyze' to build the graph
```

**Verification:**
```bash
ls -la .grafema/
# Expected: config.yaml exists (NOT config.json)

cat .grafema/config.yaml
# Expected: Valid YAML with project configuration
```

### Step 2: Analyze Project

```bash
grafema analyze
```

**Expected Output:**
```
Analyzing /path/to/your/project...

Discovered services:
  - frontend (apps/frontend) - React app
  - backend (apps/backend) - Node.js service

Analysis complete:
  - 5,234 nodes created
  - 12,847 edges created
  - 0 errors

Database: /path/to/your/project/.grafema/graph.db

Next: Configure MCP or run 'grafema query' to explore
```

**Verification:**
```bash
grafema stats
# Expected: Shows node counts by type (MODULE, FUNCTION, VARIABLE, etc.)

grafema query "FUNCTION"
# Expected: Returns list of functions
```

### Step 3: Connect MCP

Configure Claude Desktop:

```json
{
  "mcpServers": {
    "grafema": {
      "command": "grafema",
      "args": ["mcp"],
      "env": {
        "GRAFEMA_PROJECT_PATH": "/path/to/your/project"
      }
    }
  }
}
```

Restart Claude Desktop.

### Step 4: Query Through MCP

In Claude Desktop, ask:

> "What functions are in this project?"

**Expected:** Claude calls `query_nodes` and returns a list of functions FROM THE ANALYZED PROJECT.

> "Show me the stats for this project"

**Expected:**
```
Project: /path/to/your/project
Nodes: 5,234
  - MODULE: 127
  - FUNCTION: 892
  - VARIABLE: 3,215
  - ...
```

**CRITICAL CHECK:** The numbers MUST match what CLI reported in Step 2.

### Step 5: Trace a Variable

In Claude Desktop:

> "Where does the 'response' variable in fetchInvitations come from?"

**Expected:** Claude traces the variable origin and shows data flow.

If the variable is in a try/catch block, behavior is documented:
- Either it works
- Or Claude explains: "Variables inside try/catch blocks are not yet supported (REG-178)"

---

## Acceptance Checklist

### MUST PASS (Blockers)

| ID | Requirement | Test Command | Expected | Blocks |
|----|-------------|--------------|----------|--------|
| A1 | CLI installs globally | `npm i -g @grafema/cli` | No errors | REG-170 |
| A2 | `grafema init` creates config.yaml | `cat .grafema/config.yaml` | Valid YAML | REG-170 |
| A3 | `grafema analyze` reads config.yaml | Check logs | Uses YAML config | REG-170 |
| A4 | MCP sees CLI-analyzed data | `get_stats` after `analyze` | Same node count | **REG-181** |
| A5 | CLI sees MCP-analyzed data | `grafema stats` after MCP | Same node count | **REG-181** |
| A6 | TypeScript src/ analyzed, not dist/ | Check analyzed files | src/*.ts present | REG-172 |
| A7 | Basic query works | `query_nodes` via MCP | Returns nodes | REG-181 |

### SHOULD PASS (Important but not blocking)

| ID | Requirement | Test Command | Expected | Issue |
|----|-------------|--------------|----------|-------|
| B1 | Monorepo workspaces detected | `analyze` on monorepo | Multiple services | REG-171 |
| B2 | `trace` command works | `grafema trace "X"` | Shows data flow | REG-179 |
| B3 | try/catch variables extracted | Query for variable in try | Found | REG-178 |
| B4 | Node lookup by semantic ID | `grafema get <id>` | Returns node | REG-179 |

### DOCUMENTED LIMITATIONS (Known issues, noted in release)

| ID | Limitation | Workaround | Issue |
|----|------------|------------|-------|
| C1 | No npm workspace auto-detection | Manual service config | REG-171 |
| C2 | try/catch variables missing | None | REG-178 |
| C3 | Limited debugging tools | Check logs manually | REG-177 |

---

## Release Blockers

**MUST FIX before 0.1.1-alpha:**

### 1. REG-181: MCP/CLI Data Sharing (CRITICAL)

**Why it's a blocker:** This is the product. If CLI and MCP don't share data, there is no product. Period.

**Acceptance:**
- `grafema analyze` creates 5000 nodes
- `grafema mcp` starts
- MCP `get_stats` shows 5000 nodes (not 1)

### 2. REG-170: Config YAML/JSON Incompatibility (HIGH)

**Why it's a blocker:** User's configuration is silently ignored. They think they're configuring Grafema, but nothing happens. This destroys trust immediately.

**Acceptance:**
- `grafema init` creates `config.yaml`
- `grafema analyze` reads `config.yaml`
- Config changes take effect

### 3. REG-172: TypeScript dist/ vs src/ (HIGH)

**Why it's a blocker:** Most modern projects are TypeScript. Analyzing compiled output means:
- Old code (if built long ago)
- No code (if never built)
- Wrong code (source maps, minification)

**Acceptance:**
- Project has `tsconfig.json`
- `grafema analyze` processes `src/**/*.ts`
- NOT `dist/**/*.js`

---

## Not Blockers (For 0.1.2+)

### REG-171: npm Workspaces

**Why not blocking:** User can configure services manually. It's friction, not failure.

**Document:** "For monorepos, configure services in config.yaml manually."

### REG-177: Debugging Tools

**Why not blocking:** It's a nice-to-have for power users. Alpha users expect to dig through logs.

**Document:** "Check .grafema/logs/ for analysis details."

### REG-178: try/catch Variables

**Why not blocking:** It's a coverage gap, not a failure. The tool still works for code outside try/catch.

**Document:** "Variables declared inside try/catch blocks are not yet extracted."

### REG-179: CLI Query by ID

**Why not blocking:** Advanced feature. Users can work around with grep/manual lookup.

**Document:** "Use `grafema query` with patterns, not semantic IDs."

---

## Demo Script

Before marking 0.1.1-alpha as ready, I will run this demo:

### The 3-Minute Demo

**Setup:** Fresh machine, never seen Grafema.

**Script:**

```
[0:00] "Let me show you Grafema."

[0:10] npm install -g @grafema/cli
       grafema init
       grafema analyze

[0:45] "That's it. My entire codebase is now in a graph."

[1:00] Open Claude Desktop
       "What are the main functions in this project?"

[1:30] Claude answers with accurate list from graph.

[2:00] "Where does user authentication happen?"

[2:30] Claude traces through the codebase, shows entry points.

[3:00] "That's Grafema. AI queries the graph, not the code."
```

**If I can't do this demo, we don't ship.**

---

## Summary

| Category | Issues | Action |
|----------|--------|--------|
| **Blockers** | REG-181, REG-170, REG-172 | MUST FIX |
| **Important** | REG-171, REG-179 | Fix or document |
| **Known Limits** | REG-177, REG-178 | Document in release notes |

**Minimum viable alpha:** Fix REG-181, REG-170, REG-172.

**Target date:** When blockers are fixed, not before.

---

## Final Word

We're not shipping a version number. We're shipping a promise.

The promise is simple: "Analyze once, query everywhere."

Right now, that promise is broken. Fix it, then ship.

-- Steve
