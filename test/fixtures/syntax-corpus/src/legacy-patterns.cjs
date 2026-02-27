// =============================================================================
// legacy-patterns.cjs — Legacy Module Systems, Polyfills, Compiled Output
// =============================================================================
//
// Patterns Grafema will encounter in legacy codebases:
// AMD, UMD, global namespaces, polyfills, Babel/TS compiled output.
// These cannot be ESM — hence .cjs extension.
// =============================================================================

// --- AMD (RequireJS) ---

// @construct PENDING amd-define-deps
// @annotation
// MODULE <<module>> -> CONTAINS -> CALL <<define-call>>
// CALL <<define-call>> -> PASSES_ARGUMENT -> LITERAL <<'jquery'>>
// CALL <<define-call>> -> PASSES_ARGUMENT -> LITERAL <<'underscore'>>
// CALL <<define-call>> -> PASSES_ARGUMENT -> FUNCTION <<factory-function>>
// FUNCTION <<factory-function>> -> CONTAINS -> PARAMETER <<$>>
// FUNCTION <<factory-function>> -> CONTAINS -> PARAMETER <<_>>
// FUNCTION <<factory-function>> -> RETURNS -> LITERAL <<module-object>>
// LITERAL <<module-object>> -> HAS_PROPERTY -> METHOD <<render>>
// METHOD <<render>> -> CONTAINS -> PARAMETER <<data>>
// METHOD <<render>> -> RETURNS -> CALL <<template-invocation>>
// CALL <<template-invocation>> -> CALLS -> CALL <<_.template-call>>
// CALL <<_.template-call>> -> READS_FROM -> PARAMETER <<_>>
// CALL <<_.template-call>> -> PASSES_ARGUMENT -> CALL <<$('#tpl').html()>>
// CALL <<$('#tpl').html()>> -> CALLS -> PARAMETER <<$>>
// CALL <<$('#tpl').html()>> -> PASSES_ARGUMENT -> LITERAL <<'#tpl'>>
// CALL <<template-invocation>> -> PASSES_ARGUMENT -> PARAMETER <<data>>
// PARAMETER <<$>> -> IMPORTS_FROM -> LITERAL <<'jquery'>>
// PARAMETER <<_>> -> IMPORTS_FROM -> LITERAL <<'underscore'>>
// @end-annotation
// define(['jquery', 'underscore'], function($, _) {
//   return {
//     render: function(data) {
//       return _.template($('#tpl').html())(data);
//     }
//   };
// });

// @construct PENDING amd-define-named
// define('myModule', ['dep1', 'dep2'], function(dep1, dep2) {
//   return { init: function() {} };
// });

// @construct PENDING amd-require-call
// require(['app/main', 'app/config'], function(main, config) {
//   main.start(config);
// });

// --- UMD (Universal Module Definition) ---

// @construct PENDING umd-wrapper
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['dependency'], factory);                         // AMD
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('dependency'));          // CJS
  } else {
    root.MyLibrary = factory(root.Dependency);               // Browser global
  }
}(typeof self !== 'undefined' ? self : this, function (dep) {
  return { version: '1.0', process: function(x) { return dep.transform(x); } };
}));

// --- Global Namespace Pattern ---

// @construct PENDING global-namespace-init
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<MyApp>>
// VARIABLE <<MyApp>> -> ASSIGNED_FROM -> EXPRESSION <<MyApp || {}>>
// EXPRESSION <<MyApp || {}>> -> READS_FROM -> VARIABLE <<MyApp>>
// EXPRESSION <<MyApp || {}>> -> READS_FROM -> LITERAL <<{}>>
// PROPERTY_ACCESS <<MyApp.utils>> -> ASSIGNED_FROM -> EXPRESSION <<MyApp.utils || {}>>
// EXPRESSION <<MyApp.utils || {}>> -> READS_FROM -> PROPERTY_ACCESS <<MyApp.utils>>
// EXPRESSION <<MyApp.utils || {}>> -> READS_FROM -> LITERAL <<{} (utils)>>
// PROPERTY_ACCESS <<MyApp.utils.format>> -> ASSIGNED_FROM -> FUNCTION <<format>>
// FUNCTION <<format>> -> CONTAINS -> PARAMETER <<str>>
// FUNCTION <<format>> -> RETURNS -> CALL <<str.trim()>>
// CALL <<str.trim()>> -> CALLS_ON -> PARAMETER <<str>>
// @end-annotation
var MyApp = MyApp || {};
MyApp.utils = MyApp.utils || {};
MyApp.utils.format = function (str) { return str.trim(); };

