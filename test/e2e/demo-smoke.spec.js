import { test, expect } from '@playwright/test';

const CODE_SERVER_URL = process.env.DEMO_URL || 'http://localhost:8080';

// code-server can be slow to start; give it a generous timeout for initial load
const PAGE_LOAD_TIMEOUT = 60_000;

// Record video of every test run for debugging and demo purposes.
// Videos are saved to test-results/ directory.
test.use({
  video: 'on',
  viewport: { width: 1280, height: 720 },
});

test.describe('Grafema Demo Environment', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to code-server and wait for the Monaco workbench to render.
    // The first load after container start can take 10-30 seconds.
    await page.goto(CODE_SERVER_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.monaco-workbench')).toBeVisible({ timeout: PAGE_LOAD_TIMEOUT });

    // Dismiss the "Do you trust the authors?" dialog if it appears
    const trustButton = page.getByRole('button', { name: 'Yes, I trust the authors' });
    if (await trustButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await trustButton.click();
    }
  });

  test('code-server loads', async ({ page }) => {
    // Verify core VS Code UI chrome is present
    await expect(page.locator('.activitybar')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.statusbar')).toBeVisible({ timeout: 10_000 });
  });

  test('Grafema extension is installed', async ({ page }) => {
    // Click the Extensions tab in the activity bar
    const extensionsTab = page.getByRole('tab', { name: /Extensions/ });
    await extensionsTab.click();

    // Wait for the extensions view to appear — look for installed extension directly
    // The extension was pre-installed, so it should appear in the installed list
    await expect(page.getByText('Grafema Explore')).toBeVisible({ timeout: 15_000 });
  });

  test('Demo project is open', async ({ page }) => {
    // The workspace should have the demo project files visible in the Explorer.
    // Explorer is typically open by default; if not, click the file icon.
    const explorerView = page.locator('.explorer-folders-view');

    // If explorer is not visible, open it via the activity bar
    if (!(await explorerView.isVisible())) {
      const explorerTab = page.locator('.activitybar [aria-label="Explorer"]');
      const explorerTabAlt = page.locator('.activitybar [id*="explorer"]');

      if (await explorerTab.count() > 0) {
        await explorerTab.click();
      } else if (await explorerTabAlt.count() > 0) {
        await explorerTabAlt.click();
      }
    }

    // Verify the workspace folder appears in the sidebar.
    // The workspace is opened at /home/coder/workspace/grafema (Grafema self-analysis).
    await expect(explorerView).toBeVisible({ timeout: 10_000 });

    // Check that the tree has at least one file/folder entry
    const treeItems = page.locator('.explorer-folders-view .monaco-list-row');
    await expect(treeItems.first()).toBeVisible({ timeout: 10_000 });
  });
});
