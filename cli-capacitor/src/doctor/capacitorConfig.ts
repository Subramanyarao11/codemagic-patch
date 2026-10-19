// The app's Capacitor configuration as doctor reads it: statically, never executed
// (specs/doctor/Spec.md › Capacitor discovery, 1). `capacitor.config.json` is data;
// `capacitor.config.ts` / `.js` is parsed with @babel/parser and only literal values are
// taken. Anything computed — an environment variable, an import, a call, a spread — is
// `unresolved`, the way `cmpatch doctor` treats a dynamic Expo `app.config.js`.
//
// The file is chosen as Capacitor's own CLI chooses it (`loadExtConfig` in
// @capacitor/cli's config.ts): `.ts`, else `.js`, else `.json`.

import { join } from "node:path";

import { parse } from "@babel/parser";

import { isRecord } from "../output";
import { readDoctorSource, type Resolution } from "./sources";

export const CONFIG_FILE_NAMES = ["capacitor.config.ts", "capacitor.config.js", "capacitor.config.json"] as const;

/** A setting in the config: its value when it is a literal, else why not. */
export type ConfigLookup =
  | { state: "resolved"; value: unknown }
  | { state: "missing" }
  | { reason: string; state: "invalid" | "unresolved" };

export type CapacitorConfigSource = {
  /** Some value in the config is computed: known only when the app runs. */
  computed: boolean;
  /** Other config files Capacitor ignores because this one takes precedence. */
  ignored: string[];
  read: (path: readonly string[]) => ConfigLookup;
  reason?: string;
  source: string;
  state: Resolution;
};

/** A value known only when the app runs; never guessed. */
const COMPUTED: unique symbol = Symbol("computed");
/** On an object that may hold keys doctor cannot see (a spread, a computed key). */
const OPEN: unique symbol = Symbol("open");

type Node = { [key: string]: unknown; type: string };

/** Expressions that only wrap another for the type checker or for grouping. */
const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion", "TSNonNullExpression", "ParenthesizedExpression"]);

export async function readCapacitorConfig(root: string): Promise<CapacitorConfigSource> {
  const present: Array<{ name: string; doc: Awaited<ReturnType<typeof readDoctorSource>> }> = [];
  for (const name of CONFIG_FILE_NAMES) {
    const doc = await readDoctorSource(join(root, name));
    if (doc.state !== "missing") present.push({ doc, name });
  }
  const selected = present[0];
  const ignored = present.slice(1).map((item) => item.doc.source);
  if (selected === undefined) {
    // Capacitor reads a missing config as `{}` (loadExtConfig): every setting is absent
    // and every default applies, so nothing here is unknown.
    return {
      computed: false,
      ignored,
      read: () => ({ state: "missing" }),
      reason: "not_found",
      source: join(root, "capacitor.config.json"),
      state: "missing",
    };
  }
  const { doc, name } = selected;
  if (doc.state !== "resolved") {
    return {
      computed: false,
      ignored,
      read: () => ({ reason: doc.reason ?? "unreadable", state: "unresolved" }),
      ...(doc.reason ? { reason: doc.reason } : {}),
      source: doc.source,
      state: doc.state,
    };
  }
  let data: unknown;
  try {
    data = name.endsWith(".json") ? JSON.parse(doc.text!) : evaluateConfigModule(doc.text!, name.endsWith(".ts"));
    if (data !== COMPUTED && !isRecord(data)) throw new Error("not an object");
  } catch {
    return {
      computed: false,
      ignored,
      read: () => ({ reason: "malformed_document", state: "invalid" }),
      reason: "malformed_document",
      source: doc.source,
      state: "invalid",
    };
  }
  return {
    computed: isComputed(data),
    ignored,
    read: (path) => lookupJson(data, path),
    source: doc.source,
    state: "resolved",
  };
}