// @construct PENDING global-namespace-iife
var MyApp2 = (function (ns) {
  var _private = 0;
  ns.increment = function () { return ++_private; };
  ns.getValue = function () { return _private; };
  return ns;
}(MyApp2 || {}));

// @construct PENDING global-namespace-revealing
// @annotation
// VARIABLE <<RevealingModule>> -> ASSIGNED_FROM -> CALL <<IIFE-call>>
// CALL <<IIFE-call>> -> CALLS -> FUNCTION <<IIFE>>
// FUNCTION <<IIFE>> -> CONTAINS -> VARIABLE <<secret>>
// VARIABLE <<secret>> -> ASSIGNED_FROM -> LITERAL <<'hidden'>>
// FUNCTION <<IIFE>> -> CONTAINS -> FUNCTION <<getSecret>>
// FUNCTION <<IIFE>> -> CONTAINS -> FUNCTION <<setSecret>>
// FUNCTION <<setSecret>> -> CONTAINS -> PARAMETER <<s>>
// FUNCTION <<getSecret>> -> READS_FROM -> VARIABLE <<secret>>
// FUNCTION <<getSecret>> -> RETURNS -> VARIABLE <<secret>>
// FUNCTION <<setSecret>> -> WRITES_TO -> VARIABLE <<secret>>
// VARIABLE <<secret>> -> ASSIGNED_FROM -> PARAMETER <<s>>
// FUNCTION <<IIFE>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> FUNCTION <<getSecret>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> FUNCTION <<setSecret>>
// FUNCTION <<getSecret>> -> CAPTURES -> VARIABLE <<secret>>
// FUNCTION <<setSecret>> -> CAPTURES -> VARIABLE <<secret>>
// @end-annotation
var RevealingModule = (function () {
  var secret = 'hidden';
  function getSecret() { return secret; }
  function setSecret(s) { secret = s; }
  return { get: getSecret, set: setSecret };
})();

// --- Polyfill Patterns ---

// @construct PENDING polyfill-prototype-method
// @annotation
// BRANCH <<if-polyfill>> -> HAS_CONDITION -> EXPRESSION <<!Array.prototype.flat>>
// EXPRESSION <<!Array.prototype.flat>> -> READS_FROM -> PROPERTY_ACCESS <<Array.prototype.flat>>
// PROPERTY_ACCESS <<Array.prototype.flat>> -> ASSIGNED_FROM -> FUNCTION <<polyfill-flat>>
// FUNCTION <<polyfill-flat>> -> HAS_BODY -> PARAMETER <<depth>>
// PARAMETER <<depth>> -> ASSIGNED_FROM -> EXPRESSION <<depth-ternary>>
// EXPRESSION <<depth-ternary>> -> HAS_CONSEQUENT -> LITERAL <<1>>
// EXPRESSION <<depth-ternary>> -> HAS_ALTERNATE -> CALL <<Math.floor>>
// CALL <<Math.floor>> -> PASSES_ARGUMENT -> PARAMETER <<depth>>
// FUNCTION <<polyfill-flat>> -> HAS_BODY -> BRANCH <<early-return>>
// BRANCH <<early-return>> -> HAS_CONSEQUENT -> CALL <<slice-call>>
// FUNCTION <<polyfill-flat>> -> RETURNS -> CALL <<reduce-call>>
// CALL <<reduce-call>> -> PASSES_ARGUMENT -> FUNCTION <<reduce-callback>>
// CALL <<reduce-call>> -> PASSES_ARGUMENT -> LITERAL <<empty-array>>
// FUNCTION <<reduce-callback>> -> HAS_BODY -> PARAMETER <<acc>>
// FUNCTION <<reduce-callback>> -> HAS_BODY -> PARAMETER <<val>>
// FUNCTION <<reduce-callback>> -> RETURNS -> CALL <<concat-call>>
// CALL <<concat-call>> -> PASSES_ARGUMENT -> EXPRESSION <<ternary-arg>>
// EXPRESSION <<ternary-arg>> -> HAS_CONDITION -> CALL <<isArray-call>>
// EXPRESSION <<ternary-arg>> -> HAS_CONSEQUENT -> CALL <<recursive-flat>>
// EXPRESSION <<ternary-arg>> -> HAS_ALTERNATE -> PARAMETER <<val>>
// CALL <<isArray-call>> -> PASSES_ARGUMENT -> PARAMETER <<val>>
// CALL <<recursive-flat>> -> CALLS_ON -> PARAMETER <<val>>
// @end-annotation
if (!Array.prototype.flat) {
  Array.prototype.flat = function (depth) {
    depth = depth === undefined ? 1 : Math.floor(depth);
    if (depth < 1) return Array.prototype.slice.call(this);
    return Array.prototype.reduce.call(this, function (acc, val) {
      return acc.concat(Array.isArray(val) && depth > 1 ? val.flat(depth - 1) : val);
    }, []);
  };
}

