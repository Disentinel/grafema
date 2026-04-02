/**
 * Lazy binary downloader for Grafema.
 *
 * Downloads Haskell analyzer binaries from GitHub Releases on first use.
 * Binaries are cached in ~/.grafema/bin/ and reused across projects.
 *
 * Asset naming convention: {binary-name}-{platform}
 * Example: grafema-analyzer-darwin-arm64
 */

import { existsSync, mkdirSync, chmodSync, renameSync, unlinkSync, createWriteStream, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { get as httpsGet } from 'https';
import type { IncomingMessage } from 'http';
import { getPlatformDir } from './findRfdbBinary.js';
import { GRAFEMA_VERSION } from '../version.js';

const GITHUB_REPO = 'Disentinel/grafema';

/** All analyzer binaries that can be lazy-downloaded. */
const DOWNLOADABLE_BINARIES = [
  'grafema-orchestrator',
  // JS/TS
  'grafema-analyzer',
  'grafema-resolve',
  // Haskell
  'haskell-analyzer',
  'haskell-resolve',
  // Rust
  'grafema-rust-analyzer',
  'grafema-rust-resolve',
  // Java
  'grafema-java-analyzer',
  'java-resolve',
  'java-parser',
  // Kotlin
  'grafema-kotlin-analyzer',
  'kotlin-resolve',
  'kotlin-parser',
  // JVM cross-language
  'jvm-cross-resolve',
  // Python
  'grafema-python-analyzer',
  'python-resolve',
  // Go
  'grafema-go-analyzer',
  'go-resolve',
  'go-parser',
  // C/C++
  'grafema-cpp-analyzer',
  'cpp-resolve',
  // Swift
  'grafema-swift-analyzer',
  'swift-resolve',
  'swift-parser',
  // Obj-C
  'grafema-objc-analyzer',
  'objc-parser',
  // Apple cross-language
  'apple-cross-resolve',
  // BEAM (Elixir/Erlang)
  'beam-analyzer',
  'beam-resolve',
  // GUI
  'grafema-gui',
  // RFDB
  'rfdb-server',
];

/**
 * Get the directory where lazy-downloaded binaries are stored.
 */
export function getGrafemaBinDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return join(home, '.grafema', 'bin');
}

/**
 * Check if a binary name is eligible for lazy download.
 */
export function isDownloadable(binaryName: string): boolean {
  return DOWNLOADABLE_BINARIES.includes(binaryName);
}

/**
 * Find a binary in ~/.grafema/bin/.
 */
export function findInGrafemaBin(binaryName: string): string | null {
  const binDir = getGrafemaBinDir();
  const p = join(binDir, binaryName);
  return existsSync(p) ? p : null;
}

/**
 * Simple HTTPS GET that follows redirects (GitHub uses 302 → S3).
 */
