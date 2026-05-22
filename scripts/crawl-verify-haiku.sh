#!/bin/bash
# Verification agent using Claude Haiku via claude CLI (subscription, no API key needed)
# Usage: ./scripts/crawl-verify-haiku.sh "hypothesis text"
# Output: JSON { verdict, evidence, confidence, notes }

HYPOTHESIS="$1"
if [ -z "$HYPOTHESIS" ]; then
  echo '{"verdict":"unclear","evidence":"No hypothesis provided","confidence":0}'
  exit 1
fi

PROJECT="/Users/vadimr/grafema"

RESULT=$(claude -p "You are verifying a hypothesis about the Grafema codebase.

Hypothesis: \"${HYPOTHESIS}\"

Steps:
1. grep -rn in ${PROJECT}/packages/ to find relevant source files
2. Read specific lines for evidence
3. Output your verdict as a SINGLE LINE of JSON (no code fences):
{\"verdict\":\"confirmed\",\"evidence\":\"file:line refs\",\"confidence\":0.95,\"notes\":\"explanation\"}

verdict must be: confirmed, refuted, or unclear.
Output ONLY the JSON line at the end, no markdown." \
  --model haiku \
  --allowedTools "Bash(grep *),Bash(find *),Read" \
  --max-turns 6 \
  2>/dev/null)

# Extract JSON from output (may have markdown around it)
echo "$RESULT" | grep -o '{[^}]*"verdict"[^}]*}' | tail -1 || echo '{"verdict":"unclear","evidence":"Could not parse output","confidence":0}'