// @construct PENDING polyfill-static-method
// @annotation
// @end-annotation
if (!Object.entries) {
  Object.entries = function (obj) {
    var keys = Object.keys(obj);
    var result = [];
    for (var i = 0; i < keys.length; i++) {
      result.push([keys[i], obj[keys[i]]]);
    }
    return result;
  };
}

// @construct PENDING polyfill-promise
// @annotation
// BRANCH <<if-Promise-undefined>> -> HAS_CONDITION -> EXPRESSION <<typeof Promise === 'undefined'>>
// EXPRESSION <<typeof Promise === 'undefined'>> -> READS_FROM -> FUNCTION <<Promise>>
// BRANCH <<if-Promise-undefined>> -> HAS_CONSEQUENT -> FUNCTION <<Promise>>
// FUNCTION <<Promise>> -> CONTAINS -> PARAMETER <<executor>>
// FUNCTION <<Promise>> -> WRITES_TO -> PROPERTY_ACCESS <<this._state>>
// PROPERTY_ACCESS <<this._state>> -> ASSIGNED_FROM -> LITERAL <<'pending'>>
// FUNCTION <<Promise>> -> WRITES_TO -> PROPERTY_ACCESS <<this._value>>
// PROPERTY_ACCESS <<this._value>> -> ASSIGNED_FROM -> LITERAL <<undefined>>
// FUNCTION <<Promise>> -> WRITES_TO -> PROPERTY_ACCESS <<this._callbacks>>
// PROPERTY_ACCESS <<this._callbacks>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<Promise>> -> CONTAINS -> CALL <<executor(this._resolve.bind(this), this._reject.bind(this))>>
// CALL <<executor(this._resolve.bind(this), this._reject.bind(this))>> -> CALLS -> PARAMETER <<executor>>
// CALL <<executor(this._resolve.bind(this), this._reject.bind(this))>> -> PASSES_ARGUMENT -> CALL <<this._resolve.bind(this)>>
// CALL <<executor(this._resolve.bind(this), this._reject.bind(this))>> -> PASSES_ARGUMENT -> CALL <<this._reject.bind(this)>>
// CALL <<this._resolve.bind(this)>> -> READS_FROM -> METHOD <<Promise.prototype._resolve>>
// CALL <<this._reject.bind(this)>> -> READS_FROM -> METHOD <<Promise.prototype._reject>>
// METHOD <<Promise.prototype.then>> -> CONTAINS -> PARAMETER <<onFulfilled>>
// METHOD <<Promise.prototype.then>> -> CONTAINS -> PARAMETER <<onRejected>>
// METHOD <<Promise.prototype._resolve>> -> CONTAINS -> PARAMETER <<value>>
// METHOD <<Promise.prototype._reject>> -> CONTAINS -> PARAMETER <<reason>>
// @end-annotation
if (typeof Promise === 'undefined') {
  // Simplified polyfill shape — real ones are 200+ lines
  function Promise(executor) {
    this._state = 'pending';
    this._value = undefined;
    this._callbacks = [];
    executor(this._resolve.bind(this), this._reject.bind(this));
  }
  Promise.prototype.then = function (onFulfilled, onRejected) { /* ... */ };
  Promise.prototype._resolve = function (value) { /* ... */ };
  Promise.prototype._reject = function (reason) { /* ... */ };
}

