// Mongoose User model with complex async methods and this binding
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  profile: {
    firstName: String,
    lastName: String,
    avatar: String
  },
  role: { type: String, default: 'user' },
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date,
  loginAttempts: { type: Number, default: 0 },
  lockUntil: Date
});

// Instance method with this binding
userSchema.methods.comparePassword = function(candidatePassword, callback) {
  const self = this;

  bcrypt.compare(candidatePassword, this.password, function(err, isMatch) {
    if (err) return callback(err);

    if (isMatch) {
      // Reset login attempts on successful match
      if (self.loginAttempts > 0 || self.lockUntil) {
        self.loginAttempts = 0;
        self.lockUntil = undefined;
        self.save(function(err) {
          if (err) return callback(err);
          callback(null, isMatch);
        });
      } else {
        callback(null, isMatch);
      }
    } else {
      // Increment login attempts with callback hell
      self.loginAttempts += 1;

      if (self.loginAttempts >= 5) {
        self.lockUntil = Date.now() + (30 * 60 * 1000); // 30 min lock
      }

      self.save(function(err) {
        if (err) return callback(err);
        callback(null, false);
      });
    }
  });
};

// Instance method returning promise
userSchema.methods.generateAuthToken = function() {
  const user = this;

  return new Promise((resolve, reject) => {
    jwt.sign(
      {
        _id: user._id.toString(),
        email: user.email,
        role: user.role
      },
      'secret-key',
      { expiresIn: '7d' },
      (err, token) => {
        if (err) {
          reject(err);
        } else {
          resolve(token);
        }
      }
    );
  });
};

// Instance method with promise chain using this
userSchema.methods.updateLastLogin = function() {
  this.lastLogin = new Date();

  return this.save()
    .then(savedUser => {
      return mongoose.connection.db
        .collection('login_history')
        .insertOne({
          userId: this._id,
          timestamp: this.lastLogin,
          ip: '0.0.0.0'
        });
    })
    .then(() => {
      return this;
    })
    .catch(err => {
      console.error('Error updating last login:', err);
      throw err;
    });
};

// Async instance method
userSchema.methods.getFullProfile = async function() {
  const profile = this.profile;

  // Parallel async operations
  const [posts, friends, settings] = await Promise.all([
    mongoose.connection.db.collection('posts')
      .find({ userId: this._id })
      .toArray(),
    mongoose.connection.db.collection('friendships')
      .find({ userId: this._id })
      .toArray(),
    mongoose.connection.db.collection('settings')
      .findOne({ userId: this._id })
  ]);

  return {
    email: this.email,
    profile,
    postsCount: posts.length,
    friendsCount: friends.length,
    settings: settings || {}
  };
};

// Static method with callback
userSchema.statics.findByEmail = function(email, callback) {
  return this.findOne({ email }, callback);
};

// Static method with promise chain
userSchema.statics.findActive = function() {
  return this.find({ lockUntil: { $exists: false } })
    .then(users => {
      return users.filter(user => user.loginAttempts < 5);
    })
    .then(activeUsers => {
      return activeUsers.map(user => ({
        id: user._id,
        email: user.email,
        role: user.role
      }));
    });
};

// Static async method
userSchema.statics.createWithProfile = async function(userData) {
  const user = new this(userData);

  // Hash password first
  const salt = await bcrypt.genSalt(10);
  user.password = await bcrypt.hash(user.password, salt);

  // Save user
  await user.save();

  // Create profile in another collection
  await mongoose.connection.db.collection('profiles').insertOne({
    userId: user._id,
    bio: '',
    interests: [],
    createdAt: new Date()
  });

  return user;
};

// Pre-save hook with callback
userSchema.pre('save', function(next) {
  const user = this;

  // Only hash password if it's modified
  if (!user.isModified('password')) {
    return next();
  }

  // Callback hell in pre-save hook
  bcrypt.genSalt(10, function(err, salt) {
    if (err) return next(err);

    bcrypt.hash(user.password, salt, function(err, hash) {
      if (err) return next(err);

      user.password = hash;
      next();
    });
  });
});

// Post-save hook with this binding
userSchema.post('save', function(doc, next) {
  console.log(`User ${this.email} was saved`);

  // Log to audit collection
  mongoose.connection.db.collection('audit_log').insertOne({
    action: 'user_save',
    userId: this._id,
    timestamp: new Date()
  }, (err) => {
    if (err) {
      console.error('Audit log error:', err);
    }
    next();
  });
});

// Virtual property using this
userSchema.virtual('fullName').get(function() {
  if (this.profile.firstName && this.profile.lastName) {
    return `${this.profile.firstName} ${this.profile.lastName}`;
  }
  return this.email;
});

// Instance method with generator
userSchema.methods.getActivityLog = function*() {
  yield `User: ${this.email}`;
  yield `Role: ${this.role}`;
  yield `Created: ${this.createdAt}`;
  yield `Last Login: ${this.lastLogin || 'Never'}`;
  yield `Login Attempts: ${this.loginAttempts}`;
};

export const User = mongoose.model('User', userSchema);
