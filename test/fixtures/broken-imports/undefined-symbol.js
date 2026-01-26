// Calls an undefined function - no import, just uses something that doesn't exist
import { formatMessage } from './utils.js';

const msg = formatMessage('test');

// processQueue is never defined or imported
const result = processQueue(msg);

console.log(result);