// @construct PENDING polyfill-symbol-shim
// @annotation
// BRANCH <<if-symbol-undefined>> -> HAS_CONDITION -> EXPRESSION <<typeof Symbol === 'undefined'>>
// EXPRESSION <<typeof Symbol === 'undefined'>> -> READS_FROM -> EXPRESSION <<typeof Symbol>>
// EXPRESSION <<typeof Symbol === 'undefined'>> -> READS_FROM -> LITERAL <<'undefined'>>
// EXPRESSION <<typeof Symbol>> -> READS_FROM -> VARIABLE <<Symbol>>
// BRANCH <<if-symbol-undefined>> -> DECLARES -> VARIABLE <<Symbol>>
// VARIABLE <<Symbol>> -> ASSIGNED_FROM -> FUNCTION <<Symbol:polyfill>>
// FUNCTION <<Symbol:polyfill>> -> CONTAINS -> PARAMETER <<description>>
// FUNCTION <<Symbol:polyfill>> -> RETURNS -> EXPRESSION <<'__symbol_' + (description || '') + '_' + Math.random().toString(36)>>
// EXPRESSION <<'__symbol_' + (description || '') + '_' + Math.random().toString(36)>> -> READS_FROM -> LITERAL <<'__symbol_'>>
// EXPRESSION <<'__symbol_' + (description || '') + '_' + Math.random().toString(36)>> -> READS_FROM -> EXPRESSION <<description || ''>>
// EXPRESSION <<'__symbol_' + (description || '') + '_' + Math.random().toString(36)>> -> READS_FROM -> LITERAL <<'_'>>
// EXPRESSION <<'__symbol_' + (description || '') + '_' + Math.random().toString(36)>> -> READS_FROM -> CALL <<Math.random().toString(36)>>
// EXPRESSION <<description || ''>> -> READS_FROM -> PARAMETER <<description>>
// EXPRESSION <<description || ''>> -> READS_FROM -> LITERAL <<''>>
// CALL <<Math.random().toString(36)>> -> CALLS -> CALL <<Math.random()>>
// CALL <<Math.random().toString(36)>> -> PASSES_ARGUMENT -> LITERAL <<36>>
// CALL <<Math.random()>> -> CALLS -> PROPERTY_ACCESS <<Math.random>>
// BRANCH <<if-symbol-undefined>> -> WRITES_TO -> PROPERTY_ACCESS <<Symbol.iterator>>
// PROPERTY_ACCESS <<Symbol.iterator>> -> ASSIGNED_FROM -> LITERAL <<'@@iterator'>>
// @end-annotation
if (typeof Symbol === 'undefined') {
  var Symbol = function (description) {
    return '__symbol_' + (description || '') + '_' + Math.random().toString(36);
  };
  Symbol.iterator = '@@iterator';
}

// --- Babel Compiled Output ---

