# Research Report: Simplest Path to SWE-bench Baseline with Grafema MCP

**Date:** 2026-02-08
**Goal:** Find the minimal, reproducible agent for SWE-bench evaluation where the only variable is Grafema MCP availability

---

## Executive Summary

**Recommended approach: mini-SWE-agent**

The simplest path is to use [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent) (100 lines of Python, bash-only) as the baseline, then add Grafema MCP as an optional tool source. This provides:

- **Minimal complexity:** ~100 lines for agent logic
- **No tool dependencies:** Uses only bash commands (perfect control case)
- **Easy MCP integration:** Can add MCP tools as optional enhancement
- **Proven performance:** 74%+ on SWE-bench Verified
- **Model-agnostic:** Works with any LLM, including Claude

**Key insight:** mini-SWE-agent's bash-only design makes it the perfect control. Adding Grafema MCP as an optional tool layer creates a clean A/B test: same agent, same model, only difference is graph querying capability.

---

## 1. Existing Minimal Agents

### 1.1 Mini-SWE-Agent (RECOMMENDED)

**Source:** [GitHub - SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)

**Key characteristics:**
- **100 lines of Python** for agent class
- **Bash-only execution** - no custom tools
- **No tool-calling API** - just shell commands via subprocess.run
- **Model-agnostic** - works with any LLM
- **Performance:** 74%+ on SWE-bench Verified, 65% in minimal 100-line version

**Architecture:**
```python
# Core agent loop (simplified)
while not done:
    response = llm.query(messages)
    action = parse_bash_command(response)
    result = subprocess.run(action)
    messages.append({"role": "assistant", "content": response})
    messages.append({"role": "user", "content": result.stdout})
```

**Why it's perfect for our use case:**
1. **Minimal dependencies** - easy to reproduce
2. **Bash-only baseline** - clean control group (no tools)
3. **Easy to extend** - add MCP tools without changing agent logic
4. **Princeton-validated** - built by SWE-bench creators
5. **In production** - used by Meta, NVIDIA, Essential AI, Anyscale

