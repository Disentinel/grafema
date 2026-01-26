// Broken import - references a named export that doesn't exist in utils.js
import { formatMessage, parseData } from './utils.js';

// formatMessage is valid, but parseData doesn't exist
const msg = formatMessage('test');
const data = parseData('{"key": "value"}');

console.log(msg, data);
