export {
  detectArrayMutationInFunction,
  detectIndexedArrayAssignment,
} from './array-mutations.js';

export {
  detectObjectPropertyAssignment,
  extractMutationValue,
  detectObjectAssignInFunction,
} from './object-mutations.js';

export {
  detectVariableReassignment,
  collectUpdateExpression,
} from './variable-mutations.js';
