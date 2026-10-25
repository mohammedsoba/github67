// ============================================================
// namespace.js  (V27)
// ============================================================
// Module registry for the classic-script architecture (no build step, no ES modules).
//
// Every module file is an IIFE whose private helpers stay private. What it shares with the rest of the app is
// declared ONCE, at the top of the file, as a manifest:
//
//     YF.expose('presets', {
//       applyPreset: [() => applyPreset, (v) => { applyPreset = v; }],   // function / let / var : live get + set
//       allPresets:  [() => allPresets],                                  // const / class         : live get only
//     });
//
// Each entry is a LIVE BINDING onto the module's own variable, published two ways:
//   1. as a global property (window.applyPreset) - so inline HTML handlers, other scripts and bare-identifier
//      calls keep working exactly as before the refactor, including reassignment (tests stub functions this way);
//   2. as YF.<module>.<name> (YF.presets.applyPreset) - the explicit, greppable way for NEW code to depend on a module.
//
// Load order: this file must be the FIRST app script (index.html). A module loaded without it fails loudly with
// "YF is not defined" instead of silently losing its exports.
(function (g) {
  var YF = g.YF || (g.YF = {});
  var registry = Object.create(null);   // module name -> sorted list of exported names

  function camel(name) {
    return String(name).replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  // expose(moduleName, { exportName: [getter, setter?] })
  YF.expose = function expose(moduleName, accessors) {
    var ns = {};
    var names = Object.keys(accessors).sort();
    names.forEach(function (name) {
      var pair = accessors[name];
      var desc = { configurable: true, enumerable: true, get: pair[0] };
      if (pair[1]) desc.set = pair[1];
      Object.defineProperty(ns, name, desc);
      try {
        Object.defineProperty(g, name, desc);
      } catch (err) {
        throw new Error('YF.expose(' + moduleName + '): cannot publish global "' + name + '" - ' + err.message);
      }
    });
    registry[moduleName] = names;
    YF[camel(moduleName)] = ns;
    return ns;
  };

  // Diagnostics: which modules registered, and what each exports.
  YF.modules = function modules() {
    var out = {};
    Object.keys(registry).forEach(function (m) { out[m] = registry[m].slice(); });
    return out;
  };
})(globalThis);