// @construct PENDING babel-class-call-check
// @annotation
// FUNCTION <<_classCallCheck>> -> CONTAINS -> PARAMETER <<instance>>
// FUNCTION <<_classCallCheck>> -> CONTAINS -> PARAMETER <<Constructor>>
// FUNCTION <<_classCallCheck>> -> CONTAINS -> BRANCH <<instanceof-check>>
// BRANCH <<instanceof-check>> -> HAS_CONDITION -> EXPRESSION <<!(instance instanceof Constructor)>>
// EXPRESSION <<!(instance instanceof Constructor)>> -> READS_FROM -> PARAMETER <<instance>>
// EXPRESSION <<!(instance instanceof Constructor)>> -> READS_FROM -> PARAMETER <<Constructor>>
// BRANCH <<instanceof-check>> -> HAS_CONSEQUENT -> CALL <<new TypeError(...)>>
// CALL <<new TypeError(...)>> -> PASSES_ARGUMENT -> LITERAL <<'Cannot call a class as a function'>>
// BRANCH <<instanceof-check>> -> THROWS -> CALL <<new TypeError(...)>>
// @end-annotation
function _classCallCheck(instance, Constructor) {
  if (!(instance instanceof Constructor)) {
    throw new TypeError('Cannot call a class as a function');
  }
}

// @construct PENDING babel-create-class
// @annotation
// @end-annotation
function _createClass(Constructor, protoProps, staticProps) {
  if (protoProps) _defineProperties(Constructor.prototype, protoProps);
  if (staticProps) _defineProperties(Constructor, staticProps);
  return Constructor;
}

function _defineProperties(target, props) {
  for (var i = 0; i < props.length; i++) {
    var descriptor = props[i];
    descriptor.enumerable = descriptor.enumerable || false;
    descriptor.configurable = true;
    if ('value' in descriptor) descriptor.writable = true;
    Object.defineProperty(target, descriptor.key, descriptor);
  }
}

// @construct PENDING babel-inherits
// @annotation
// FUNCTION <<_inherits>> -> HAS_BODY -> PARAMETER <<subClass>>
// FUNCTION <<_inherits>> -> HAS_BODY -> PARAMETER <<superClass>>
// PROPERTY_ACCESS <<subClass.prototype>> -> ASSIGNED_FROM -> CALL <<Object.create>>
// CALL <<Object.create>> -> PASSES_ARGUMENT -> EXPRESSION <<superClass && superClass.prototype>>
// CALL <<Object.create>> -> PASSES_ARGUMENT -> LITERAL <<constructor-descriptor>>
// EXPRESSION <<superClass && superClass.prototype>> -> READS_FROM -> PARAMETER <<superClass>>
// EXPRESSION <<superClass && superClass.prototype>> -> READS_FROM -> PROPERTY_ACCESS <<superClass.prototype>>
// PROPERTY_ACCESS <<superClass.prototype>> -> READS_FROM -> PARAMETER <<superClass>>
// LITERAL <<constructor-descriptor>> -> READS_FROM -> PARAMETER <<subClass>>
// FUNCTION <<_inherits>> -> HAS_BODY -> BRANCH <<if-superClass>>
// BRANCH <<if-superClass>> -> HAS_CONDITION -> PARAMETER <<superClass>>
// BRANCH <<if-superClass>> -> HAS_CONSEQUENT -> CALL <<Object.setPrototypeOf>>
// CALL <<Object.setPrototypeOf>> -> PASSES_ARGUMENT -> PARAMETER <<subClass>>
// CALL <<Object.setPrototypeOf>> -> PASSES_ARGUMENT -> PARAMETER <<superClass>>
// @end-annotation
function _inherits(subClass, superClass) {
  subClass.prototype = Object.create(superClass && superClass.prototype, {
    constructor: { value: subClass, writable: true, configurable: true }
  });
  if (superClass) Object.setPrototypeOf(subClass, superClass);
}

