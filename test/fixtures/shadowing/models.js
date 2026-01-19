// models.js - defines User and Order classes

export class User {
  constructor(name) {
    this.name = name;
  }

  save() {
    console.log('Saving user:', this.name);
  }

  delete() {
    console.log('Deleting user:', this.name);
  }
}

export class Order {
  constructor(items) {
    this.items = items;
  }

  process() {
    console.log('Processing order');
  }
}
