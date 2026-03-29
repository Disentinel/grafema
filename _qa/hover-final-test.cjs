const { chromium } = require('playwright');

(async () => {
  const sessionDir = `_qa/screenshots/${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}`;
  const fs = require('fs');
  fs.mkdirSync(sessionDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  console.log('1. Loading code-server...');
  await page.goto('http://localhost:8080', { waitUntil: 'networkidle', timeout: 60000 });

  // Wait for trust dialog and click "Yes, I trust the authors"
  console.log('2. Handling trust dialog...');
  for (let attempt = 0; attempt < 15; attempt++) {
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      // Look specifically for "Yes, I trust" button
      const allButtons = document.querySelectorAll('button, a.monaco-button');
      for (const btn of allButtons) {
        const text = btn.textContent || '';
        // MUST contain "Yes" — don't click the "No" button!
        if (text.includes('Yes') && text.includes('trust')) {
          btn.click();
          return 'YES-clicked: ' + text.trim().substring(0, 60);
        }
      }

      // Check for dialog presence
      const modal = document.querySelector('.monaco-dialog-modal-block');
      if (modal) return 'modal-waiting';

      // Check restricted mode
      const sb = document.querySelector('.statusbar');
      if (sb && sb.textContent.includes('Restricted')) return 'restricted';

      return 'no-dialog';
    });

    console.log(`   Attempt ${attempt + 1}: ${result}`);

    if (result.startsWith('YES-clicked')) {
      await page.waitForTimeout(3000);
      break;
    }
    if (result === 'no-dialog' && attempt >= 5) break;
  }

  // Verify not in restricted mode
  const restricted = await page.evaluate(() => {
    const sb = document.querySelector('.statusbar');
    return sb ? sb.textContent.includes('Restricted') : false;
  });
  console.log('   Restricted mode: ' + restricted);

  if (restricted) {
    // Grant trust via command palette
    console.log('   Granting trust via command palette...');
    await page.keyboard.press('Meta+Shift+p');
    await page.waitForTimeout(800);
    await page.keyboard.type('Workspaces: Manage Workspace Trust', { delay: 20 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);

    // Find and click the Trust button on the trust management page
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent || '';
        if (text.includes('Trust') && !text.includes('Don')) {
          btn.click();
          return;
        }
      }
    });
    await page.waitForTimeout(3000);

    // Close the trust management tab
    await page.keyboard.press('Meta+w');
    await page.waitForTimeout(500);
  }

  await page.screenshot({ path: `${sessionDir}/00-ready.png` });

  // Close all tabs
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Meta+w');
    await page.waitForTimeout(200);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Open Orchestrator.ts
  console.log('3. Opening Orchestrator.ts...');
  await page.keyboard.press('Meta+p');
  await page.waitForTimeout(1200);
  await page.keyboard.type('Orchestrator.ts', { delay: 40 });
  await page.waitForTimeout(2000);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);

  // Verify file opened
  const fileInfo = await page.evaluate(() => {
    const items = document.querySelectorAll('.statusbar-item');
    const statusText = Array.from(items).map(el => el.textContent.trim()).filter(Boolean).join(' | ');
    const tabs = Array.from(document.querySelectorAll('.tab')).map(t => t.textContent.trim()).filter(Boolean);
    return { statusText: statusText.substring(0, 200), tabs, hasLn: statusText.includes('Ln') };
  });
  console.log('   Status: ' + fileInfo.statusText);
  console.log('   Tabs: ' + fileInfo.tabs.join(', '));

  if (!fileInfo.hasLn) {
    console.log('ERROR: File not opened');
    await page.screenshot({ path: `${sessionDir}/error.png` });
    await browser.close();
    return;
  }

  await page.screenshot({ path: `${sessionDir}/01-file.png` });

  // Activate Grafema sidebar
  console.log('4. Activating Grafema sidebar...');
  const grafemaLink = await page.$('a[class*="view-extension-grafema"]');
  if (grafemaLink) {
    await grafemaLink.click({ timeout: 5000 }).catch(() => console.log('   Click failed'));
    await page.waitForTimeout(2000);
  }

  // Expand all panels
  const panes = await page.$$('.pane-header');
  for (const p of panes) {
    const expanded = await p.getAttribute('aria-expanded');
    if (expanded === 'false') {
      await p.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  // Focus editor
  console.log('5. Focusing editor...');
  await page.keyboard.press('Meta+1');
  await page.waitForTimeout(500);

  // Go to line 83
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(600);
  await page.keyboard.type('83');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);

  // Move cursor with arrow keys
  console.log('6. Cursor movement...');
  await page.keyboard.press('Home');
  await page.waitForTimeout(200);
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(30);
  }
  // Wait for debounce + graph query
  await page.waitForTimeout(10000);

  await page.screenshot({ path: `${sessionDir}/02-cursor.png` });

  // Read Debug Log
  let debugText = await page.evaluate(() => {
    const headers = document.querySelectorAll('.pane-header');
    for (const h of headers) {
      if ((h.getAttribute('aria-label') || '').includes('Debug Log')) {
        const body = h.closest('.pane')?.querySelector('.pane-body');
        return body ? body.textContent.substring(0, 1000) : 'no body';
      }
    }
    return 'panel not found';
  });
  console.log('   Debug Log: ' + debugText.substring(0, 250));

  // Check Explorer panel
  let explorerText = await page.evaluate(() => {
    const headers = document.querySelectorAll('.pane-header');
    for (const h of headers) {
      if ((h.getAttribute('aria-label') || '').includes('Explorer Section')) {
        const body = h.closest('.pane')?.querySelector('.pane-body');
        return body ? body.textContent.substring(0, 300) : 'no body';
      }
    }
    return 'panel not found';
  });
  console.log('   Explorer: ' + explorerText.substring(0, 100));

  // Test hover
  console.log('7. Hover test on line 83...');
  let viewLines = await page.$('.monaco-editor .view-lines');
  if (viewLines) {
    let box = await viewLines.boundingBox();
    if (box) {
      // Hover over "graph" area
      await page.mouse.move(box.x + 16 * 7.7, box.y + 2 * 19 + 9.5);
      await page.waitForTimeout(5000);

      let tooltip = await page.evaluate(() => {
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
        console.log('   No tooltip on line 83');
      }
      await page.screenshot({ path: `${sessionDir}/03-hover-83.png` });

      // Try another line: 161 (run method)
      console.log('8. Hover test on line 161...');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+g');
      await page.waitForTimeout(600);
      await page.keyboard.type('161');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);

      // Move to "run"
      await page.keyboard.press('Home');
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(5000);

      viewLines = await page.$('.monaco-editor .view-lines');
      box = await viewLines.boundingBox();

      await page.mouse.move(box.x + 14 * 7.7, box.y + 2 * 19 + 9.5);
      await page.waitForTimeout(5000);

      tooltip = await page.evaluate(() => {
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
        console.log('   No tooltip on line 161');
      }
      await page.screenshot({ path: `${sessionDir}/04-hover-161.png` });
    }
  }

  // Final panel state
  console.log('9. Final panel state:');
  const panelState = await page.evaluate(() => {
    const result = {};
    const names = {
      'status': 'Status Section',
      'value-trace': 'Value Trace Section',
      'callers': 'Callers Section',
      'explorer': 'Explorer Section',
      'debug-log': 'Debug Log Section',
    };
    for (const [key, ariaLabel] of Object.entries(names)) {
      const h = document.querySelector(`[aria-label="${ariaLabel}"]`);
      if (!h) { result[key] = 'NOT FOUND'; continue; }
      const body = h.closest('.pane')?.querySelector('.pane-body');
      result[key] = body && body.offsetHeight > 5 ? body.textContent.substring(0, 150).trim() : 'collapsed';
    }
    return result;
  });
  for (const [k, v] of Object.entries(panelState)) {
    console.log(`  [${k}] ${v.substring(0, 100)}`);
  }

  console.log('\nDone. Screenshots: ' + sessionDir);
  await browser.close();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
