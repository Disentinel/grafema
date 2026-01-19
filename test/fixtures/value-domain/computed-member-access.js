// Test: Computed member access obj[method]() resolution

const User = {
  save() {
    console.log('User.save()');
    return 'saved';
  },
  delete() {
    console.log('User.delete()');
    return 'deleted';
  },
  update() {
    console.log('User.update()');
    return 'updated';
  }
};

// Case 1: Deterministic - should resolve to User.save()
function deterministicCall() {
  const method = 'save';     // literal → deterministic
  return User[method]();     // should create CALLS edge to User.save
}

// Case 2: Deterministic through chain - should resolve to User.delete()
function chainedDeterministicCall() {
  const m1 = 'delete';
  const m2 = m1;
  const m3 = m2;
  return User[m3]();        // should create CALLS edge to User.delete
}

// Case 3: Nondeterministic - cannot resolve
function nondeterministicCall(methodName) {
  return User[methodName]();  // parameter → nondeterministic → no CALLS edge
}

// Case 4: Nondeterministic from external source
async function externalNondeterministic() {
  const response = await fetch('/api/method');
  const data = await response.json();
  const method = data.methodName;  // from HTTP → nondeterministic
  return User[method]();           // no CALLS edge
}

// Case 5: Mixed - obj.method() vs obj[method]()
function mixedAccess() {
  User.save();              // direct call → always resolved

  const m = 'update';
  User[m]();                // deterministic computed → should resolve

  const dynamic = getDynamic();
  User[dynamic]();          // nondeterministic computed → cannot resolve
}

function getDynamic() {
  return Math.random() > 0.5 ? 'save' : 'delete';
}

module.exports = {
  deterministicCall,
  chainedDeterministicCall,
  nondeterministicCall,
  externalNondeterministic,
  mixedAccess
};
