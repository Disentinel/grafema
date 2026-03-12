---
id: kb:fact:property-write-aliasing-requires-receiver-chain-matching
type: FACT
confidence: high
projections:
  - epistemic
relates_to:
  - packages/js-analyzer/src/Rules/Expressions.hs
created: 2026-03-12
---

## Property Write Aliasing Requires Receiver Chain Matching

When JavaScript code writes to a property (`obj.prop = value`) and reads it elsewhere (`x = obj.prop`), the graph creates two distinct PROPERTY_ACCESS nodes with the same name but different hashes. These nodes have no direct edge connecting them.

**To connect read and write sides in backward tracing:**
1. Resolve the receiver chain of the read-side PA: follow READS_FROM through intermediate PAs and REFERENCEs to the base CONSTANT/VARIABLE
2. Find other PA nodes with the same property name that have WRITES_TO edges (write-side PAs)
3. Resolve their receiver chains to the same base CONSTANT/VARIABLE
4. If base and intermediate path match, follow the WRITES_TO edges

**Example (CJS pattern):**
- Write: `mod_cjs.exports.value = SEED` → PA "value" [h:3487] → READS_FROM → PA "exports" [h:929f] → REF → CONSTANT "mod_cjs"
- Read: `v_cjs = mod_cjs.exports.value` → PA "value" [h:3314] → READS_FROM → PA "exports" [h:020c] → REF → CONSTANT "mod_cjs"
- Same base ("mod_cjs") + same path ("exports") + same property name ("value") → follow WRITES_TO → REF "SEED"

**This is a trace algorithm concern, not an analyzer edge gap.** The analyzer correctly models the two distinct access sites. The trace algorithm must perform the join.