// @construct PENDING babel-class-compiled
// @annotation
// VARIABLE <<Dog>> -> ASSIGNED_FROM -> FUNCTION <<Dog:iife>>
// FUNCTION <<Dog:iife>> -> CONTAINS -> PARAMETER <<_Animal>>
// FUNCTION <<Dog:iife>> -> CONTAINS -> CALL <<_inherits(Dog, _Animal)>>
// FUNCTION <<Dog:iife>> -> CONTAINS -> FUNCTION <<Dog:constructor>>
// FUNCTION <<Dog:iife>> -> RETURNS -> FUNCTION <<Dog:constructor>>
// FUNCTION <<Dog:constructor>> -> CONTAINS -> PARAMETER <<name>>
// FUNCTION <<Dog:constructor>> -> CONTAINS -> CALL <<_classCallCheck(this, Dog)>>
// FUNCTION <<Dog:constructor>> -> RETURNS -> CALL <<_Animal.call(this, name)>>
// CALL <<_inherits(Dog, _Animal)>> -> CALLS -> EXTERNAL <<_inherits>>
// CALL <<_inherits(Dog, _Animal)>> -> PASSES_ARGUMENT -> VARIABLE <<Dog>>
// CALL <<_inherits(Dog, _Animal)>> -> PASSES_ARGUMENT -> PARAMETER <<_Animal>>
// CALL <<_classCallCheck(this, Dog)>> -> CALLS -> EXTERNAL <<_classCallCheck>>
// CALL <<_classCallCheck(this, Dog)>> -> PASSES_ARGUMENT -> VARIABLE <<Dog>>
// CALL <<_Animal.call(this, name)>> -> CALLS -> PARAMETER <<_Animal>>
// CALL <<_Animal.call(this, name)>> -> PASSES_ARGUMENT -> PARAMETER <<name>>
// FUNCTION <<Dog:iife>> -> READS_FROM -> EXTERNAL <<Animal>>
// @end-annotation
// Source: class Dog extends Animal { constructor(name) { super(name); } }
// Compiled:
var Dog = (function (_Animal) {
  _inherits(Dog, _Animal);
  function Dog(name) {
    _classCallCheck(this, Dog);
    return _Animal.call(this, name);
  }
  return Dog;
}(Animal));

// --- TypeScript Compiled Output ---

// @construct PENDING ts-compiled-extends
// @annotation
// @end-annotation
var __extends = (this && this.__extends) || (function () {
  var extendStatics = Object.setPrototypeOf ||
    ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
    function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
  return function (d, b) {
    extendStatics(d, b);
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
  };
})();

