// fixtures.ts — vendored v0 program texts shared by scenarios and the
// differential (single source, no import cycles).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VENDOR_ROOT } from './oracle.ts';

const read = (...p: string[]): string => fs.readFileSync(path.join(VENDOR_ROOT, ...p), 'utf8');

export const BOOT = read('boot.rofl');
export const SENSORS = read('examples', 'sensors.rofl');
export const COUNTER = read('examples', 'counter.rofl');
export const TM = read('examples', 'tm.rofl');
export const TM_DIV = read('examples', 'tm_diverge.rofl');
