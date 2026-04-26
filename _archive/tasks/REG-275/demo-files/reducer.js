// Demo file for REG-275: SwitchStatement as BRANCH nodes
function reducer(state, action) {
  switch (action.type) {
    case 'ADD': return add(action.payload);
    case 'REMOVE': return remove(action.id);
    default: return state;
  }
}

module.exports = { reducer };
