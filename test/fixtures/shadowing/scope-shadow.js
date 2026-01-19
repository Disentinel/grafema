// scope-shadow.js - shadows imported class inside function scope

import { User, Order } from './models.js';

// This is fine - using imported User
const user1 = new User('Alice');
user1.save();

function processUser(data) {
  // Local variable shadows the imported User class!
  const User = { mock: true };

  // This call goes to the local mock, not the imported class
  console.log(User.mock);

  // Order is not shadowed here
  const order = new Order(data.items);
  order.process();
}

function anotherFunction() {
  // User is not shadowed here, so this is fine
  const user = new User('Bob');
  user.delete();
}

// Arrow function with shadowing
const handler = () => {
  const User = require('./other-user'); // shadows import
  User.create();
};
