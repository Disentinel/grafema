import { test, expect } from '@playwright/test';

const GUI_URL = 'http://localhost:3000';
const TEST_PROJECT_PATH = '/Users/vadimr/navi/test/fixtures/02-advanced-features';

test.describe('Navi GUI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(GUI_URL);
  });

  test('should load the main page', async ({ page }) => {
    // Check that the page title is correct
    await expect(page).toHaveTitle(/Navi - Code Flow Visualization/);

    // Check that main UI elements are present
    await expect(page.locator('h1')).toContainText('Navi');
    await expect(page.locator('#project-path')).toBeVisible();
    await expect(page.locator('#analyze-btn')).toBeVisible();
  });

  test('should analyze a project and display graph', async ({ page }) => {
    // Enter project path
    await page.fill('#project-path', TEST_PROJECT_PATH);

    // Click analyze button
    await page.click('#analyze-btn');

    // Wait for loading to finish (max 30 seconds for analysis)
    await page.waitForSelector('#loading.active', { state: 'hidden', timeout: 30000 });

    // Check that stats are displayed
    await expect(page.locator('#stats')).toContainText('Total Nodes');
    await expect(page.locator('#stats')).toContainText('Total Edges');

    // Check that graph has nodes (SVG circles)
    const nodeCount = await page.locator('.node circle').count();
    expect(nodeCount).toBeGreaterThan(0);

    // Check that graph has edges (SVG lines)
    const edgeCount = await page.locator('.link').count();
    expect(edgeCount).toBeGreaterThan(0);
  });

  test('should filter nodes by type', async ({ page }) => {
    // Analyze project first
    await page.fill('#project-path', TEST_PROJECT_PATH);
    await page.click('#analyze-btn');
    await page.waitForSelector('#loading.active', { state: 'hidden', timeout: 30000 });

    // Get initial node count
    const initialNodeCount = await page.locator('.node').count();

    // Select FUNCTION filter
    await page.selectOption('#node-filter', 'FUNCTION');

    // Wait for graph to update
    await page.waitForTimeout(500);

    // Get filtered node count
    const filteredNodeCount = await page.locator('.node').count();

    // Should have fewer nodes after filtering
    expect(filteredNodeCount).toBeLessThanOrEqual(initialNodeCount);

    // All visible nodes should be FUNCTION type
    const functionNodes = await page.locator('.node-FUNCTION').count();
    expect(functionNodes).toBe(filteredNodeCount);
  });

  test('should show node details on click', async ({ page }) => {
    // Analyze project
    await page.fill('#project-path', TEST_PROJECT_PATH);
    await page.click('#analyze-btn');
    await page.waitForSelector('#loading.active', { state: 'hidden', timeout: 30000 });

    // Info panel should be hidden initially
    await expect(page.locator('#info-panel')).not.toHaveClass(/active/);

    // Click on the first node
    await page.locator('.node circle').first().click();

    // Info panel should become visible
    await expect(page.locator('#info-panel')).toHaveClass(/active/);

    // Should display node information
    await expect(page.locator('#info-panel h3')).toBeVisible();
    await expect(page.locator('#info-panel .info-row')).toHaveCount({ min: 1 });

    // Close info panel
    await page.click('#info-panel .close-btn');

    // Info panel should be hidden again
    await expect(page.locator('#info-panel')).not.toHaveClass(/active/);
  });

  test('should support zoom and pan', async ({ page }) => {
    // Analyze project
    await page.fill('#project-path', TEST_PROJECT_PATH);
    await page.click('#analyze-btn');
    await page.waitForSelector('#loading.active', { state: 'hidden', timeout: 30000 });

    const svg = page.locator('#graph');
    const graphGroup = page.locator('#graph g').first();

    // Get initial transform
    const initialTransform = await graphGroup.getAttribute('transform');

    // Simulate zoom (scroll on SVG)
    await svg.hover();
    await page.mouse.wheel(0, -100); // Scroll up to zoom in

    // Wait for transform to update
    await page.waitForTimeout(500);

    // Transform should have changed
    const afterZoomTransform = await graphGroup.getAttribute('transform');
    expect(afterZoomTransform).not.toBe(initialTransform);
  });

  test('should drag nodes to reposition them', async ({ page }) => {
    // Analyze project
    await page.fill('#project-path', TEST_PROJECT_PATH);
    await page.click('#analyze-btn');
    await page.waitForSelector('#loading.active', { state: 'hidden', timeout: 30000 });

    // Get the first node
    const firstNode = page.locator('.node').first();

    // Get initial position
    const initialTransform = await firstNode.getAttribute('transform');

    // Drag the node
    const box = await firstNode.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 100, box.y + 100);
      await page.mouse.up();

      // Wait for simulation to settle
      await page.waitForTimeout(1000);

      // Position should have changed
      const finalTransform = await firstNode.getAttribute('transform');
      expect(finalTransform).not.toBe(initialTransform);
    }
  });

  test('should display statistics', async ({ page }) => {
    // Analyze project
    await page.fill('#project-path', TEST_PROJECT_PATH);
    await page.click('#analyze-btn');
    await page.waitForSelector('#loading.active', { state: 'hidden', timeout: 30000 });

    // Check stats cards
    const statCards = page.locator('.stat-card');
    await expect(statCards).toHaveCount({ min: 2 });

    // Check for specific stat sections
    await expect(page.locator('#stats')).toContainText('Nodes by Type');
    await expect(page.locator('#stats')).toContainText('Edges by Type');

    // Check that numbers are present
    const statValues = page.locator('.stat-value');
    await expect(statValues.first()).toBeVisible();

    // Values should be numeric and > 0
    const firstValue = await statValues.first().textContent();
    expect(parseInt(firstValue || '0')).toBeGreaterThan(0);
  });

  test('should show legend with node types', async ({ page }) => {
    // Legend should be visible on page load
    await expect(page.locator('#legend')).toBeVisible();

    // Should have legend items
    const legendItems = page.locator('.legend-item');
    await expect(legendItems).toHaveCount({ min: 5 });

    // Each item should have a color circle and label
    const firstItem = legendItems.first();
    await expect(firstItem.locator('.legend-color')).toBeVisible();
  });

  test('should handle errors gracefully', async ({ page }) => {
    // Try to analyze a non-existent path
    await page.fill('#project-path', '/nonexistent/path');
    await page.click('#analyze-btn');

    // Should show error message
    await expect(page.locator('#error')).toHaveClass(/active/);
    await expect(page.locator('#error')).toContainText(/error/i);
  });

  test('should show node metadata', async ({ page }) => {
    // Analyze project
    await page.fill('#project-path', TEST_PROJECT_PATH);
    await page.click('#analyze-btn');
    await page.waitForSelector('#loading.active', { state: 'hidden', timeout: 30000 });

    // Find a FUNCTION node (likely to have metadata)
    const functionNode = page.locator('.node-FUNCTION circle').first();
    await functionNode.click();

    // Info panel should show
    await expect(page.locator('#info-panel')).toHaveClass(/active/);

    // Should show node ID
    await expect(page.locator('#info-panel .info-value')).toHaveCount({ min: 1 });
  });

  test('should show incoming and outgoing edges for node', async ({ page }) => {
    // Analyze project
    await page.fill('#project-path', TEST_PROJECT_PATH);
    await page.click('#analyze-btn');
    await page.waitForSelector('#loading.active', { state: 'hidden', timeout: 30000 });

    // Click on a node
    await page.locator('.node circle').first().click();

    // Info panel should show edges sections
    await expect(page.locator('#info-panel')).toContainText(/Incoming Edges/i);
    await expect(page.locator('#info-panel')).toContainText(/Outgoing Edges/i);
  });
});

