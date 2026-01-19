// cross-file-shadow.js - shadows User class with a variable

// This shadows the User class from models.js!
const User = {
  fake: true,
  save: () => console.log('Fake save!')
};

// This call goes to the fake User, not the class
User.save();

// Order is not shadowed, this should be fine
import { Order } from './models.js';
const order = new Order(['item1']);
order.process();
