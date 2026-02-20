const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  console.log('=== SETUP ===');
  await page.goto('http://localhost:8080');
  await page.waitForSelector('.monaco-workbench', { timeout: 30000 });
  await page.waitForTimeout(5000);

  // ========== TRUST DIALOG — ROBUST DISMISS ==========
  for (let attempt = 0; attempt < 5; attempt++) {
    const hasDialog = await page.$('.monaco-dialog-modal-block');
    if (!hasDialog) {
      console.log('Trust dialog gone after attempt ' + attempt);
      break;
    }
    console.log('Trust dialog present, attempt ' + (attempt + 1) + '...');

    await page.evaluate(() => {
      const box = document.querySelector('.monaco-dialog-box');
      if (!box) return;
      const els = box.querySelectorAll('a, button, .monaco-button');
      for (const el of els) {
        if (el.textContent.includes('Yes') && el.textContent.includes('trust')) {
          el.click(); break;
        }
      }
    });
    await page.waitForTimeout(2000);
  }

  // Verify trust dismissed
  const dialogStill = await page.$('.monaco-dialog-modal-block');
  if (dialogStill) {
    console.log('WARNING: Trust dialog STILL present, trying keyboard Enter...');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
  }

  const finalDialog = await page.$('.monaco-dialog-modal-block');
  console.log('Trust dialog resolved: ' + !finalDialog);

  // Close Welcome
  await page.keyboard.press('Meta+w');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Open file
  console.log('\nOpening Orchestrator.ts...');
  await page.keyboard.press('Meta+p');
  await page.waitForTimeout(800);
  await page.keyboard.type('Orchestrator.ts', { delay: 30 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);
  console.log('File opened');

  // Switch to Grafema sidebar (use evaluate to bypass potential overlays)
  console.log('\nActivating Grafema sidebar...');
  await page.evaluate(() => {
    const link = document.querySelector('a[class*="view-extension-grafema"]');
    if (link) link.click();
  });
  await page.waitForTimeout(2000);

  // Expand all panels (via evaluate)
  await page.evaluate(() => {
    const panes = document.querySelectorAll('.pane-header');
    for (const pane of panes) {
      if (pane.getAttribute('aria-expanded') === 'false') {
        pane.click();
      }
    }
  });
  await page.waitForTimeout(1000);

  // Helper: read Debug Log text
  async function readDebugLog() {
    return page.evaluate(() => {
      const panes = document.querySelectorAll('.pane-header');
      for (const p of panes) {
        if ((p.getAttribute('aria-label') || '').includes('Debug Log')) {
          const body = p.closest('.pane')?.querySelector('.pane-body');
          return body ? body.textContent.substring(0, 500).trim() : '';
        }
      }
      return '';
    });
  }

  // Helper: read all panel texts
  async function readPanels() {
    return page.evaluate(() => {
      const result = {};
      const panes = document.querySelectorAll('.pane-header');
      for (const p of panes) {
        const aria = p.getAttribute('aria-label') || '';
        const body = p.closest('.pane')?.querySelector('.pane-body');
        if (body && body.offsetHeight > 5) {
          result[aria] = body.textContent.substring(0, 300).trim();
        }
      }
      return result;
    });
  }

  // Go to line 32
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(500);
  await page.keyboard.type('32');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  const vl = await page.$('.monaco-editor .view-lines');
  const box = await vl.boundingBox();
  const entityX = box.x + 20 * 7.7;
  const entityY = box.y + 2 * 19 + 9.5;

  // ========== WAIT-FOR-READY LOOP ==========
  console.log('\n=== WAIT-FOR-READY ===');

  const delays = [5, 10, 15, 20, 30];
  let ready = false;

  for (let i = 0; i < delays.length; i++) {
    // Click entity via mouse (should work now that dialog is gone)
    await page.mouse.click(entityX, entityY);
    const waitSec = delays[i];
    console.log('Attempt ' + (i + 1) + ': clicked entity, waiting ' + waitSec + 's...');
    await page.waitForTimeout(waitSec * 1000);

    const debugLog = await readDebugLog();
    const hasDbError = debugLog.includes('No database selected');
    const panels = await readPanels();

    const vtText = panels['Value Trace Section'] || '';
    const vtPlaceholder = vtText.includes('Hover over a variable to trace');
    const callersText = panels['Callers Section'] || '';
    const callersPlaceholder = callersText.includes('Move cursor to a function');
    const statusText = panels['Status Section'] || '';

    console.log('  DB error: ' + hasDbError);
    console.log('  Status: "' + statusText.substring(0, 60) + '"');
    console.log('  Value Trace: ' + (vtPlaceholder ? 'PLACEHOLDER' : '"' + vtText.substring(0, 80) + '"'));
    console.log('  Callers: ' + (callersPlaceholder ? 'PLACEHOLDER' : '"' + callersText.substring(0, 80) + '"'));

    await page.screenshot({ path: '_qa/screenshots/ready-attempt-' + (i + 1) + '.png' });

    if (!hasDbError && !vtPlaceholder) {
      console.log('\n>>> READY after attempt ' + (i + 1) + ' <<<');
      ready = true;
      break;
    }
  }

  if (!ready) {
    console.log('\n>>> NOT READY after ' + delays.reduce((a, b) => a + b, 0) + 's total <<<');
    const finalPanels = await readPanels();
    console.log('\nFinal panel state:');
    for (const [key, val] of Object.entries(finalPanels)) {
      if (!key.includes('Chat')) {
        console.log('  [' + key + '] "' + val.substring(0, 150) + '"');
      }
    }
    const finalDebug = await readDebugLog();
    console.log('\nDebug Log: "' + finalDebug.substring(0, 300) + '"');
  } else {
    console.log('\n=== ENTITY CHECK (ready) ===');
    const panels = await readPanels();
    for (const [key, val] of Object.entries(panels)) {
      if (!key.includes('Chat')) {
        console.log('  [' + key + '] "' + val.substring(0, 200) + '"');
      }
    }

    await page.screenshot({ path: '_qa/screenshots/panels-ready.png' });

    // Hover
    await page.mouse.move(entityX, entityY);
    await page.waitForTimeout(3000);
    const tooltip = await page.$('.monaco-hover-content');
    if (tooltip) {
      const text = await tooltip.textContent();
      console.log('\nTooltip: "' + text.substring(0, 300) + '"');
    } else {
      console.log('\nNo hover tooltip');
    }
    await page.screenshot({ path: '_qa/screenshots/hover-ready.png' });

    // Line 100
    console.log('\n=== Line 100 ===');
    await page.keyboard.press('Control+g');
    await page.waitForTimeout(500);
    await page.keyboard.type('100');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    const box2 = await vl.boundingBox();
    await page.mouse.click(box2.x + 15 * 7.7, box2.y + 3 * 19 + 9.5);
    await page.waitForTimeout(5000);
    const panels2 = await readPanels();
    for (const [key, val] of Object.entries(panels2)) {
      if (!key.includes('Chat')) {
        console.log('  [' + key + '] "' + val.substring(0, 200) + '"');
      }
    }
    await page.screenshot({ path: '_qa/screenshots/line100-ready.png' });
  }

  console.log('\n=== STATUS BAR ===');
  const statusItems = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.statusbar-item'))
      .map(i => i.textContent.trim()).filter(t => t.length > 0);
  });
  for (const s of statusItems) console.log('  "' + s.substring(0, 60) + '"');

  await browser.close();
  console.log('\n=== DONE ===');
})().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