/** A setting of a config read here, or of a parsed JSON config such as a synced copy. */
export function lookupJson(data: unknown, path: readonly string[]): ConfigLookup {
  let current: unknown = data;
  for (const key of path) {
    if (current === COMPUTED) return { reason: "computed_value", state: "unresolved" };
    if (!isRecord(current)) return { state: "missing" };
    if (!Object.hasOwn(current, key)) {
      return (current as { [OPEN]?: boolean })[OPEN] ? { reason: "computed_value", state: "unresolved" } : { state: "missing" };
    }
    current = current[key];
  }
  // An object is returned even when parts of it are computed: a block that exists is
  // evidence of intent, and each of its values is looked up, and judged, on its own.
  if (current === COMPUTED || (!isRecord(current) && isComputed(current)))
    return { reason: "computed_value", state: "unresolved" };
  return current === undefined ? { state: "missing" } : { state: "resolved", value: current };
}

/** Whether a value read from a config holds anything computed, at any depth. */
export function isComputed(value: unknown): boolean {
  if (value === COMPUTED) return true;
  if (Array.isArray(value)) return value.some(isComputed);
  if (isRecord(value)) return (value as { [OPEN]?: boolean })[OPEN] === true || Object.values(value).some(isComputed);
  return false;
}

/**
 * The default export (or `module.exports`) of a config module, as literal data. Throws
 * on a syntax error.
 *
 * A top-level variable is trusted only as far as doctor can see every use of it. Any
 * variable that is assigned to is computed. An object or array is computed too when it
 * is referenced anywhere the evaluation did not itself read it — passed to a call
 * (`Object.assign(config.plugins, ...)`), aliased (`const p = config.plugins`), assigned
 * through (`config.plugins.x = ...`) or deleted from — because any of those may change
 * what is exported. A primitive cannot be changed through a reference, so only
 * assignment counts for it.
 */
function evaluateConfigModule(text: string, typescript: boolean): unknown {
  const ast = parse(text, {
    errorRecovery: false,
    plugins: typescript ? ["typescript"] : [],
    sourceType: "unambiguous",
  });
  const body = ast.program.body as unknown as Node[];
  /** Top-level variables with an initializer, by name. */
  const constants = new Map<string, Node>();
  for (const statement of body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? (statement.declaration as Node | null) : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations as Node[]) {
      const id = declarator.id as Node;
      // `let` and `var` too: an assignment anywhere makes them computed below.
      if (id.type === "Identifier" && declarator.init) constants.set(id.name as string, declarator.init as Node);
    }
  }

  let exported: Node | undefined;
  for (const statement of body) {
    if (statement.type === "ExportDefaultDeclaration") exported = statement.declaration as Node;
    if (statement.type === "ExpressionStatement") {
      const expression = statement.expression as Node;
      if (expression.type === "AssignmentExpression" && isModuleExports(expression.left as Node))
        exported = expression.right as Node;
    }
  }
  if (exported === undefined) return COMPUTED;

  const references = collectReferences(ast.program as unknown as Node);
  const tainted = new Set([...references].filter(([, uses]) => uses.some((use) => use.write)).map(([name]) => name));
  // Each round trusts less; a fixed point is reached in a few, and the cap is a guard.
  for (let round = 0; round < 8; round++) {
    const context: Evaluation = { constants, consumed: new Set(), tainted, used: new Set() };
    const value = evaluate(exported, context, 0);
    const escaped = [...context.used].filter(
      (name) =>
        isMutable(name, constants) &&
        (references.get(name) ?? []).some((use) => !context.consumed.has(use.node)),
    );
    if (escaped.length === 0) return value;
    for (const name of escaped) tainted.add(name);
  }
  return COMPUTED;
}

type Evaluation = {
  constants: Map<string, Node>;
  /** Identifier nodes the evaluation read: the uses doctor accounts for. */
  consumed: Set<Node>;
  /** Variables that may not hold their initializer any more. */
  tainted: Set<string>;
  /** Variables the evaluation resolved through their initializer. */
  used: Set<string>;
};

