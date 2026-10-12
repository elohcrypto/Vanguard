#!/usr/bin/env node
"use strict";
// Task 4.17 gate: no free identifier in demo/ or scripts/. A free
// identifier is a name a file reads or calls but never declares (var,
// let, const, function, class, parameter, catch binding, import) in an
// enclosing scope and that is not on GLOBALS below. Such a name throws a
// ReferenceError only when its line runs, which a demo option nobody
// drove can hide for months. Scope walk with acorn over every git-tracked
// .js file under demo/ and scripts/ (the .ts files are type-checked by
// tsc in CI instead). acorn is not a direct dependency: npm ci installs
// it top-level from package-lock.json (8.x, under ts-node).
// Exits 1 on any finding or parse error;
// `node scripts/ci/free-identifiers.js`.
const { execFileSync } = require("child_process");
const fs = require("fs");
const acorn = require("acorn");

// Explicit allowlist: ECMAScript and Node.js globals the code may use
// undeclared. Add a name here only when it is a real runtime global.
const GLOBALS = new Set([
  // ECMAScript
  "undefined",
  "NaN",
  "Infinity",
  "globalThis",
  "arguments",
  "Object",
  "Function",
  "Array",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "BigInt",
  "Math",
  "JSON",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AggregateError",
  "Promise",
  "Proxy",
  "Reflect",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Atomics",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Uint8ClampedArray",
  "Intl",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  // Node.js
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "process",
  "console",
  "Buffer",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "queueMicrotask",
  "structuredClone",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "AbortSignal",
  "fetch",
  "performance",
  "crypto",
]);

const FUNCTION = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const BLOCK = new Set([
  "BlockStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "SwitchStatement",
  "CatchClause",
  "StaticBlock",
]);

function patternNames(p, out) {
  if (!p) return;
  if (p.type === "Identifier") out.push(p.name);
  else if (p.type === "ObjectPattern")
    for (const q of p.properties)
      patternNames(q.type === "RestElement" ? q.argument : q.value, out);
  else if (p.type === "ArrayPattern")
    for (const e of p.elements) patternNames(e, out);
  else if (p.type === "RestElement") patternNames(p.argument, out);
  else if (p.type === "AssignmentPattern") patternNames(p.left, out);
}

function children(node) {
  const out = [];
  for (const k of Object.keys(node)) {
    if (k === "loc") continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === "string") out.push([k, c]);
    } else if (v && typeof v.type === "string") out.push([k, v]);
  }
  return out;
}

function parse(src) {
  const opts = { ecmaVersion: "latest", allowHashBang: true, locations: true };
  try {
    return acorn.parse(src, {
      ...opts,
      sourceType: "script",
      allowReturnOutsideFunction: true,
    });
  } catch {
    return acorn.parse(src, { ...opts, sourceType: "module" });
  }
}

/** Free identifiers of one file, as "name@line". */
function freeIn(src) {
  const ast = parse(src);
  const decls = new Map(); // scope node -> Set of names
  const add = (scope, names) => {
    if (!decls.has(scope)) decls.set(scope, new Set());
    for (const n of names) decls.get(scope).add(n);
  };
  // Pass 1: declarations, var hoisted to the function (or program).
  (function collect(node, fnScope, blockScope) {
    const isFn = FUNCTION.has(node.type);
    const isBlock = BLOCK.has(node.type);
    const fn = isFn ? node : fnScope;
    const block = isFn || isBlock ? node : blockScope;
    const names = [];
    switch (node.type) {
      case "VariableDeclaration":
        for (const d of node.declarations) patternNames(d.id, names);
        add(node.kind === "var" ? fnScope : blockScope, names);
        break;
      case "FunctionDeclaration":
      case "ClassDeclaration":
        add(blockScope, [node.id.name]);
        break;
      case "ImportDeclaration":
        add(
          blockScope,
          node.specifiers.map((s) => s.local.name),
        );
        break;
    }
    if (isFn) {
      const own = [];
      for (const p of node.params) patternNames(p, own);
      if (node.type === "FunctionExpression" && node.id) own.push(node.id.name);
      add(node, own);
    }
    if (node.type === "CatchClause" && node.param) {
      const own = [];
      patternNames(node.param, own);
      add(node, own);
    }
    if (node.type === "ClassExpression" && node.id) add(node, [node.id.name]);
    for (const [, c] of children(node)) collect(c, fn, block);
  })(ast, ast, ast);

  // Pass 2: references, resolved up the scope chain.
  const free = [];
  (function refs(node, chain, parent, key) {
    if (decls.has(node)) chain = chain.concat([node]);
    if (node.type === "Identifier") {
      const notRef =
        parent &&
        ((parent.type === "MemberExpression" &&
          key === "property" &&
          !parent.computed) ||
          ((parent.type === "Property" ||
            parent.type === "MethodDefinition" ||
            parent.type === "PropertyDefinition") &&
            key === "key" &&
            !parent.computed) ||
          ["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(
            parent.type,
          ) ||
          parent.type === "MetaProperty" ||
          parent.type === "ExportSpecifier" ||
          parent.type === "ImportSpecifier" ||
          parent.type === "ImportDefaultSpecifier" ||
          parent.type === "ImportNamespaceSpecifier");
      if (!notRef) {
        const name = node.name;
        const known =
          GLOBALS.has(name) || chain.some((s) => decls.get(s).has(name));
        if (!known) free.push(`${name}@${node.loc.start.line}`);
      }
      return;
    }
    for (const [k, c] of children(node)) refs(c, chain, node, k);
  })(ast, [], null, null);
  return free;
}

const files = execFileSync("git", ["ls-files", "-z", "demo/", "scripts/"], {
  encoding: "utf8",
})
  .split("\0")
  .filter((f) => /\.(c|m)?js$/.test(f) && fs.existsSync(f));

let findings = 0;
for (const f of files) {
  let free;
  try {
    free = freeIn(fs.readFileSync(f, "utf8"));
  } catch (e) {
    console.error(
      `::error::free-identifier gate: ${f}: parse error ${e.message}`,
    );
    findings++;
    continue;
  }
  for (const id of free) {
    console.error(
      `::error::free-identifier gate: ${f}: ${id} is never declared or imported (not a global on the allowlist)`,
    );
    findings++;
  }
}
if (findings) {
  console.error(`${findings} finding(s) over ${files.length} files`);
  process.exit(1);
}
console.log(
  `free-identifier gate: ${files.length} .js files under demo/ and scripts/, no free identifier (${GLOBALS.size} allowlisted globals)`,
);
