# Steve Jobs Review — REG-384

**Verdict: APPROVE**

## What’s right
- Improves the **core product experience**: fewer incorrect links between frontend requests and backend routes.
- Uses **existing analyzers + enrichment**, no new architecture or “scan everything” hacks.
- Clear separation between **explicit**, **default**, and **unknown** methods. This directly targets the false-positive risk.

## Non‑negotiables while implementing
- Do **not** add any new global graph scans beyond what already exists in FetchAnalyzer/HTTPConnectionEnricher.
- Treat **unknown** methods as non‑match. No “best‑guess” behavior.
- Regex escaping must preserve param matching; don’t break current template‑literal matching.

## Risks to watch
- Reduced recall when method is dynamic. That’s acceptable if it avoids bad links.
- Ensure request naming with `UNKNOWN` doesn’t leak into UX in a confusing way (keep it intentional and obvious).

Proceed to implementation after Vadim confirmation.
