// Barrel re-export — the actual implementations live in separate files
// to keep each under the 500-line limit.
export { trackVariableAssignment, type AssignmentTrackingContext } from './trackVariableAssignment.js';
export { extractObjectProperties } from './extractObjectProperties.js';
export { trackDestructuringAssignment } from './trackDestructuringAssignment.js';