function httpsGetFollowRedirects(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers: { 'User-Agent': 'grafema-cli' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect without location'));
        httpsGetFollowRedirects(location).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

/**
 * Find the latest binaries-v* release tag from GitHub API.
 */
async function findLatestReleaseTag(): Promise<string> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`;
  const res = await httpsGetFollowRedirects(url);

  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks).toString('utf-8');

  if (res.statusCode !== 200) {
    throw new Error(`GitHub API returned ${res.statusCode}: ${body.slice(0, 200)}`);
  }

  const releases = JSON.parse(body) as Array<{ tag_name: string }>;
  const binRelease = releases.find(r => r.tag_name.startsWith('binaries-v'));
  if (!binRelease) {
    throw new Error('No binaries-v* release found on GitHub');
  }
  return binRelease.tag_name;
}

/**
 * Download a single binary from a GitHub Release.
 *
 * @param binaryName - e.g. "grafema-analyzer"
 * @param tag - e.g. "binaries-v0.3.0-beta"
 * @param onProgress - optional callback for download progress
 * @returns Path to the downloaded binary
 */
export async function downloadBinary(
  binaryName: string,
  tag?: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const platform = getPlatformDir();
  const assetName = `${binaryName}-${platform}`;
  const binDir = getGrafemaBinDir();

  // Ensure ~/.grafema/bin/ exists
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  const targetPath = join(binDir, binaryName);
  const tmpPath = `${targetPath}.downloading`;

  // Resolve tag
  const releaseTag = tag || await findLatestReleaseTag();
  const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/${releaseTag}/${assetName}`;

  const log = onProgress || (() => {});
  log(`Downloading ${binaryName} for ${platform}...`);

  // Download to temp file
  const res = await httpsGetFollowRedirects(downloadUrl);

  if (res.statusCode !== 200) {
    throw new Error(
      `Failed to download ${assetName}: HTTP ${res.statusCode}. ` +
      `Check that release ${releaseTag} has asset ${assetName}.`
    );
  }

  const contentLength = parseInt(res.headers['content-length'] || '0', 10);
  const sizeMB = contentLength > 0 ? `${(contentLength / 1024 / 1024).toFixed(1)}MB` : 'unknown size';
  log(`  ${assetName} (${sizeMB})`);

  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(tmpPath);
    res.pipe(file);
    file.on('finish', () => { file.close(); resolve(); });
    file.on('error', (err) => { unlinkSync(tmpPath); reject(err); });
    res.on('error', (err) => { unlinkSync(tmpPath); reject(err); });
  });

  // Atomic rename + make executable
  renameSync(tmpPath, targetPath);
  chmodSync(targetPath, 0o755);

  // Record which version was downloaded so we can detect stale binaries
  writeFileSync(`${targetPath}.version`, releaseTag, 'utf-8');

  log(`  Installed to ${targetPath}`);
  return targetPath;
}

/**
 * Extract semver from a binaries tag: "binaries-v0.3.14" → "0.3.14"
 */
function versionFromTag(tag: string): string {
  return tag.replace(/^binaries-v/, '');
}

/**
 * Compare two semver strings. Returns true if a >= b.
 * Simple numeric comparison of major.minor.patch.
 */
function semverGte(a: string, b: string): boolean {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true; // equal
}

/**
 * Check if a cached binary in ~/.grafema/bin/ is from a release >= current version.
 * The .version file stores the release tag used for download (e.g. "binaries-v0.3.14").
 */
function isBinaryCurrentVersion(binaryPath: string): boolean {
  const versionFile = `${binaryPath}.version`;
  if (!existsSync(versionFile)) return false;
  try {
    const storedTag = readFileSync(versionFile, 'utf-8').trim();
    const storedVersion = versionFromTag(storedTag);
    return semverGte(storedVersion, GRAFEMA_VERSION);
  } catch {
    return false;
  }
}

/**
 * Ensure a binary exists and is current, downloading it if missing or stale.
 *
 * This is the main entry point for lazy downloading. Call it before
 * spawning an analyzer binary. Returns the path if found or downloaded,
 * null if the binary can't be obtained.
 *
 * Staleness check: if a binary exists in ~/.grafema/bin/ but its .version
 * file doesn't match the current Grafema release, it is re-downloaded.
 *
 * @param binaryName - e.g. "grafema-analyzer"
 * @param existingPath - path from findBinary() (null = not found locally)
 * @param onProgress - optional callback for download progress
 */
export async function ensureBinary(
  binaryName: string,
  existingPath: string | null,
  onProgress?: (msg: string) => void,
): Promise<string | null> {
  // Already found locally (e.g. in platform npm package or PATH)
  if (existingPath) return existingPath;

  // Check ~/.grafema/bin/ first (may have been downloaded previously)
  const cached = findInGrafemaBin(binaryName);
  if (cached && isBinaryCurrentVersion(cached)) return cached;

  // Not downloadable (e.g. rfdb-server — must be in npm package)
  if (!isDownloadable(binaryName)) {
    // If cached exists but is stale and not downloadable, return it anyway
    if (cached) return cached;
    return null;
  }

  // Download (missing or stale) — auto-detect latest binaries-v* release tag
  const log = onProgress || (() => {});
  if (cached) {
    log(`Updating ${binaryName} (stale binary detected)...`);
  }

  try {
    return await downloadBinary(binaryName, undefined, onProgress);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    (onProgress || console.error)(`Failed to download ${binaryName}: ${msg}`);
    // Fall back to stale binary if download fails
    if (cached) return cached;
    return null;
  }
}