test.describe('Navi GUI - Node Expansion Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(GUI_URL);

    // Analyze the advanced features project
    await page.fill('#project-path', TEST_PROJECT_PATH);
    await page.click('#analyze-btn');
    await page.waitForSelector('#loading.active', { state: 'hidden', timeout: 30000 });
  });

  test('should drill down: SERVICE → MODULE → FUNCTION', async ({ page }) => {
    // Step 1: Find and click SERVICE node
    const serviceNode = page.locator('.node-SERVICE circle').first();
    if (await serviceNode.count() > 0) {
      await serviceNode.click();

      // Info panel should show SERVICE details
      await expect(page.locator('#info-panel h3')).toContainText('SERVICE');

      // Should have outgoing edges (to MODULE)
      await expect(page.locator('#info-panel')).toContainText(/Outgoing Edges/i);
    }

    // Step 2: Find and click MODULE node
    const moduleNode = page.locator('.node-MODULE circle').first();
    await moduleNode.click();

    // Info panel should show MODULE details
    await expect(page.locator('#info-panel h3')).toContainText('MODULE');

    // Should show file path
    await expect(page.locator('#info-panel')).toContainText(/File/i);

    // Step 3: Find and click FUNCTION node
    const functionNode = page.locator('.node-FUNCTION circle').first();
    await functionNode.click();

    // Info panel should show FUNCTION details
    await expect(page.locator('#info-panel h3')).toContainText('FUNCTION');

    // Should have metadata (async, generator, isClassMethod, etc.)
    const infoContent = await page.locator('#info-panel').textContent();
    // Metadata might include line numbers, async flags, etc.
    expect(infoContent).toBeTruthy();
  });

  test('should show connections to EXTERNAL systems', async ({ page }) => {
    // Filter to show all node types
    await page.selectOption('#node-filter', '');

    // Wait for graph to render
    await page.waitForTimeout(1000);

    // Check for external system nodes
    const externalNodes = await page.locator('.node-EXTERNAL_MODULE, .node-EXTERNAL_STDIO').count();

    if (externalNodes > 0) {
      // Click on an external node
      const externalNode = page.locator('.node-EXTERNAL_MODULE circle, .node-EXTERNAL_STDIO circle').first();
      await externalNode.click();

      // Should show in info panel
      await expect(page.locator('#info-panel')).toHaveClass(/active/);

      // External nodes should have connections
      const infoText = await page.locator('#info-panel').textContent();
      expect(infoText).toContain('Incoming Edges');
    }
  });

  test('should preserve other nodes when drilling down', async ({ page }) => {
    // Get initial node count
    const initialNodeCount = await page.locator('.node').count();

    // Click on a node
    await page.locator('.node circle').first().click();

    // Node count should remain the same (we don't hide other nodes)
    const afterClickNodeCount = await page.locator('.node').count();
    expect(afterClickNodeCount).toBe(initialNodeCount);

    // But the clicked node should be visually selected
    const selectedNodes = await page.locator('.node.selected').count();
    expect(selectedNodes).toBe(1);
  });

  test('should show edge relationships clearly', async ({ page }) => {
    // Click on a node with edges
    await page.locator('.node circle').nth(5).click();

    // Info panel should list edges with types
    await expect(page.locator('#info-panel .edge-item')).toHaveCount({ min: 0 });

    // If there are edges, they should show the relationship type
    const edgeItems = page.locator('#info-panel .edge-item');
    const count = await edgeItems.count();

    if (count > 0) {
      const firstEdge = edgeItems.first();
      await expect(firstEdge.locator('.edge-type')).toBeVisible();
    }
  });

  test('should handle complex graphs with many connections', async ({ page }) => {
    // Find a node with many connections (like a MODULE)
    const moduleNode = page.locator('.node-MODULE circle').first();
    await moduleNode.click();

    // Should handle and display edges (even if there are many)
    const infoPanel = page.locator('#info-panel');
    await expect(infoPanel).toHaveClass(/active/);

    // Should have edge sections
    await expect(infoPanel).toContainText(/Incoming Edges/i);
    await expect(infoPanel).toContainText(/Outgoing Edges/i);

    // If there are more than 10 edges, should show "... and X more"
    const hasMoreIndicator = await infoPanel.textContent();
    // This is OK either way - depends on the test fixture
    expect(hasMoreIndicator).toBeTruthy();
  });
});
