export {
  trackVariableAssignment,
  extractObjectProperties,
  trackDestructuringAssignment,
  type AssignmentTrackingContext,
} from './VariableAssignmentTracker.js';

export {
  handleSwitchStatement,
  extractDiscriminantExpression,
} from './SwitchStatementAnalyzer.js';

export {
  handleVariableDeclaration,
} from './VariableDeclarationExtractor.js';

export {
  extractReturnExpressionInfo,
} from './ReturnExpressionExtractor.js';

export {
  microTraceToErrorClass,
} from './MicroTraceToErrorClass.js';

export {
  handleCallExpression,
  extractMethodCallArguments,
} from './CallExpressionExtractor.js';
