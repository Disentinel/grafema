// Cross-file test: calls to functions defined in a.js
// RECEIVES_ARGUMENT edges should link parameters in a.js to arguments in b.js

import { processData, multiParam, Handler } from './a.js';

// Call imported function with variable
const input = 'hello world';
processData(input);

// Call imported function with multiple args
const a = 1;
const b = 2;
const c = 3;
multiParam(a, b, c);

// Call method on imported class instance
const handler = new Handler();
const request = { url: '/api', method: 'GET' };
handler.handle(request);