// @construct PENDING ts-compiled-awaiter
// @annotation
// @end-annotation
var __awaiter = function (thisArg, _arguments, P, generator) {
  return new (P || (P = Promise))(function (resolve, reject) {
    function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
    function rejected(value) { try { step(generator['throw'](value)); } catch (e) { reject(e); } }
    function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
};

// @construct PENDING ts-compiled-spread
// @annotation
// VARIABLE <<__spreadArray>> -> ASSIGNED_FROM -> FUNCTION <<__spreadArray:fn>>
// FUNCTION <<__spreadArray:fn>> -> CONTAINS -> PARAMETER <<to>>
// FUNCTION <<__spreadArray:fn>> -> CONTAINS -> PARAMETER <<from>>
// FUNCTION <<__spreadArray:fn>> -> CONTAINS -> LOOP <<for-loop>>
// LOOP <<for-loop>> -> HAS_INIT -> VARIABLE <<i>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> LITERAL <<0>>
// LOOP <<for-loop>> -> HAS_INIT -> VARIABLE <<il>>
// VARIABLE <<il>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<from.length>>
// PROPERTY_ACCESS <<from.length>> -> READS_FROM -> PARAMETER <<from>>
// LOOP <<for-loop>> -> HAS_INIT -> VARIABLE <<j>>
// VARIABLE <<j>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<to.length>>
// PROPERTY_ACCESS <<to.length>> -> READS_FROM -> PARAMETER <<to>>
// LOOP <<for-loop>> -> HAS_CONDITION -> EXPRESSION <<i < il>>
// EXPRESSION <<i < il>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i < il>> -> READS_FROM -> VARIABLE <<il>>
// LOOP <<for-loop>> -> HAS_UPDATE -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> MODIFIES -> VARIABLE <<i>>
// LOOP <<for-loop>> -> HAS_UPDATE -> EXPRESSION <<j++>>
// EXPRESSION <<j++>> -> MODIFIES -> VARIABLE <<j>>
// LOOP <<for-loop>> -> HAS_BODY -> EXPRESSION <<to[j] = from[i]>>
// EXPRESSION <<to[j] = from[i]>> -> WRITES_TO -> PROPERTY_ACCESS <<to[j]>>
// EXPRESSION <<to[j] = from[i]>> -> READS_FROM -> PROPERTY_ACCESS <<from[i]>>
// PROPERTY_ACCESS <<to[j]>> -> READS_FROM -> PARAMETER <<to>>
// PROPERTY_ACCESS <<to[j]>> -> READS_FROM -> VARIABLE <<j>>
// PROPERTY_ACCESS <<from[i]>> -> READS_FROM -> PARAMETER <<from>>
// PROPERTY_ACCESS <<from[i]>> -> READS_FROM -> VARIABLE <<i>>
// FUNCTION <<__spreadArray:fn>> -> RETURNS -> PARAMETER <<to>>
// @end-annotation
var __spreadArray = function (to, from) {
  for (var i = 0, il = from.length, j = to.length; i < il; i++, j++)
    to[j] = from[i];
  return to;
};

// @construct PENDING ts-compiled-decorate
// @annotation
// @end-annotation
var __decorate = function (decorators, target, key, desc) {
  var c = arguments.length;
  var r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc;
  for (var i = decorators.length - 1; i >= 0; i--) {
    var d = decorators[i];
    if (d) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
  }
  return c > 3 && r && Object.defineProperty(target, key, r), r;
};

// --- jQuery-Style Plugin Pattern ---

// @construct PENDING jquery-plugin-pattern
// @annotation
// PROPERTY_ACCESS <<$.fn.highlight>> -> ASSIGNED_FROM -> FUNCTION <<highlight:fn>>
// FUNCTION <<highlight:fn>> -> CONTAINS -> PARAMETER <<color>>
// FUNCTION <<highlight:fn>> -> RETURNS -> CALL <<this.each(...)>>
// CALL <<this.each(...)>> -> PASSES_ARGUMENT -> FUNCTION <<each-callback:fn>>
// FUNCTION <<each-callback:fn>> -> CONTAINS -> CALL <<$(this)>>
// CALL <<$(this).css(...)>> -> CALLS_ON -> CALL <<$(this)>>
// CALL <<$(this).css(...)>> -> PASSES_ARGUMENT -> LITERAL <<'background-color'>>
// CALL <<$(this).css(...)>> -> PASSES_ARGUMENT -> EXPRESSION <<color || 'yellow'>>
// EXPRESSION <<color || 'yellow'>> -> READS_FROM -> PARAMETER <<color>>
// EXPRESSION <<color || 'yellow'>> -> READS_FROM -> LITERAL <<'yellow'>>
// CALL <<$('p').highlight('red')>> -> CALLS_ON -> CALL <<$('p')>>
// CALL <<$('p')>> -> PASSES_ARGUMENT -> LITERAL <<'p'>>
// CALL <<$('p').highlight('red')>> -> PASSES_ARGUMENT -> LITERAL <<'red'>>
// @end-annotation
// $.fn.highlight = function(color) {
//   return this.each(function() {
//     $(this).css('background-color', color || 'yellow');
//   });
// };
// Usage: $('p').highlight('red');

// @construct PENDING jquery-extend-pattern
// $.extend(true, target, source1, source2); // deep merge
// $.extend($.fn, { newPlugin: function() {} }); // add to prototype

// @construct PENDING jquery-deferred
// var dfd = $.Deferred();
// dfd.done(function(data) { ... });
// dfd.fail(function(err) { ... });
// dfd.resolve(result); // or dfd.reject(error);

// --- Script Concatenation / Namespace Export ---

// @construct PENDING script-concat-export
// Pattern: library exposes itself via `this` (global in browsers, exports in CJS)
(function (exports) {
  function StringUtils() {}
  StringUtils.capitalize = function (s) { return s.charAt(0).toUpperCase() + s.slice(1); };
  StringUtils.trim = function (s) { return s.replace(/^\s+|\s+$/g, ''); };
  exports.StringUtils = StringUtils;
}(typeof module !== 'undefined' ? module.exports : (this.MyLib = this.MyLib || {})));
