// Test fixtures for class parameter PARAMETER node detection

// Class with constructor parameters
class ConfigService {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
  }

  // Method with regular and rest parameters
  process(data, ...extras) {
    return data;
  }

  // Arrow function property with parameter
  handler = (event) => {
    console.log(event);
  }

  // Async method with parameter
  async fetch(url) {
    return fetch(url);
  }

  // Getter (no parameters, should be ignored)
  get name() {
    return 'ConfigService';
  }

  // Setter (should have parameter)
  set timeout(value) {
    this._timeout = value;
  }
}

export { ConfigService };
