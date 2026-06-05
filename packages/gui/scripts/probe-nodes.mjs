import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto('http://localhost:51833/ui/default', { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForTimeout(8_000);
const result = await page.evaluate(() => {
  const w = window;
  const ds = w.__dataStore?.getState?.() || w.useDataStore?.getState?.();
  const ls = w.__layoutStore?.getState?.() || w.useLayoutStore?.getState?.();
  const out = {
    dataStoreNodes: ds?.nodes?.length ?? null,
    dataStoreEdges: ds?.edges?.length ?? null,
    dataStoreRegions: ds?.regions?.length ?? null,
    layoutStoreRegionTreeSize: ls?.regionTree?.byId?.size ?? null,
    layoutStoreHullCacheSize: ls?.hullCache?.size ?? null,
    layoutStoreUnplaced: ls?.unplacedCount ?? null,
  };
  // Try to find HexLayer count via tile mesh
  const canvases = document.querySelectorAll('canvas');
  out.canvasCount = canvases.length;
  return out;
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