**Resources:**
- Documentation: [mini-swe-agent.com](https://mini-swe-agent.com/latest/)
- Quickstart: [Quick start guide](https://mini-swe-agent.com/latest/quickstart/)

### 1.2 SWE-agent (Full Version)

**Source:** [GitHub - SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent)

**Not recommended because:**
- Much more complex (huge configs, monorepo)
- Custom tools and scaffolding
- Development team shifting focus to mini-SWE-agent
- Mini already matches performance while being simpler

### 1.3 Moatless Tools

**Source:** [GitHub - aorwall/moatless-tools](https://github.com/aorwall/moatless-tools)

**Characteristics:**
- More feature-rich framework
- Research-oriented (used in SWE-Search paper)
- Good performance but more complex than mini-SWE-agent

**Not recommended because:**
- More complex than needed for baseline
- Not as minimal as mini-SWE-agent
- Less community adoption

### 1.4 OpenHands/OpenDevin

**Source:** [GitHub - OpenHands/OpenHands](https://github.com/OpenHands/OpenHands)

**Characteristics:**
- Full platform with evaluation harness
- Supports 15+ benchmarks including SWE-bench
- CodeAct 1.0 achieved 21% on SWE-bench Lite (Aug 2024)
- MIT licensed, 188+ contributors

**Advantages:**
- Built-in evaluation harness
- Production-ready platform
- Active development

**Disadvantages for our use case:**
- **Much more complex** than mini-SWE-agent
- Platform overhead vs. simple agent
- Lower performance (21% vs 74%)
- Harder to isolate variables

**Could be useful for:**
- Running full benchmark suites
- Production deployment
- Not ideal for minimal baseline comparison

---

## 2. Claude-Based Agents for SWE-bench

### 2.1 Anthropic's Official Approach

**Source:** [Claude SWE-Bench Performance](https://www.anthropic.com/research/swe-bench-sonnet)

**Performance:**
- Claude 3.5 Sonnet: **49% on SWE-bench Verified** (Oct 2024)
- Claude Sonnet 4.5: **77.2% on SWE-bench**
- Claude Opus 4.5: **79.2-80.9% on SWE-bench Verified** (#1 on leaderboard)

**Architecture details:**
- "Simple prompt and two general purpose tools"
- More time spent optimizing tools than prompts
- Key insight: changed tools to require **absolute filepaths** (model used flawlessly)
- Agent scaffolding handles: prompt generation, output parsing, action execution, feedback loop

**Blog post by Erik Schluntz:** [Twitter/X post](https://x.com/ErikSchluntz/status/1851690352714867074) shows prompts, tools, examples

**Key finding:** Anthropic uses minimal scaffolding, emphasizing tool design over complex agent architecture

### 2.2 Claude Code for SWE-bench

**Not currently available as scripted agent:**
- Claude Code is designed for interactive terminal use
- No public API for automated benchmark runs
- Could potentially be scripted via Agent SDK (see section 2.3)

**Alternative approach mentioned:**
- [GitHub - jimmc414/claudecode_gemini_and_codex_swebench](https://github.com/jimmc414/claudecode_gemini_and_codex_swebench)
- "Toolkit for measuring Claude Code and Codex performance over time"
- May provide automation approach

### 2.3 Claude Agent SDK

**Source:** [Claude Agent SDK Docs](https://platform.claude.com/docs/en/agent-sdk/overview)

**Official repositories:**
- Python: [anthropics/claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python)
- TypeScript: [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript)
- Demos: [anthropics/claude-agent-sdk-demos](https://github.com/anthropics/claude-agent-sdk-demos)

**Capabilities:**
- Same tools, agent loop, and context management as Claude Code
- Programmable in Python and TypeScript
- Built-in tools: Read, Edit, Bash
- MCP integration built-in (see Section 3)

**Example usage:**
```python
from claude_agent_sdk import Agent, ClaudeAgentOptions

agent = Agent(
    system="You are a helpful coding assistant",
    allowed_tools=["Read", "Edit", "Bash"],
    mcp_servers=[...],  # Optional MCP integration
)

result = agent.query("Fix the bug in main.py")
```

**Pros:**
- Official Anthropic SDK
- MCP support built-in
- High-level abstractions

**Cons:**
- More complex than mini-SWE-agent
- Adds SDK dependency
- Less control over agent loop

---

## 3. MCP Integration Options

### 3.1 What is MCP?

**Source:** [Model Context Protocol](https://modelcontextprotocol.io/)

Model Context Protocol (MCP) is an open-source standard developed by Anthropic (released Nov 2024) for connecting AI applications to external systems. It provides standardized tool integration.

**Key capabilities:**
- Tools on demand (loaded when needed)
- Filtered data (pre-processing before model)
- Complex logic in single step
- Standard interface across different tools

### 3.2 MCP with Mini-SWE-Agent

**Current state:** No direct integration found in documentation

**Proposed approach:**
```python
# Extend mini-swe-agent with optional MCP tools
class MCPEnhancedAgent(MinimalAgent):
    def __init__(self, mcp_servers=None):
        super().__init__()
        self.mcp_servers = mcp_servers or []

    def get_available_commands(self):
        # Baseline: bash only
        commands = ["bash"]

        # If MCP enabled: add graph tools
        if self.mcp_servers:
            commands.extend([
                "grafema_query",
                "grafema_find_callers",
                "grafema_trace_dataflow"
            ])

        return commands
```

**A/B test setup:**
```bash
# Control group: bash only
python run.py --agent mini-swe --tasks swe_bench_lite.json

# Treatment group: bash + Grafema MCP
python run.py --agent mini-swe --mcp grafema --tasks swe_bench_lite.json
```

### 3.3 MCP with Claude Agent SDK

**Source:** [Connect to external tools with MCP](https://platform.claude.com/docs/en/agent-sdk/mcp)

**Built-in support:**

**Python:**
```python
from claude_agent_sdk import Agent, create_sdk_mcp_server
from claude_agent_sdk.tools import tool

# Define custom tools
@tool
def grafema_query(query: str) -> dict:
    """Query the Grafema code graph"""
    # Implementation
    pass

# Create MCP server
mcp_server = create_sdk_mcp_server(
    name="grafema",
    version="0.1.0",
    tools=[grafema_query]
)

# Use in agent
agent = Agent(
    system="You are a code analysis agent",
    mcp_servers=[mcp_server],
    allowed_tools=["Read", "Edit", "Bash", "grafema_query"]
)
```

**TypeScript:**
```typescript
// Configure in .mcp.json
{
  "mcpServers": {
    "grafema": {
      "command": "grafema",
      "args": ["mcp"]
    }
  }
}

// Use in agent
const result = await query({
  text: "Fix the bug in main.py",
  mcpServers: readMcpConfigFile(),
  allowedTools: ["Read", "Edit", "Bash", "grafema_*"]
});
```

**Pros:**
- Built-in MCP support
- Clean tool integration
- Official SDK patterns

**Cons:**
- Requires using full SDK
- More complex than mini-SWE-agent
- Less control over agent loop

### 3.4 MCP with OpenHands

**Source:** [Model Context Protocol - OpenHands Docs](https://docs.openhands.dev/openhands/usage/settings/mcp-settings)

**Integration status:** Full support

**Server types:**
- stdio (development/testing)
- SSE (recommended via proxy tools)
- SHTTP (modern streamable HTTP)

**Built-in integrations:**
- Fetch MCP server (automatic)
- Tavily search (when API key configured)

**Custom MCP servers:** [openhands-mcp by jufjuf](https://github.com/jufjuf/openhands-mcp)

**Pros:**
- Mature MCP integration
- Production-ready
- Good documentation

**Cons:**
- Platform overhead
- Complexity for simple baseline

---

## 4. Token Costs and Practical Considerations

### 4.1 Claude API Pricing (Current)

**Source:** [Pricing - Claude API Docs](https://platform.claude.com/docs/en/about-claude/pricing)

**Claude Sonnet 4.5:**
- Input: $3/M tokens (≤200K context), $6/M tokens (>200K)
- Output: $15/M tokens (≤200K context), $22.5/M tokens (>200K)

**Claude Opus 4.5:**
- Input: $5/M tokens
- Output: $25/M tokens

**Batch API:** 50% discount (asynchronous processing)
**Cache reads:** 0.1× base price

### 4.2 SWE-bench Token Usage

**Source:** [SWE-bench paper](https://arxiv.org/pdf/2310.06770)

**Average per task:**
- Issue description: **195 words** (~260 tokens)
- Codebase: **438K lines** (~4-5M tokens)
- Cannot fit full codebase in context

**Successful runs characteristics:**
- "Many successful runs took **hundreds of turns**"
- "Exceeded **100K tokens**"
- Duration and high token costs are significant challenges

**Estimated cost per task (Claude Sonnet 4.5):**
```
Conservative estimate:
- Input: 100K tokens × $3/M = $0.30
- Output: 20K tokens × $15/M = $0.30
- Total per task: ~$0.60

Expensive cases:
- Input: 500K tokens × $6/M = $3.00
- Output: 100K tokens × $22.5/M = $2.25
- Total per task: ~$5.25
```

**SWE-bench Lite:** 300 tasks
- Budget estimate: $180 - $1,575 per full run
- With caching/optimization: could reduce 50%+

**SWE-bench Verified:** 500 tasks
- Budget estimate: $300 - $2,625 per full run

### 4.3 Optimization Strategies

1. **Use Batch API** - 50% discount
2. **Prompt caching** - 0.1× cost for repeated content
3. **Early termination** - stop after N turns if not progressing
4. **Selective evaluation** - start with subset (SWE-bench Lite)
5. **Context pruning** - only load relevant files

**Reference:** [SWE-Pruner paper](https://www.researchgate.net/publication/400071923_SWE-Pruner_Self-Adaptive_Context_Pruning_for_Coding_Agents) discusses self-adaptive context pruning

---

## 5. Recommended Implementation Path

### Phase 1: Baseline Setup (1-2 days)

**Goal:** Get mini-SWE-agent running on SWE-bench Lite

```bash
# Install mini-swe-agent
pip install mini-swe-agent

# Configure for Claude
mini-extra config setup
# Select: Anthropic Claude
# API key: <your-key>
# Model: claude-sonnet-4-5-20250929

# Run on single task (test)
mini run --task django__django-12345

# Run on SWE-bench Lite (300 tasks)
mini batch --dataset swebench_lite --output results_baseline.json
```

**Expected output:**
- JSON file with results per task
- Solve rate percentage
- Token usage per task
- Total cost

**Success criteria:**
- Successfully runs on 1 task
- Can batch process 10 tasks
- Results are reproducible

### Phase 2: MCP Integration (3-5 days)

**Goal:** Add Grafema MCP as optional tool layer

**Option A: Minimal extension (recommended)**

```python
# mcp_mini_swe.py
from mini_swe_agent import MinimalAgent
from grafema_mcp import GrafemaMCPServer

class GrafemaEnhancedAgent(MinimalAgent):
    def __init__(self, use_grafema=False):
        super().__init__()
        self.mcp_server = GrafemaMCPServer() if use_grafema else None

    def format_system_prompt(self):
        base_prompt = super().format_system_prompt()

        if self.mcp_server:
            tools_docs = """

            Additional tools available:
            - grafema query <datalog> : Query the code graph
            - grafema callers <function> : Find all callers
            - grafema dataflow <var> : Trace data flow
            """
            return base_prompt + tools_docs

        return base_prompt

    def execute_action(self, action):
        # Check if it's a Grafema command
        if action.startswith("grafema ") and self.mcp_server:
            return self.mcp_server.execute(action)

        # Otherwise, normal bash execution
        return super().execute_action(action)
```

**Option B: Claude Agent SDK with MCP**

```python
from claude_agent_sdk import Agent, create_sdk_mcp_server
from grafema_mcp import grafema_tools

# Create Grafema MCP server
grafema_mcp = create_sdk_mcp_server(
    name="grafema",
    version="0.1.0",
    tools=grafema_tools
)

# Create agent with optional MCP
def create_agent(use_grafema=False):
    mcp_servers = [grafema_mcp] if use_grafema else []
    tools = ["Read", "Edit", "Bash"]
    if use_grafema:
        tools.extend(["grafema_*"])

    return Agent(
        system="You are a software engineering agent...",
        mcp_servers=mcp_servers,
        allowed_tools=tools
    )
```

### Phase 3: A/B Testing (2-3 days)

**Goal:** Compare baseline vs Grafema-enhanced on same tasks

```bash
# Control group: bash only
python run_experiment.py \
  --agent mini-swe \
  --mcp none \
  --dataset swebench_lite \
  --output results_baseline.json \
  --limit 50

# Treatment group: bash + Grafema
python run_experiment.py \
  --agent mini-swe \
  --mcp grafema \
  --dataset swebench_lite \
  --output results_grafema.json \
  --limit 50

# Analyze results
python analyze_results.py \
  --baseline results_baseline.json \
  --treatment results_grafema.json
```

**Metrics to track:**
- Solve rate (% tasks resolved)
- Tokens used per task
- Wall-clock time per task
- Number of turns per task
- Success on first attempt vs multi-turn
- Types of tasks where Grafema helps most

### Phase 4: Analysis & Iteration (ongoing)

**Questions to answer:**
1. Does Grafema improve solve rate?
2. Does Grafema reduce token usage?
3. Does Grafema reduce time to solution?
4. What types of tasks benefit most from graph queries?
5. What queries does the agent make most often?

**Potential findings:**
- Tasks involving "find all callers" → Grafema helps
- Tasks requiring dataflow analysis → Grafema helps
- Simple bug fixes → no difference
- Large refactorings → Grafema helps with impact analysis

---

## 6. Alternative Approaches (Not Recommended)

### 6.1 SWE-bench Bash Only Baseline

**Source:** [SWE-bench Bash Only](https://www.swebench.com/bash-only.html)

A leaderboard that evaluates LMs in a minimal bash environment with no tools and no scaffold structure - just a simple ReAct agent loop.

**Why not use this:**
- Too minimal (no file operations)
- Not as validated as mini-SWE-agent
- Less community support

### 6.2 Build Custom Agent from Scratch

**Why not:**
- Reinventing the wheel
- Mini-SWE-agent already provides minimal baseline
- Risk of implementation bugs
- No validation on SWE-bench

### 6.3 Use Full SWE-agent

**Why not:**
- Too complex (huge configs)
- Development team moving to mini-SWE-agent
- Harder to isolate MCP variable
- Mini already matches performance

---

## 7. Final Recommendations

### 7.1 Simplest Path (RECOMMENDED)

**Use mini-SWE-agent as baseline + add Grafema MCP**

**Pros:**
- ✅ Minimal code (~100 lines agent logic)
- ✅ Proven performance (74%+ on SWE-bench Verified)
- ✅ Clean control case (bash-only)
- ✅ Easy to add MCP without changing agent
- ✅ Model-agnostic (works with Claude, GPT-4, etc.)
- ✅ Princeton-validated
- ✅ Production-tested (Meta, NVIDIA, etc.)

**Cons:**
- ⚠️ Need to extend for MCP (3-5 days work)
- ⚠️ Less feature-rich than full platforms

**Total effort:** 7-10 days
- 2 days: baseline setup
- 3-5 days: MCP integration
- 2-3 days: A/B testing

**Cost per run:** $180-1,575 for SWE-bench Lite (300 tasks)

### 7.2 Alternative: Claude Agent SDK

**Use Claude Agent SDK with built-in MCP support**

**Pros:**
- ✅ MCP support built-in
- ✅ Official Anthropic SDK
- ✅ Clean abstractions

**Cons:**
- ⚠️ More complex than mini-SWE-agent
- ⚠️ SDK dependency
- ⚠️ Less control over agent loop
- ⚠️ No pre-validated SWE-bench performance

**When to use:**
- If you want official SDK patterns
- If MCP integration speed is priority
- If you're okay with less control

### 7.3 Production Scale: OpenHands

**Use OpenHands evaluation harness**

**Pros:**
- ✅ Production-ready platform
- ✅ Built-in evaluation harness
- ✅ Supports 15+ benchmarks
- ✅ MCP integration built-in

**Cons:**
- ⚠️ Much more complex
- ⚠️ Lower baseline performance (21% vs 74%)
- ⚠️ Harder to isolate variables

**When to use:**
- Production deployment
- Need to run multiple benchmarks
- Not ideal for research baseline

---

## 8. Success Criteria

### Must Have
- ✅ Reproducible runs on same tasks
- ✅ Only variable is MCP availability
- ✅ Clean A/B comparison
- ✅ Statistical significance (50+ tasks)

### Should Have
- ✅ Cost per task < $1 on average
- ✅ Results within 1 week
- ✅ Can run both variants in parallel

### Nice to Have
- Detailed token usage breakdown
- Turn-by-turn analysis
- Query pattern analysis

---

## 9. Next Steps

1. **Validate approach with stakeholders**
   - Confirm mini-SWE-agent is acceptable baseline
   - Confirm SWE-bench Lite (300 tasks) is sufficient initial dataset
   - Confirm budget ($200-1,600 per experiment)

2. **Set up infrastructure**
   - Install mini-SWE-agent
   - Configure Claude API access
   - Test on 1-2 tasks

3. **Run baseline**
   - Full SWE-bench Lite run (bash-only)
   - Establish baseline metrics

4. **Implement MCP integration**
   - Extend mini-SWE-agent with Grafema MCP
   - Test on same 1-2 tasks
   - Verify MCP tools are being called

5. **Run A/B test**
   - Same 50-300 tasks
   - Compare solve rates, tokens, time
   - Statistical analysis

6. **Iterate**
   - Identify gaps
   - Improve MCP tools
   - Re-run experiments

---

## 10. Key Resources

### Documentation
- [mini-SWE-agent docs](https://mini-swe-agent.com/latest/)
- [Claude Agent SDK docs](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [SWE-bench official site](https://www.swebench.com/)

### Code Repositories
- [SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)
- [anthropics/claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python)
- [anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript)
- [SWE-bench/SWE-bench](https://github.com/SWE-bench/SWE-bench)

### Research Papers
- [SWE-bench paper (ICLR 2024)](https://arxiv.org/pdf/2310.06770)
- [SWE-agent paper (NeurIPS 2024)](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf)
- [OpenHands paper](https://arxiv.org/abs/2407.16741)

### Blog Posts
- [Anthropic: Claude SWE-Bench Performance](https://www.anthropic.com/research/swe-bench-sonnet)
- [Building agents with Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)

---

## Conclusion

**The simplest path is mini-SWE-agent + Grafema MCP.**

This provides:
- Minimal complexity (100 lines of agent logic)
- Clean control case (bash-only baseline)
- Easy MCP integration (extend tool set)
- Validated performance (74%+ on SWE-bench Verified)
- Clear A/B test (only variable is MCP availability)

Total effort: 7-10 days
Budget: $200-1,600 per full evaluation run
Expected outcome: Quantitative comparison of solve rates with/without graph querying

The key insight from this research is that mini-SWE-agent's bash-only design makes it the perfect control. By adding Grafema MCP as an optional tool layer, we can isolate the impact of graph-based code analysis on SWE-bench performance.
