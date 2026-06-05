#!/bin/bash
# Autonomous Ontological Crawl — full Haiku pipeline
# Generates hypotheses AND verifies them using Claude Haiku via subscription
#
# Usage:
#   ./scripts/crawl-loop-haiku.sh "EntityName" "context description"
#
# Output: JSONL to stdout

set -euo pipefail

ENTITY="$1"
CONTEXT="$2"
PROJECT="/Users/vadimr/grafema"

if [ -z "$ENTITY" ] || [ -z "$CONTEXT" ]; then
  echo "Usage: $0 'EntityName' 'context description'" >&2
  exit 1
fi

echo "=== Crawling: $ENTITY ===" >&2

# Step 1: Generate hypotheses
echo "  Generating hypotheses..." >&2
HYPOTHESES=$(claude -p "You are mapping the architecture of Grafema (code→graph tool).

Entity: ${ENTITY}
Context: ${CONTEXT}

Generate exactly 5 hypotheses:
Format: TYPE|HYPOTHESIS
Types: DEP (dependency), FRAGILE (fragility), CONCEPT (CS concept), UNEXPECTED (surprise), PATTERN (convention)
One per line, no numbering, no extra text." \
  --model haiku 2>/dev/null)

echo "  Generated $(echo "$HYPOTHESES" | grep -c '|') hypotheses" >&2

# Step 2: Verify each
echo "$HYPOTHESES" | grep '|' | while IFS='|' read -r TYPE HYPO; do
  TYPE=$(echo "$TYPE" | xargs)
  HYPO=$(echo "$HYPO" | xargs)
  [ -z "$HYPO" ] && continue

  echo "  Verifying [${TYPE}]: ${HYPO:0:60}..." >&2

  VERDICT=$("$PROJECT/scripts/crawl-verify-haiku.sh" "$HYPO" 2>/dev/null || echo '{"verdict":"unclear","evidence":"verification failed","confidence":0}')

  # Merge entity + type + hypothesis + verdict into single JSON
  echo "$VERDICT" | python3 -c "
import sys, json
try:
    v = json.loads(sys.stdin.read().strip())
    v['entity'] = '${ENTITY}'
    v['type'] = '${TYPE}'
    v['hypothesis'] = '''${HYPO}'''
    print(json.dumps(v))
except:
    print(json.dumps({'entity':'${ENTITY}','type':'${TYPE}','hypothesis':'${HYPO}','verdict':'unclear','confidence':0}))
" 2>/dev/null
done

echo "=== Done: $ENTITY ===" >&2