function evaluate(node: Node, context: Evaluation, depth: number): unknown {
  if (depth > 32) return COMPUTED;
  const next = (child: Node) => evaluate(child, context, depth + 1);
  if (WRAPPERS.has(node.type)) return next(node.expression as Node);
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
      return node.value;
    case "NullLiteral":
      return null;
    case "TemplateLiteral":
      return (node.expressions as Node[]).length === 0
        ? ((node.quasis as Array<{ value: { cooked: string | null } }>)[0]?.value.cooked ?? COMPUTED)
        : COMPUTED;
    case "UnaryExpression": {
      const argument = next(node.argument as Node);
      return node.operator === "-" && typeof argument === "number" ? -argument : COMPUTED;
    }
    case "Identifier": {
      context.consumed.add(node);
      const name = node.name as string;
      if (name === "undefined" && !context.constants.has(name)) return undefined;
      const init = context.constants.get(name);
      if (!init || context.tainted.has(name)) return COMPUTED;
      context.used.add(name);
      return next(init);
    }
    case "ArrayExpression":
      return (node.elements as Array<Node | null>).map((element) =>
        element === null || element.type === "SpreadElement" ? COMPUTED : next(element),
      );
    case "ObjectExpression": {
      const result: Record<string | symbol, unknown> = {};
      for (const property of node.properties as Node[]) {
        const key = property.type === "SpreadElement" ? undefined : propertyKey(property);
        if (key === undefined) {
          // A spread or a computed key may add or replace any key, even ones listed
          // before it: the whole object is open, and what it lists is not final.
          result[OPEN] = true;
          continue;
        }
        result[key] = property.type === "ObjectProperty" ? next(property.value as Node) : COMPUTED;
      }
      if (result[OPEN]) for (const key of Object.keys(result)) result[key] = COMPUTED;
      return result;
    }
    default:
      return COMPUTED;
  }
}

/**
 * Whether a variable holds something a reference can change: an object or array, or an
 * alias of one (`const config = base`), since a change through the alias changes it.
 */
function isMutable(name: string, constants: Map<string, Node>, depth = 0): boolean {
  let node = constants.get(name);
  while (node && WRAPPERS.has(node.type)) node = node.expression as Node;
  if (node?.type === "Identifier") return depth < 32 && isMutable(node.name as string, constants, depth + 1);
  return node?.type === "ObjectExpression" || node?.type === "ArrayExpression";
}

type Reference = { node: Node; write: boolean };

/** Every use of every name in the module, and whether it assigns to it. */
function collectReferences(program: Node): Map<string, Reference[]> {
  const references = new Map<string, Reference[]>();
  const walk = (node: unknown, parent: Node | undefined, key: string | undefined): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, parent, key);
      return;
    }
    if (!isRecord(node) || typeof node.type !== "string") return;
    const current = node as Node;
    if (current.type === "Identifier" && parent && isReference(parent, key)) {
      const write =
        (parent.type === "AssignmentExpression" && key === "left") ||
        (parent.type === "UpdateExpression" && key === "argument");
      const uses = references.get(current.name as string) ?? [];
      uses.push({ node: current, write });
      references.set(current.name as string, uses);
    }
    for (const [childKey, value] of Object.entries(current)) {
      // Type annotations name types, not variables.
      if (TYPE_KEYS.has(childKey) || childKey === "loc" || value === null || typeof value !== "object") continue;
      walk(value, current, childKey);
    }
  };
  walk(program, undefined, undefined);
  return references;
}

const TYPE_KEYS = new Set(["typeAnnotation", "typeParameters", "returnType", "superTypeParameters", "implements"]);

/** Whether an identifier in this position names a variable (rather than a key or a declaration). */
function isReference(parent: Node, key: string | undefined): boolean {
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && key === "property")
    return parent.computed === true;
  if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod" || parent.type === "ClassProperty") && key === "key")
    return parent.computed === true;
  if (parent.type === "VariableDeclarator" && key === "id") return false;
  if (/Function|ClassDeclaration|ClassExpression|Method/.test(parent.type) && (key === "id" || key === "params")) return false;
  if (/^Import|^Export.*Specifier$|^Labeled|^Break|^Continue/.test(parent.type)) return false;
  return !parent.type.startsWith("TS") || WRAPPERS.has(parent.type);
}

function propertyKey(property: Node): string | undefined {
  const key = property.key as Node;
  if (!property.computed && key.type === "Identifier") return key.name as string;
  if (key.type === "StringLiteral") return key.value as string;
  if (key.type === "NumericLiteral") return String(key.value);
  return undefined;
}

function isModuleExports(node: Node): boolean {
  if (node.type !== "MemberExpression" || node.computed) return false;
  const object = node.object as Node;
  const property = node.property as Node;
  return (
    (object.type === "Identifier" && object.name === "module" && property.name === "exports") ||
    (object.type === "Identifier" && object.name === "exports" && property.name === "default")
  );
}
