const { chromium } = require('playwright');

(async () => {
  const sessionDir = `_qa/screenshots/${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}`;
  const fs = require('fs');
  fs.mkdirSync(sessionDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  console.log('1. Loading code-server...');
  await page.goto('http://localhost:8080', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(8000);

  // Robust trust dialog dismissal with retries
  console.log('2. Dismissing trust dialog...');
  for (let attempt = 0; attempt < 5; attempt++) {
    const dismissed = await page.evaluate(() => {
      // Try multiple selectors for the trust dialog
      const box = document.querySelector('.monaco-dialog-box');
      if (!box) return 'no-dialog';

      // Find the trust button
      const allElements = box.querySelectorAll('a, button, .monaco-button, .dialog-button');
      for (const el of allElements) {
        const text = (el.textContent || '').toLowerCase();
        if ((text.includes('yes') && text.includes('trust')) ||
            text.includes('trust the authors') ||
            text.includes('i trust')) {
          el.click();
          return 'clicked: ' + el.textContent.trim().substring(0, 50);
        }
      }

      // Fallback: click any positive action button
      for (const el of allElements) {
        const text = (el.textContent || '').toLowerCase();
        if (text.includes('yes') || text.includes('ok') || text.includes('allow')) {
          el.click();
          return 'fallback-clicked: ' + el.textContent.trim().substring(0, 50);
        }
      }

      return 'dialog-found-but-no-button: ' + box.textContent.substring(0, 100);
    });
    console.log(`   Attempt ${attempt + 1}: ${dismissed}`);

    if (dismissed === 'no-dialog') break;
    if (dismissed.startsWith('clicked') || dismissed.startsWith('fallback')) {
      await page.waitForTimeout(2000);
      break;
    }
    await page.waitForTimeout(2000);
  }

  // Verify modal block is gone
  const hasModal = await page.evaluate(() => {
    const modal = document.querySelector('.monaco-dialog-modal-block');
    return modal ? 'yes: ' + modal.className : 'no';
  });
  console.log('   Modal block present: ' + hasModal);

  if (hasModal.startsWith('yes')) {
    console.log('   Forcing modal removal...');
    await page.evaluate(() => {
      const modal = document.querySelector('.monaco-dialog-modal-block');
      if (modal) modal.remove();
      const dialog = document.querySelector('.monaco-dialog-box');
      if (dialog) dialog.closest('.dialog-container')?.remove();
    });
    await page.waitForTimeout(1000);
  }

  await page.screenshot({ path: `${sessionDir}/00-after-trust.png` });

  // Close Welcome/Getting Started tabs
  console.log('3. Closing Welcome tabs...');
  await page.keyboard.press('Meta+w');
  await page.waitForTimeout(300);
  await page.keyboard.press('Meta+w');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Open file
  console.log('4. Opening Orchestrator.ts...');
  await page.keyboard.press('Meta+p');
  await page.waitForTimeout(1000);
  await page.keyboard.type('Orchestrator.ts', { delay: 40 });
  await page.waitForTimeout(2000);

  await page.screenshot({ path: `${sessionDir}/01-quick-open.png` });

  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);

  // Verify file opened
  const fileOpened = await page.evaluate(() => {
    const tabs = document.querySelectorAll('.tab .label-name');
    for (const tab of tabs) {
      if (tab.textContent.includes('Orchestrator')) return tab.textContent;
    }
    // Check status bar for file info
    const statusItems = document.querySelectorAll('.statusbar-item');
    for (const item of statusItems) {
      if (item.textContent.includes('Ln') || item.textContent.includes('Col')) {
        return 'status: ' + item.textContent;
      }
    }
    return null;
  });
  console.log('   File: ' + fileOpened);

  const statusBar = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.statusbar-item'))
      .map(el => el.textContent.trim())
      .filter(Boolean)
      .join(' | ');
  });
  console.log('   Status bar: ' + statusBar.substring(0, 200));

  await page.screenshot({ path: `${sessionDir}/02-file-view.png` });

  // Activate Grafema sidebar
  console.log('5. Activating Grafema sidebar...');
  const grafemaLink = await page.$('a[class*="view-extension-grafema"]');
  if (grafemaLink) {
    await grafemaLink.click({ timeout: 5000 }).catch(() => {
      console.log('   Click failed, trying force click...');
    });
    await page.waitForTimeout(2000);
  }

  // Expand Debug Log
  const paneHeaders = await page.$$('.pane-header');
  for (const h of paneHeaders) {
    const label = await h.getAttribute('aria-label');
    const expanded = await h.getAttribute('aria-expanded');
    if (label && label.includes('Debug Log') && expanded === 'false') {
      await h.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  // Focus editor
  console.log('6. Focusing editor...');
  await page.keyboard.press('Meta+1');
  await page.waitForTimeout(1000);

  // Navigate to line 83
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(600);
  await page.keyboard.type('83');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);

  await page.screenshot({ path: `${sessionDir}/03-line-83.png` });

  // Move cursor with arrow keys
  console.log('7. Moving cursor...');
  await page.keyboard.press('Home');
  await page.waitForTimeout(200);
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(30);
  }
  // Wait for debounce (150ms) + network round-trip + render
  await page.waitForTimeout(10000);

  // Read Debug Log
  let debugContent = await page.evaluate(() => {
    const headers = document.querySelectorAll('.pane-header');
    for (const h of headers) {
      if ((h.getAttribute('aria-label') || '').includes('Debug Log')) {
        const body = h.closest('.pane')?.querySelector('.pane-body');
        return body ? body.textContent.substring(0, 1000) : 'no body';
      }
    }
    return 'panel not found';
  });
  console.log('   Debug Log: ' + debugContent.substring(0, 250));

  await page.screenshot({ path: `${sessionDir}/04-after-cursor.png` });

  // Test hover
  console.log('8. Hover test...');
  const viewLines = await page.$('.monaco-editor .view-lines');
  if (viewLines) {
    const box = await viewLines.boundingBox();
    if (box) {
      // Hover on the word at cursor position
      await page.mouse.move(box.x + 16 * 7.7, box.y + 2 * 19 + 9.5);
      await page.waitForTimeout(5000);

      const tooltip = await page.evaluate(() => {
        const hc = document.querySelector('.monaco-hover-content');
        if (!hc) return { found: false };
        return {
          found: true,
          text: hc.textContent.substring(0, 500),
          hasGrafema: hc.textContent.includes('GRAFEMA'),
        };
      });

      if (tooltip.found) {
        console.log(`   TOOLTIP: GRAFEMA=${tooltip.hasGrafema}`);
        console.log(`   Text: ${tooltip.text.substring(0, 200)}`);
      } else {
        console.log('   No tooltip');
      }

      await page.screenshot({ path: `${sessionDir}/05-hover.png` });
    } else {
      console.log('   No bounding box for view-lines');
    }
  } else {
    console.log('   No .monaco-editor .view-lines found');
  }

  // Check all panels
  console.log('9. Panel contents:');
  const panels = await page.evaluate(() => {
    const result = {};
    const names = {
      'status': 'Status Section',
      'value-trace': 'Value Trace Section',
      'callers': 'Callers Section',
      'blast-radius': 'Blast Radius Section',
      'explorer': 'Explorer Section',
      'debug-log': 'Debug Log Section',
    };
    for (const [key, ariaLabel] of Object.entries(names)) {
      const header = document.querySelector(`[aria-label="${ariaLabel}"]`);
      if (!header) { result[key] = 'NOT FOUND'; continue; }
      const body = header.closest('.pane')?.querySelector('.pane-body');
      if (!body || body.offsetHeight < 5) { result[key] = 'collapsed'; continue; }
      result[key] = body.textContent.substring(0, 150).trim();
    }
    return result;
  });
  for (const [k, v] of Object.entries(panels)) {
    console.log(`  [${k}] ${v.substring(0, 100)}`);
  }

  console.log('\nDone. Screenshots: ' + sessionDir);
  await browser.close();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
