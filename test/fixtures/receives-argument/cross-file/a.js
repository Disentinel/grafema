// Cross-file test: function defined in a.js
// Exported function that will be called from b.js

export function processData(data) {
  return data.toUpperCase();
}

export function multiParam(first, second, third) {
  return { first, second, third };
}

export class Handler {
  handle(request) {
    return { handled: request };
  }
}
