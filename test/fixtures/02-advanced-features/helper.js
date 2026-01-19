// Helper module for testing imports
export class Helper {
  constructor() {
    this.value = 42;
  }

  doSomething() {
    console.log('Doing something');
  }

  calculate(x) {
    return x * this.value;
  }
}
