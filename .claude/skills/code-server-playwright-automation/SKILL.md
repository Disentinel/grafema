---
name: code-server-playwright-automation
description: |
  Fix Playwright automation failures against code-server (VS Code in browser). Use when:
  (1) trust dialog blocks all clicks — "monaco-dialog-modal-block intercepts pointer events",
  (2) button:has-text() finds wrong buttons behind modal dialog,
  (3) keyboard shortcuts don't work — Meta vs Control inconsistency,
  (4) VS Code extension activity bar icon not found by aria-label,
  (5) panels show placeholder text despite extension being "Connected".
  Covers trust dialog dismissal, keyboard shortcut hybrid mode, extension panel
  selectors, and database connection verification for Grafema extension.
author: Claude Code
version: 2.0.0
date: 2026-03-15
---

# Code-Server Playwright Automation

## Problem

Automating code-server (VS Code Web) with Playwright fails in non-obvious ways:
- Trust dialog uses custom Monaco dialog component that blocks ALL mouse events
- Keyboard shortcuts are a hybrid of Mac and Linux depending on context
- Extension activity bar icons have dynamic class names, not stable aria-labels
- Standard Playwright selectors find elements behind modal overlays

## Context / Trigger Conditions

- Automating code-server at `http://localhost:8080` via Playwright
- Error: `<div class="monaco-dialog-modal-block dimmed"> intercepts pointer events`
- `button:has-text("trust")` finds 0 or wrong elements
- `page.keyboard.press('Control+p')` does nothing (Quick Open doesn't open)
- `page.$('[aria-label="ExtensionName"]')` returns null for activity bar icons
- Extension panels show placeholder text after clicking entities

## Solution

### 1. Trust Dialog: Use page.evaluate(), NOT standard selectors

The trust dialog is a custom `monaco-dialog-box` with a `monaco-dialog-modal-block` backdrop. The backdrop intercepts ALL pointer events, so `page.click()` and `button:has-text()` fail. Standard `page.$$('button')` finds Getting Started page buttons behind the dialog, not dialog buttons.

**Only reliable method — with retry loop and explicit "Yes" check:**
```javascript
// Trust dialog can appear 6-12s after page load — MUST retry
for (let attempt = 0; attempt < 15; attempt++) {
  await page.waitForTimeout(2000);
  const result = await page.evaluate(() => {
    const allButtons = document.querySelectorAll('button, a.monaco-button');
    for (const btn of allButtons) {
      const text = btn.textContent || '';
      // CRITICAL: Must match "Yes" — the "No" button also contains "trust"!
      if (text.includes('Yes') && text.includes('trust')) {
        btn.click();
        return 'YES-clicked';
      }
    }
    const modal = document.querySelector('.monaco-dialog-modal-block');
    if (modal) return 'modal-waiting';
    const sb = document.querySelector('.statusbar');
    if (sb && sb.textContent.includes('Restricted')) return 'restricted';
    return 'no-dialog';
  });
  if (result === 'YES-clicked') { await page.waitForTimeout(3000); break; }
  if (result === 'no-dialog' && attempt >= 5) break;
}
```

**CRITICAL BUG:** Searching for `text.includes('trust')` without `text.includes('Yes')` will match "No, I **don't trust** the authors" FIRST (it appears earlier in DOM). This puts code-server in Restricted Mode where extensions are disabled.

**Why standard selectors fail:**
- Dialog buttons are `<a>` tags with `class="monaco-button"`, role="button" — not `<button>`
- `page.waitForSelector('button:has-text("trust")')` finds Getting Started buttons
- `page.click()` with force:true still fails because backdrop intercepts events
- Only `element.click()` via evaluate bypasses the backdrop

### 2. Keyboard Shortcuts: Hybrid Mac/Linux Mode

Code-server detects the CLIENT browser's OS and adapts shortcuts. When accessed from macOS browser:

| Shortcut | Key | Notes |
|----------|-----|-------|
| Quick Open | `Meta+p` | Works (Mac) |
| Command Palette | `Meta+Shift+p` | Works (Mac) |
| Close Tab | `Meta+w` | Works (Mac) |
| Go to Line | `Control+g` | **Exception — NOT Meta+g** |
| Explorer | `Meta+Shift+e` | Works (Mac) |

**Key insight:** Most shortcuts use `Meta` (Mac), but Go to Line uses `Control+g`. Always try both if one doesn't work.

### 3. Extension Activity Bar: Use Class Selector

Extensions register activity bar icons with dynamically generated classes:
```
action-label activity-workbench-view-extension-{extensionId}-{hash}
```

The `aria-label="ExtensionName"` exists but on a parent `<div>`, not the clickable `<a>`.

**Reliable selector:**
```javascript
const icon = await page.$('a[class*="view-extension-grafema"]');
if (icon) await icon.click();
```

**Unreliable:** `page.$('[aria-label="Grafema"]')` — matches wrong elements (tree headers, etc.)

### 4. Panel Selectors: aria-label on .pane-header

Extension panels use `.pane-header` with `aria-label="{Name} Section"`:
```javascript
const header = await page.$('[aria-label="Value Trace Section"]');
const expanded = await header.getAttribute('aria-expanded');
if (expanded === 'false') await header.click(); // Expand

// Read panel content
const content = await header.evaluate(h => {
  const body = h.closest('.pane')?.querySelector('.pane-body');
  return body ? body.textContent.substring(0, 400).trim() : null;
});
```

### 5. File Extension: Use .cjs in ESM Projects

If the project has `"type": "module"` in package.json, Playwright scripts with `require()` must use `.cjs` extension. Otherwise: `ReferenceError: require is not defined in ES module scope`.

### 6. Verify File Actually Opened

Quick Open (`Meta+p`) can silently fail (e.g., trust dialog still present, Restricted Mode). Always verify:
```javascript
const fileInfo = await page.evaluate(() => {
  const items = document.querySelectorAll('.statusbar-item');
  const statusText = Array.from(items).map(el => el.textContent.trim()).filter(Boolean).join(' | ');
  const tabs = Array.from(document.querySelectorAll('.tab')).map(t => t.textContent.trim()).filter(Boolean);
  return { hasLn: statusText.includes('Ln'), tabs };
});
if (!fileInfo.hasLn) {
  console.log('ERROR: File not opened. Tabs:', fileInfo.tabs);
  // Abort or retry
}
```

### 7. Docker Extension Hot-Reload (Without Image Rebuild)

To test extension changes without rebuilding the Docker image:
```bash
# 1. Build locally
pnpm build

# 2. Copy bundle to container
docker cp packages/vscode/dist/extension.js \
  grafema-demo:/home/coder/.local/share/code-server/extensions/grafema.grafema-explore-0.2.0/dist/extension.js

# 3. Restart code-server (extension host reloads from disk)
docker exec grafema-demo pkill -HUP -f code-server
```

**CRITICAL:** `docker restart` reverts to the original image files! You must re-copy extension.js after every container restart.

### 8. URI Scheme: `vscode-remote` Not `file`

Code-server uses `vscode-remote` URI scheme, not `file`. Extensions that check `document.uri.scheme !== 'file'` will silently skip all code files in code-server.

**Fix pattern:**
```typescript
function isCodeDocument(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || uri.scheme === 'vscode-remote';
}
```
Replace all `scheme === 'file'` / `scheme !== 'file'` checks with `isCodeDocument()`.

### 9. Cursor Tracking: Verify via Debug Log, Not Panels

Playwright mouse clicks and arrow keys may NOT trigger `onDidChangeTextEditorSelection` in code-server's extension host. To verify cursor tracking works:
- Check the **Debug Log** panel for `findNodeAtCursor` entries
- **"No queries yet"** = cursor tracking not firing
- **"found: FUNCTION ..."** = working correctly

If cursor tracking doesn't fire, focus the editor with `Meta+1` before clicking.

### 10. Hover Tooltip: Unreliable in Headless

`page.mouse.move()` does NOT reliably trigger Monaco hover providers in headless Playwright. Hover tooltip testing requires non-headless mode or real browser. All other extension features (panels, CodeLens, cursor tracking) work fine in headless.

## Verification

After applying these patterns:
1. Trust dialog dismissed → no "Restricted Mode" in status bar
2. Quick Open works → file tab appears (verify with status bar check!)
3. Activity bar icon clicks → panels change in sidebar
4. Panels expand → content visible (may show placeholder if no DB connected)
5. Debug Log shows `findNodeAtCursor found:` entries after cursor movement

## Notes

- The trust dialog appears on EVERY new browser launch (headless: true = new profile)
- Trust dialog can appear 6-12s after page load — MUST retry, not just check once
- Clicking wrong trust button ("No") puts code-server in Restricted Mode = extensions disabled
- After dismissing trust, close the Welcome tab with `Meta+w` before opening files
- Panel placeholder text means the feature works but has no data — check Debug Log for errors
- Screenshots taken with `page.screenshot()` can be read by Claude (multimodal)
- Wait at least 8000ms after `page.goto()` for full code-server initialization
- `docker restart` reverts file changes — always re-copy extension.js after restart
