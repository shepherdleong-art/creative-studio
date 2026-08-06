import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = path.join(repoRoot, 'app', 'api');

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOCKED_EXEMPTIONS = new Set([
  'POST app/api/provisioning/route.ts',
  'POST app/api/company-provider/start/route.ts',
  'POST app/api/shutdown/route.ts',
]);
const ACTION_ROUTES = new Map([
  ['app/api/batch-production/batches/[id]/control/route.ts', {
    safe: ['pause', 'stop'],
    ready: 'resume',
    resumeCall: 'resumeBatch',
    safeCalls: ['pauseBatch', 'stopBatch'],
    branch: /if\s*\(\s*action\s*!==\s*['"]pause['"]\s*&&\s*action\s*!==\s*['"]stop['"]\s*\)/,
  }],
  ['app/api/batch-production/tasks/[taskId]/control/route.ts', {
    safe: ['pause', 'cancel'],
    ready: 'resume',
    resumeCall: 'resumeTask',
    safeCalls: ['pauseTask', 'cancelTask'],
    branch: /if\s*\(\s*action\s*===\s*['"]resume['"]\s*\)/,
  }],
]);
const SIDE_EFFECT_MARKERS = [
  'await request.json',
  'request.formData',
  'request.arrayBuffer',
  'file.arrayBuffer',
  'arrayBuffer(',
  'await context.params',
  'await params',
  'request.nextUrl',
  'getDb(',
  'dataRoot(',
  'path.join(',
  'db.prepare',
  'db.transaction',
  'fs.writeFile',
  'fs.mkdir',
  'fs.existsSync',
  'fs.readFile',
  'fs.copyFile',
  'fs.rename',
  'fs.rm',
  'fs.unlink',
  'writeFileSync',
  'mkdirSync',
  'unlinkSync',
  'renameSync',
  'spawn(',
  'execFile(',
  'assertBatchApiReady(',
  'prepareBatchProductionInputs(',
  'runQueue(',
  'runVideoQueue(',
  'pauseQueue(',
  'resumeQueue(',
  'cancelQueue(',
  'ensureBatchSchedulerStarted(',
  'wakeFinalEditWorker(',
  'recoverFinalEditPrepareJobs(',
  'enqueueRender(',
  'synthesize(',
  'analyzeVideo(',
];
const GET_SIDE_EFFECT_CALLS = new Set([
  'ensureBatchSchedulerStarted',
  'recoverFinalEditPrepareJobs',
  'wakeFinalEditWorker',
  'prepareBatchProductionInputs',
  'enqueueRender',
  'synthesize',
  'analyzeVideo',
  'fs.writeFile',
  'fs.writeFileSync',
  'fs.mkdir',
  'fs.mkdirSync',
  'fs.copyFile',
  'fs.copyFileSync',
  'fs.rename',
  'fs.renameSync',
  'fs.rm',
  'fs.rmSync',
  'fs.unlink',
  'fs.unlinkSync',
  'writeFileSync',
  'mkdirSync',
  'renameSync',
  'unlinkSync',
]);

function firstIndex(source, markers) {
  let best = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

function getSideEffectCalls(handler) {
  return (handler.calls || []).filter(({ callee }) => GET_SIDE_EFFECT_CALLS.has(callee));
}

function callPositions(handler, names, awaitedOnly = false) {
  const allowed = new Set(names);
  return (handler.calls || [])
    .filter((call) => allowed.has(call.callee) && (!awaitedOnly || call.awaited))
    .map((call) => call.start)
    .sort((a, b) => a - b);
}

function callPositionContaining(handler, names, needle) {
  const allowed = new Set(names);
  return (handler.calls || [])
    .filter((call) => allowed.has(call.callee) && call.text.includes(needle))
    .map((call) => call.start)
    .sort((a, b) => a - b);
}

function astContainsPropertyAccess(node, objectName, propertyName) {
  let found = false;
  const visit = (child) => {
    if (ts.isPropertyAccessExpression(child)
      && ts.isIdentifier(child.expression)
      && child.expression.text === objectName
      && child.name.text === propertyName) {
      found = true;
    }
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

function astIsPropertyAccess(node, objectName, propertyName) {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === objectName
    && node.name.text === propertyName;
}

function astContainsIdentifier(node, name) {
  let found = false;
  const visit = (child) => {
    if (ts.isIdentifier(child) && child.text === name) found = true;
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

function astContainsNegatedIdentifier(node, name) {
  let found = false;
  const visit = (child) => {
    if (ts.isPrefixUnaryExpression(child)
      && child.operator === ts.SyntaxKind.ExclamationToken
      && ts.isIdentifier(child.operand)
      && child.operand.text === name) found = true;
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

function astContainsNegatedPropertyAccess(node, objectName, propertyName) {
  let found = false;
  const visit = (child) => {
    if (ts.isPrefixUnaryExpression(child)
      && child.operator === ts.SyntaxKind.ExclamationToken
      && ts.isPropertyAccessExpression(child.operand)
      && ts.isIdentifier(child.operand.expression)
      && child.operand.expression.text === objectName
      && child.operand.name.text === propertyName) found = true;
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

function astContainsStringLiteral(node, value) {
  let found = false;
  const visit = (child) => {
    if ((ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) && child.text === value) found = true;
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

function actionSchedulerErrors(record, config) {
  const failures = [];
  const schedulerCalls = callPositions(record, ['ensureBatchSchedulerStarted']);
  const readinessCalls = callPositions(record, ['assertBatchApiReady']);
  const resumeCalls = callPositions(record, [config.resumeCall]);
  const controlCalls = callPositions(record, config.safeCalls.concat([config.resumeCall]));
  if (schedulerCalls.length !== 1) failures.push('action control must call scheduler start exactly once');
  if (!readinessCalls.length) failures.push('action control must retain batch readiness assertion');
  if (!controlCalls.length || !readinessCalls.length || readinessCalls[0] > controlCalls[0]) {
    failures.push('batch readiness must precede safe and resume state transitions');
  }
  const resumeBranchIndex = record.body.search(/(?:else\s+)?if\s*\(\s*action\s*===\s*[']resume[']\s*\)/);
  if (resumeBranchIndex < 0) failures.push('resume branch not found');
  if (schedulerCalls.length === 1 && (resumeBranchIndex < 0 || schedulerCalls[0] <= resumeBranchIndex)) {
    failures.push('scheduler start must be inside the ready resume branch');
  }
  if (schedulerCalls.length === 1 && resumeCalls.length === 1 && schedulerCalls[0] <= resumeCalls[0]) {
    failures.push('resume state transition must precede scheduler start');
  }
  if (schedulerCalls.length === 1 && record.calls.some((call) => config.safeCalls.includes(call.callee) && call.start > schedulerCalls[0])) {
    // A call after scheduler start can be in an else branch, but the exact
    // branch contract is still checked by the scheduler call's resume region.
    const trailingSafe = record.calls.find((call) => config.safeCalls.includes(call.callee) && call.start > schedulerCalls[0]);
    if (trailingSafe && !record.body.slice(schedulerCalls[0], trailingSafe.start).includes('} else')) {
      failures.push('safe action must not share the scheduler start branch');
    }
  }
  return failures;
}

function walkRoutes(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkRoutes(absolute));
    else if (entry.isFile() && entry.name === 'route.ts') result.push(absolute);
  }
  return result.sort();
}

function parseImportBindings(sourceFile) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) bindings.set(clause.name.text, { moduleName, importedName: 'default' });
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings.set(clause.namedBindings.name.text, { moduleName, importedName: '*' });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, {
          moduleName,
          importedName: element.propertyName?.text || element.name.text,
        });
      }
    }
  }
  return bindings;
}

function astPropertyName(property, sourceFile) {
  if (!property.name) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) {
    return property.name.text;
  }
  return property.name.getText(sourceFile);
}

function astObjectProperties(node, sourceFile) {
  if (!ts.isObjectLiteralExpression(node)) return [];
  return node.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [];
    const name = astPropertyName(property, sourceFile);
    if (!name) return [];
    const value = ts.isStringLiteral(property.initializer) || ts.isNoSubstitutionTemplateLiteral(property.initializer)
      ? property.initializer.text
      : null;
    return [{ name, value }];
  });
}

function astObjectPropertyTree(node, sourceFile) {
  if (!ts.isObjectLiteralExpression(node)) return null;
  return {
    start: node.getStart(sourceFile),
    properties: node.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property)) return [];
      const name = astPropertyName(property, sourceFile);
      if (!name) return [];
      return [{
        name,
        initializerText: property.initializer.getText(sourceFile),
        object: astObjectPropertyTree(property.initializer, sourceFile),
      }];
    }),
  };
}

function astCallRecord(node, sourceFile, baseStart) {
  const expression = node.expression;
  const callee = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
      ? `${expression.expression.getText(sourceFile)}.${expression.name.text}`
      : null;
  if (!callee) return null;
  return {
    callee,
    start: node.getStart(sourceFile) - baseStart,
    end: node.getEnd() - baseStart,
    awaited: ts.isAwaitExpression(node.parent),
    text: node.getText(sourceFile),
    argumentTexts: node.arguments.map((argument) => argument.getText(sourceFile)),
    literalArguments: node.arguments
      .filter((argument) => ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
      .map((argument) => argument.text),
    argumentObjectProperties: node.arguments.flatMap((argument) => astObjectProperties(argument, sourceFile)),
  };
}

function astAssignmentRecord(node, sourceFile, baseStart) {
  const isDeclaration = ts.isVariableDeclaration(node);
  const isAssignment = ts.isBinaryExpression(node)
    && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(node.left);
  if (!isDeclaration && !isAssignment) return null;
  const nameNode = isDeclaration ? node.name : node.left;
  if (!ts.isIdentifier(nameNode)) return null;
  const initializer = isDeclaration ? node.initializer : node.right;
  if (!initializer) return null;
  return {
    node,
    name: nameNode.text,
    start: node.getStart(sourceFile) - baseStart,
    initializer,
    initializerText: initializer.getText(sourceFile),
    initializerCallee: ts.isCallExpression(initializer)
      ? astCallRecord(initializer, sourceFile, baseStart)?.callee || null
      : null,
    initializerObject: astObjectPropertyTree(initializer, sourceFile),
  };
}

function functionNodeName(node) {
  if (ts.isFunctionDeclaration(node)) return node.name?.text || null;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return null;
}

function collectFunctionScopes(root, sourceFile, baseStart) {
  const functions = [];
  const visitFunction = (node) => {
    const isFunction = ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node);
    if (isFunction && node.body) {
      const calls = [];
      const assignments = [];
      const objectLiterals = [];
      const visitScope = (child) => {
        if (ts.isCallExpression(child)) {
          const call = astCallRecord(child, sourceFile, baseStart);
          if (call) calls.push(call);
        }
        if (ts.isObjectLiteralExpression(child)) {
          const tree = astObjectPropertyTree(child, sourceFile);
          if (tree) objectLiterals.push(tree);
        }
        if (ts.isVariableDeclaration(child) || ts.isBinaryExpression(child)) {
          const assignment = astAssignmentRecord(child, sourceFile, baseStart);
          if (assignment) assignments.push(assignment);
        }
        child.forEachChild(visitScope);
      };
      visitScope(node.body);
      functions.push({
        name: functionNodeName(node),
        start: node.getStart(sourceFile) - baseStart,
        bodyStart: node.body.getStart(sourceFile) - baseStart,
        bodyEnd: node.body.getEnd() - baseStart,
        calls,
        assignments,
        objectLiterals,
      });
    }
    node.forEachChild(visitFunction);
  };
  root.forEachChild(visitFunction);
  return functions;
}

function collectIfStatements(root, sourceFile, baseStart) {
  const statements = [];
  const visit = (node) => {
    if (ts.isIfStatement(node)) {
      statements.push({
        node,
        start: node.getStart(sourceFile) - baseStart,
        end: node.getEnd() - baseStart,
        text: node.getText(sourceFile),
      });
    }
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return statements;
}

function collectCatchClauses(root, sourceFile, baseStart) {
  const catches = [];
  const visit = (node) => {
    if (ts.isCatchClause(node)) {
      const variableName = node.variableDeclaration?.name;
      catches.push({
        node,
        start: node.getStart(sourceFile) - baseStart,
        end: node.getEnd() - baseStart,
        variableName: variableName && ts.isIdentifier(variableName)
          ? variableName.text
          : null,
        text: node.getText(sourceFile),
      });
    }
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return catches;
}

function parseHandlers(source) {
  const sourceFile = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = parseImportBindings(sourceFile);
  const handlers = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.body || !statement.name) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const method = statement.name.text;
    if (!exported || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;
    const bodyStart = statement.body.getStart(sourceFile);
    const calls = [];
    const objectPropertyNames = [];
    const assignments = [];
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) objectPropertyNames.push(...astObjectProperties(node, sourceFile).map(({ name }) => name));
      if (ts.isVariableDeclaration(node) || ts.isBinaryExpression(node)) {
        const assignment = astAssignmentRecord(node, sourceFile, bodyStart);
        if (assignment) assignments.push(assignment);
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const callee = ts.isIdentifier(expression)
          ? expression.text
          : ts.isPropertyAccessExpression(expression)
            ? `${expression.expression.getText(sourceFile)}.${expression.name.text}`
            : null;
        if (callee) calls.push({
          node,
          callee,
          start: node.getStart(sourceFile) - bodyStart,
          awaited: ts.isAwaitExpression(node.parent),
          text: node.getText(sourceFile),
          end: node.getEnd() - bodyStart,
          argumentTexts: node.arguments.map((argument) => argument.getText(sourceFile)),
          literalArguments: node.arguments
            .filter((argument) => ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
            .map((argument) => argument.text),
          argumentObjectProperties: node.arguments.flatMap((argument) => astObjectProperties(argument, sourceFile)),
        });
      }
      node.forEachChild(visit);
    };
    visit(statement.body);
    handlers.push({
      method,
      start: statement.getStart(sourceFile),
      imports,
      calls,
      functions: collectFunctionScopes(statement.body, sourceFile, bodyStart),
      assignments,
      objectPropertyNames,
      ifStatements: collectIfStatements(statement.body, sourceFile, bodyStart),
      catchClauses: collectCatchClauses(statement.body, sourceFile, bodyStart),
      statementMetadata: statement.body.statements.map((child) => ({
        node: child,
        start: child.getStart(sourceFile) - bodyStart,
        end: child.getEnd() - bodyStart,
      })),
      body: statement.body.getText(sourceFile),
      statements: statement.body.statements
        .filter((child) => !(ts.isExpressionStatement(child) && ts.isStringLiteral(child.expression)))
        .map((child) => child.getText(sourceFile)),
    });
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const method = declaration.name.text;
      const initializer = declaration.initializer;
      const body = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ? initializer.body
        : null;
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !body) continue;
      const bodyStart = body.getStart(sourceFile);
      const bodyStatements = ts.isBlock(body) ? body.statements : [];
    const calls = [];
    const objectPropertyNames = [];
    const assignments = [];
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) objectPropertyNames.push(...astObjectProperties(node, sourceFile).map(({ name }) => name));
      if (ts.isVariableDeclaration(node) || ts.isBinaryExpression(node)) {
        const assignment = astAssignmentRecord(node, sourceFile, bodyStart);
        if (assignment) assignments.push(assignment);
      }
        if (ts.isCallExpression(node)) {
          const expression = node.expression;
          const callee = ts.isIdentifier(expression)
            ? expression.text
            : ts.isPropertyAccessExpression(expression)
              ? `${expression.expression.getText(sourceFile)}.${expression.name.text}`
              : null;
          if (callee) calls.push({
            node,
            callee,
            start: node.getStart(sourceFile) - bodyStart,
            awaited: ts.isAwaitExpression(node.parent),
            text: node.getText(sourceFile),
            end: node.getEnd() - bodyStart,
            argumentTexts: node.arguments.map((argument) => argument.getText(sourceFile)),
            literalArguments: node.arguments
              .filter((argument) => ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
              .map((argument) => argument.text),
            argumentObjectProperties: node.arguments.flatMap((argument) => astObjectProperties(argument, sourceFile)),
          });
        }
        node.forEachChild(visit);
      };
      visit(body);
      handlers.push({
        method,
        start: statement.getStart(sourceFile),
        imports,
      calls,
      functions: collectFunctionScopes(body, sourceFile, bodyStart),
      assignments,
      objectPropertyNames,
      ifStatements: collectIfStatements(body, sourceFile, bodyStart),
      catchClauses: collectCatchClauses(body, sourceFile, bodyStart),
      statementMetadata: bodyStatements.map((child) => ({
        node: child,
        start: child.getStart(sourceFile) - bodyStart,
        end: child.getEnd() - bodyStart,
      })),
      body: body.getText(sourceFile),
        statements: bodyStatements
          .filter((child) => !(ts.isExpressionStatement(child) && ts.isStringLiteral(child.expression)))
          .map((child) => child.getText(sourceFile)),
      });
    }
  }
  return handlers;
}

const SHARED_GUARD_NAMES = ['guardManagedWorkbench', 'requireManagedWorkbenchReady', 'managedWorkbenchGuard', 'assertManagedWorkbenchApiReady'];
const PROVIDER_GUARD_NAMES = ['managedProviderMutationResponse', 'assertManagedProviderReadOnly', 'guardManagedProviderReadOnly'];
const SHARED_GUARD_MODULE = '@/app/api/managed-deployment/guard';
const PROVIDER_GUARD_MODULE = '@/lib/managed-provider-policy';

function importedLocalNames(record, moduleName, importedNames) {
  const allowed = new Set(importedNames);
  return [...(record.imports || [])]
    .filter(([, binding]) => binding.moduleName === moduleName && allowed.has(binding.importedName))
    .map(([localName]) => localName);
}

function declarationGuard(statement, names, requireAwait = true) {
  if (!statement) return null;
  const namesPattern = names.join('|');
  const awaitPrefix = requireAwait ? 'await\\s+' : '(?:await\\s+)?';
  const match = new RegExp(`^\\s*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${awaitPrefix}(?:${namesPattern})\\s*\\(`).exec(statement);
  return match?.[1] || null;
}

function immediateGuardReturn(statement, variable, provider = false) {
  if (!statement || !variable) return false;
  const escaped = variable.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&');
  if (provider) return new RegExp(`^\\s*if\\s*\\(\\s*${escaped}\\s*\\)\\s*(?:\\{\\s*)?return\\b`).test(statement);
  return new RegExp(`^\\s*if\\s*\\(\\s*${escaped}\\s*\\)\\s*return\\s+${escaped}\\s*;?\\s*$`).test(statement);
}

function hasSharedGuardPrelude(handler, names = SHARED_GUARD_NAMES) {
  const variable = declarationGuard(handler.statements?.[0], names);
  return Boolean(variable && immediateGuardReturn(handler.statements?.[1], variable));
}

function hasProviderGuardPrelude(handler, names = PROVIDER_GUARD_NAMES) {
  const variable = declarationGuard(handler.statements?.[0], names, false);
  return Boolean(variable && immediateGuardReturn(handler.statements?.[1], variable, true));
}

function hasActionGuardPrelude(handler, config, names = SHARED_GUARD_NAMES) {
  const statements = handler.statements || [];
  if (statements.length < 4) return false;
  if (!/await\s+request\.json\s*\(/.test(statements[0])) return false;
  if (!/\b(?:const|let|var)\s+action\s*=\s*body\??\.action\b/.test(statements[1])) return false;
  if (!/\bif\s*\(\s*action\s*!==/.test(statements[2]) || !/invalid_action/.test(statements[2])) return false;
  if (!config.branch.test(statements[3])) return false;
  return new RegExp(`\\b(?:${names.join('|')})\\s*\\(`).test(statements[3]);
}

// Synthetic failure regression: an arbitrary call before the guard must not
// be treated as covered merely because the handler contains a later guard.
const syntheticBad = parseHandlers(`export async function POST() {
  doSideEffect();
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
}`);
assert.equal(hasSharedGuardPrelude(syntheticBad[0]), false, 'synthetic pre-guard side effect regression');
const syntheticBadAction = parseHandlers(`export async function POST(request: Request) {
  const body = await request.json();
  const action = body?.action;
  if (action !== 'pause' && action !== 'resume') return new Response('invalid_action');
  doSideEffect();
  if (action === 'resume') { const managedGuard = await guardManagedWorkbench(); if (managedGuard) return managedGuard; }
}`);
assert.equal(hasActionGuardPrelude(syntheticBadAction[0], { branch: /action\\s*===\\s*['"]resume['"]/, safe: [], ready: 'resume' }), false, 'synthetic action pre-guard side effect regression');
const syntheticResume = parseHandlers(`export async function POST() {
  const assertImageExecution = async () => {};
  await adapter.poll();
}`);
assert.equal(/await\s+assertImageExecution\s*\(\s*\)/.test(syntheticResume[0].body), false, 'synthetic resume helper-not-called regression');

// Synthetic regression: AST boundaries must survive regex literals, template
// substitutions and braces in a parameter type without joining two handlers.
const syntheticHandlers = parseHandlers(`
  export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    const re = /[{}]/g;
    const template = \`value: \${'{'}\`;
    return re.test(template) ? new Response('get') : new Response('get');
  }
  export async function POST() { return new Response('post'); }
`);
assert.equal(syntheticHandlers.length, 2, 'synthetic handler parser regression');
assert.match(syntheticHandlers[0].body, /const re = \/\[\{\}\]\//);
assert.doesNotMatch(syntheticHandlers[0].body, /Response\('post'\)/);
const syntheticExportHandler = parseHandlers(`export const POST = async () => {
  return new Response('post');
}`);
assert.equal(syntheticExportHandler.length, 1, 'synthetic export const handler discovery regression');
assert.equal(hasSharedGuardPrelude(syntheticExportHandler[0]), false, 'synthetic export const missing guard regression');
const syntheticExpressionHandler = parseHandlers('export const GET = () => new Response(\'expression\');');
assert.equal(syntheticExpressionHandler.length, 1, 'synthetic expression-bodied export const discovery regression');
assert.equal(hasSharedGuardPrelude(syntheticExpressionHandler[0]), false, 'synthetic expression-bodied export const missing guard regression');
const syntheticFakeGuard = parseHandlers(`export async function POST() {
  const fake = 'guardManagedWorkbench()';
  // guardManagedWorkbench() is only a comment.
  return new Response(fake);
}`);
assert.equal(hasSharedGuardPrelude(syntheticFakeGuard[0]), false, 'synthetic fake guard regression');
const syntheticAliasGuard = parseHandlers(`import { guardManagedWorkbench as gm } from '@/app/api/managed-deployment/guard';
export async function POST() {
  const managedGuard = await gm();
  if (managedGuard) return managedGuard;
}`);
const syntheticAliasNames = importedLocalNames(syntheticAliasGuard[0], SHARED_GUARD_MODULE, SHARED_GUARD_NAMES);
assert.deepEqual(syntheticAliasNames, ['gm'], 'synthetic guard import alias regression');
assert.equal(hasSharedGuardPrelude(syntheticAliasGuard[0], syntheticAliasNames), true, 'synthetic guard alias prelude regression');

function executionResumeBoundaryErrors(handler, kind, helperName, stages) {
  const body = handler.body;
  const failures = [];
  const helperScope = (handler.functions || []).find((scope) => scope.name === helperName);
  const identityScope = stages.identityFunction
    ? (handler.functions || []).find((scope) => scope.name === stages.identityFunction)
    : null;
  const currentReadScopes = (stages.currentReadFunctions || []).map((name) => (
    (handler.functions || []).find((scope) => scope.name === name)
  )).filter(Boolean);
  const gateNames = importedLocalNames(handler, '@/lib/provider-execution-gate', ['assertProviderExecutionAvailable']);
  const stabilityNames = importedLocalNames(handler, '@/lib/provider-execution-gate', ['assertProviderExecutionIdentityStable']);
  const generationNames = importedLocalNames(handler, '@/lib/provider-execution-gate', ['readManagedExecutionGeneration']);
  if (!gateNames.length || !callPositions(handler, gateNames).length) failures.push('missing provider execution gate import/call');
  if (!(handler.calls || []).some((call) => gateNames.includes(call.callee)
    && call.argumentObjectProperties?.some(({ name, value }) => name === 'kind' && value === kind))) {
    failures.push(`missing provider execution kind '${kind}'`);
  }
  if (!stabilityNames.length || !callPositions(handler, stabilityNames).length) failures.push('missing provider snapshot stability helper import/call');
  if (!generationNames.length || !callPositions(handler, generationNames).length) failures.push('missing managed provisioning generation helper import/call');
  if (!(handler.objectPropertyNames || []).includes('enabled')) failures.push('provider identity must include enabled state');
  if (!(handler.objectPropertyNames || []).includes('managedGeneration')) failures.push('provider identity must include managed provisioning generation');
  const providerReload = (handler.calls || []).some((call) => call.callee === 'db.prepare'
    && call.literalArguments?.some((value) => /FROM\s+(?:providers|video_providers)\b/i.test(value)));
  if (!providerReload) failures.push('missing current provider DB reload');

  if (!helperScope) {
    failures.push(`${helperName} helper function body was not discovered`);
  }
  if (!identityScope) {
    failures.push(`${stages.identityFunction || 'provider identity'} helper function body was not discovered`);
  }
  if (!currentReadScopes.length || currentReadScopes.some((scope) => !scope.calls.some((call) => (
    call.callee === 'db.prepare'
      && call.literalArguments?.some((value) => {
        const upper = value.toUpperCase();
        return upper.includes('FROM PROVIDERS') || upper.includes('FROM VIDEO_PROVIDERS');
      })
  )))) {
    failures.push('current provider reload helper must contain an actual provider DB query');
  }
  const identityTrees = identityScope?.objectLiterals || [];
  const assignedIdentityObject = identityScope?.assignments
    .find((assignment) => assignment.name === 'identity')?.initializerObject;
  const returnedIdentityObject = identityTrees
    .map((tree) => tree.properties.find(({ name }) => name === 'identity')?.object)
    .find(Boolean);
  const identityObject = assignedIdentityObject || returnedIdentityObject;
  const identityPropertyNames = new Set(identityObject?.properties.map(({ name }) => name) || []);
  if (!identityObject || !identityPropertyNames.has('enabled') || !identityPropertyNames.has('managedGeneration')) {
    failures.push('managed identity object must own enabled and managedGeneration');
  }
  if (!identityScope?.calls.some((call) => generationNames.includes(call.callee))) {
    failures.push('managed identity helper must read provisioning generation');
  }

  const resumeGateCalls = callPositions(handler, [helperName], true);
  if (resumeGateCalls.length < 3) {
    failures.push(`${helperName} must be called at least three times (initial, poll, download)`);
    return failures;
  }

  const initialCallTargets = stages.initialCalls
    ? (stages.initialText?.length
      ? callPositionContaining(handler, stages.initialCalls, stages.initialText[0])
      : callPositions(handler, stages.initialCalls))
    : [];
  const pollTargets = callPositions(handler, stages.pollCalls);
  const downloadTargets = callPositions(handler, stages.downloadCalls);
  const initialTarget = initialCallTargets.length ? initialCallTargets[0] : firstIndex(body, stages.initialText);
  const firstPollTarget = pollTargets.length ? pollTargets[0] : -1;
  const lastPollTarget = pollTargets.length ? pollTargets.at(-1) : -1;
  const firstDownloadTarget = downloadTargets.length ? downloadTargets[0] : -1;
  if (initialTarget < 0) failures.push('missing initial execution-boundary target');
  if (firstPollTarget < 0) failures.push('missing poll execution-boundary target');
  if (firstDownloadTarget < 0) failures.push('missing download execution-boundary target');
  if (initialTarget < 0 || firstPollTarget < 0 || firstDownloadTarget < 0) return failures;

  if (!helperScope) return failures;
  const helperReadCalls = helperScope.calls
    .filter((call) => (stages.currentReadCalls || []).includes(call.callee))
    .map((call) => call.start)
    .sort((a, b) => a - b);
  const helperGateCalls = helperScope.calls
    .filter((call) => gateNames.includes(call.callee) && call.awaited)
    .filter((call) => call.start > (helperReadCalls[0] ?? -1))
    .map((call) => call.start)
    .sort((a, b) => a - b);
  const helperStabilityCalls = helperScope.calls
    .filter((call) => stabilityNames.includes(call.callee))
    .map((call) => call.start)
    .sort((a, b) => a - b);
  const helperIdentityCalls = helperScope.calls
    .filter((call) => call.callee === stages.identityFunction)
    .map((call) => call.start)
    .sort((a, b) => a - b);
  if (helperReadCalls.length < 2) failures.push('execution helper must reload provider before and after its awaited gate');
  if (helperGateCalls.length < 1) failures.push('execution helper must await the imported provider gate');
  if (helperStabilityCalls.length < 2) failures.push('execution helper must compare both pre and post provider identities');
  if (helperIdentityCalls.length < 2) failures.push('execution helper must build identities from both pre and post provider rows');
  if (helperReadCalls.length >= 2 && helperGateCalls.length >= 1 && helperStabilityCalls.length >= 2 && helperIdentityCalls.length >= 2) {
    if (!(helperReadCalls[0] < helperIdentityCalls[0]
      && helperIdentityCalls[0] < helperStabilityCalls[0]
      && helperStabilityCalls[0] < helperGateCalls[0]
      && helperGateCalls[0] < helperReadCalls[1]
      && helperReadCalls[1] < helperIdentityCalls[1]
      && helperIdentityCalls[1] < helperStabilityCalls[1])) {
      failures.push('execution helper order must be pre reload → stability → awaited gate → post reload → stability');
    }
  }
  const postRead = helperReadCalls[1] ?? -1;
  const postStability = helperStabilityCalls[1] ?? -1;
  const postAssignments = helperScope.assignments.filter((assignment) => (
    (stages.postAssignments || []).includes(assignment.name)
      && assignment.start > postStability
      && assignment.start > postRead
      && assignment.initializerText.includes(stages.postValue)
  ));
  if (!postAssignments.length) failures.push('adapter credentials/runtime must be assigned from the post-gate provider snapshot');

  const initialGate = resumeGateCalls[0];
  if (initialGate >= initialTarget) failures.push('initial gate must precede startup/adapter setup');

  // A resume handler may have a direct remote-image branch before the task
  // polling branch. Do not assume fixed gate indexes: choose the nearest gate
  // for each boundary so both branches retain their own checks.
  const gatesBefore = (target, minimum = initialGate) => resumeGateCalls
    .filter((gate) => gate > minimum && gate < target)
    .sort((a, b) => a - b);
  const pollGate = gatesBefore(firstPollTarget).at(-1) ?? -1;
  if (pollGate < 0 || pollGate <= initialTarget) {
    failures.push('poll gate must follow startup/adapter setup and precede the first poll');
  }
  failures.push(...pollGatePlacementErrors(handler, helperName, stages.pollCalls, initialGate));
  for (const downloadTarget of downloadTargets) {
    const minimum = downloadTarget > lastPollTarget ? lastPollTarget : initialGate;
    if (!gatesBefore(downloadTarget, minimum).length) {
      failures.push('every download call must have a preceding download gate');
    }
  }
  for (const call of (handler.calls || []).filter((candidate) => (stages.snapshotPollCalls || []).includes(candidate.callee))) {
    if (!(call.argumentTexts || []).some((argument) => argument.includes(stages.snapshotPollValue))) {
      failures.push('poll adapter must receive the post-gate provider credential/runtime source');
    }
  }
  for (const call of (handler.calls || []).filter((candidate) => (stages.snapshotDownloadCalls || []).includes(candidate.callee))) {
    if (!(call.argumentTexts || []).some((argument) => argument.includes(stages.snapshotDownloadValue))) {
      failures.push('download adapter must receive the post-gate provider credential/runtime source');
    }
  }
  return failures;
}

function videoKlingTokenErrors(handler) {
  const failures = [];
  const tokenNames = importedLocalNames(handler, '@/lib/video-providers/kling', ['getKlingToken']);
  if (!tokenNames.length) failures.push('Kling token helper must be imported from the video provider module');
  const tokenAssignments = (handler.assignments || []).filter((assignment) => (
    assignment.name === 'apiKey' && tokenNames.includes(assignment.initializerCallee)
  ));
  if (tokenAssignments.length !== 1) {
    failures.push('external Kling token must be assigned exactly once');
    return failures;
  }
  const tokenAssignment = tokenAssignments[0];
  let externalKlingBranch = false;
  for (let ancestor = tokenAssignment.node?.parent; ancestor; ancestor = ancestor.parent) {
    if (!ts.isIfStatement(ancestor)) continue;
    if (astContainsPropertyAccess(ancestor.expression, 'provider', 'type')
      && astContainsStringLiteral(ancestor.expression, 'kling')
      && astContainsNegatedIdentifier(ancestor.expression, 'managedExecution')) {
      externalKlingBranch = true;
      break;
    }
  }
  if (!externalKlingBranch) failures.push('Kling token assignment must be scoped to the unrestricted provider.type kling branch');
  const enabledCheck = (handler.ifStatements || []).find(({ node }) => (
    ts.isIfStatement(node) && astContainsPropertyAccess(node.expression, 'runtime', 'enabled')
  ));
  const configuredCheck = (handler.ifStatements || []).find(({ node }) => (
    ts.isIfStatement(node) && astContainsPropertyAccess(node.expression, 'runtime', 'configured')
  ));
  if (!enabledCheck || !configuredCheck
    || enabledCheck.end >= tokenAssignment.start
    || configuredCheck.end >= tokenAssignment.start) {
    failures.push('Kling token assignment must follow runtime enabled/configured checks');
  }
  const initialGate = callPositions(handler, ['assertVideoExecution'], true)[0] ?? -1;
  const firstPoll = callPositions(handler, ['adapter.poll'])[0] ?? -1;
  if (initialGate < 0 || tokenAssignment.start <= initialGate) failures.push('Kling token assignment must follow the initial execution gate');
  if (firstPoll < 0 || tokenAssignment.start >= firstPoll) failures.push('Kling token assignment must precede adapter.poll');
  return failures;
}

function directImageDownloadErrors(handler) {
  const failures = [];
  const directCalls = (handler.calls || []).filter((call) => (
    ['downloadGatewayTaskImage', 'downloadGeekAIImage'].includes(call.callee)
      && findDirectImageBranch(call.node)
  ));
  if (!directCalls.length) {
    failures.push('remote-only resume must contain an AST direct-download branch');
    return failures;
  }
  const gateCalls = (handler.calls || []).filter((call) => call.callee === 'assertImageExecution' && call.awaited);
  for (const download of directCalls) {
    if (!(download.argumentTexts || []).some((argument) => argument.includes('remoteImageUrl'))) {
      failures.push('direct image download must use the persisted remoteImageUrl');
    }
    if (!gateCalls.some((gate) => gate.start < download.start)) {
      failures.push('direct image download must have a preceding execution gate');
    }
    if (!(handler.calls || []).some((call) => call.callee === 'persistImageBuffer' && call.start > download.start && findDirectImageBranch(call.node))) {
      failures.push('direct image download must use the shared persistImageBuffer helper');
    }
    const branch = findDirectImageBranch(download.node);
    const branchCalls = (handler.calls || []).filter((call) => call.node && isDescendantOf(call.node, branch));
    if (branchCalls.some((call) => ['pollGatewayTaskImage', 'pollGeekAITask', 'submitGatewayTaskImage', 'submitGeekAITask'].includes(call.callee))) {
      failures.push('remote-only direct-download branch must not submit or poll');
    }
  }
  return failures;
}

function imageResumeClaimErrors(handler) {
  const failures = [];
  if (!handler) return ['image resume handler was not discovered'];
  const claimAssignments = (handler.assignments || []).filter((assignment) => (
    /UPDATE\s+jobs\s+SET\s+status\s*=\s*[']running[']/i.test(assignment.initializerText)
  ));
  const directClaim = claimAssignments.find((assignment) => findDirectImageBranch(assignment.node));
  const pollClaim = claimAssignments.find((assignment) => !findDirectImageBranch(assignment.node));
  for (const [name, assignment] of [['direct remote', directClaim], ['task-poll', pollClaim]]) {
    if (!assignment) {
      failures.push(`${name} resume branch must atomically claim needs_check -> running`);
      continue;
    }
    if (!/WHERE\s+id\s*=\s*\?\s+AND\s+status\s*=\s*[']needs_check[']/i.test(assignment.initializerText)) {
      failures.push(`${name} resume claim must require status = needs_check`);
    }
    const check = (handler.ifStatements || []).find(({ node, text }) => (
      astContainsPropertyAccess(node.expression, assignment.name, 'changes')
        && /changes\s*!==?\s*1/.test(text)
        && (handler.calls || []).some((call) => call.callee === 'NextResponse.json'
          && isDescendantOf(call.node, node)
          && /resume_in_progress/.test((call.argumentTexts || []).join(' '))
          && /status\s*:\s*409/.test((call.argumentTexts || []).join(' ')))
    ));
    if (!check) failures.push(`${name} resume claim must reject changes !== 1 with HTTP 409`);
  }
  return failures;
}

function retryRemoteIdentityErrors(handler) {
  const failures = [];
  if (!handler) return ['retry handler was not discovered'];
  const identityRead = (handler.calls || []).find((call) => call.callee === 'Boolean'
    && call.argumentTexts?.some((argument) => argument.includes('job.providerTaskId')
      && argument.includes('job.remoteImageUrl')));
  if (!identityRead) failures.push('retry must inspect both providerTaskId and remoteImageUrl');

  const remoteBranch = (handler.ifStatements || []).find(({ node }) => (
    astContainsIdentifier(node.expression, 'hasRemoteIdentity')
  ));
  if (!remoteBranch) {
    failures.push('retry must branch on the persisted remote identity');
    return failures;
  }
  const branchCalls = (handler.calls || []).filter((call) => call.node && isDescendantOf(call.node, remoteBranch.node));
  const remoteUpdate = branchCalls.find((call) => call.callee === 'db.prepare'
    && call.literalArguments?.some((value) => /UPDATE\s+jobs\s+SET\s+status\s*=\s*[']needs_check[']/i.test(value)));
  if (!remoteUpdate) {
    failures.push('remote-identity retry must move the job to needs_check');
  } else {
    const sql = remoteUpdate.literalArguments.join('\n');
    if (/providerTaskId\s*=|remoteImageUrl\s*=/i.test(sql)) {
      failures.push('remote-identity retry must preserve providerTaskId and remoteImageUrl');
    }
    if (!/status\s+IN\s*\(\s*[']failed[']\s*,\s*[']canceled[']\s*\)/i.test(sql)) {
      failures.push('remote-identity retry must claim only failed/canceled rows');
    }
  }
  const remoteResponse = branchCalls.find((call) => call.callee === 'NextResponse.json'
    && call.argumentTexts?.some((argument) => /resumeRequired\s*:\s*true/.test(argument)));
  if (!remoteResponse) failures.push('remote-identity retry must return resumeRequired=true');
  if (branchCalls.some((call) => call.callee === 'db.prepare'
    && call.literalArguments?.some((value) => /status\s*=\s*[']pending[']/i.test(value)))) {
    failures.push('remote-identity retry branch must never reset the job to pending');
  }
  const normalPendingUpdate = (handler.calls || []).find((call) => call.callee === 'db.prepare'
    && call.literalArguments?.some((value) => /status\s*=\s*[']pending[']/i.test(value))
    && !(remoteBranch.node && isDescendantOf(call.node, remoteBranch.node)));
  if (!normalPendingUpdate) failures.push('retry must retain the no-remote pending path');
  const safeFailure = (handler.calls || []).find((call) => call.callee === 'NextResponse.json'
    && call.argumentTexts?.some((argument) => /retry_failed/.test(argument) && /message/.test(argument)));
  if (!safeFailure) failures.push('retry unknown errors must use a stable safe code/message');
  return failures;
}

function imagePollDownloadFailureErrors(handler) {
  const failures = [];
  if (!handler) return ['image resume handler was not discovered'];
  const failureUpdates = (handler.calls || []).filter((call) => call.callee === 'db.prepare'
    && call.literalArguments?.some((value) => /UPDATE\s+jobs\s+SET\s+status\s*=\s*[']needs_check[']/i.test(value)
      && /remoteImageUrl\s*=/i.test(value)
      && /download_failed/i.test(value)));
  const failureHelper = (handler.functions || []).find((scope) => scope.name === 'markImageDownloadFailure');
  if (!failureHelper || !failureHelper.calls.some((call) => call.callee === 'db.prepare'
    && call.literalArguments?.some((value) => /remoteImageUrl\s*=/i.test(value)))) {
    failures.push('image download failure helper must persist the remoteImageUrl');
  }
  for (const download of (handler.calls || []).filter((call) => call.callee === 'downloadGeekAIImage'
    && !findDirectImageBranch(call.node))) {
    const helperInvocation = (handler.calls || []).some((call) => call.callee === 'markImageDownloadFailure'
      && call.start > download.start
      && (call.argumentTexts || []).some((argument) => argument.includes('imageUrl')));
    if (!failureUpdates.some((update) => update.start > download.start) && !helperInvocation) {
      failures.push('GeekAI poll download failure must retain remoteImageUrl in needs_check');
    }
  }
  return failures;
}

function imageDownloadFailureBranchErrors(handler) {
  const failures = [];
  if (!handler) return ['image resume handler was not discovered'];
  const downloads = (handler.calls || []).filter((call) => (
    call.callee === 'downloadGatewayTaskImage' || call.callee === 'downloadGeekAIImage'
  ));
  const markCalls = (handler.calls || []).filter((call) => call.callee === 'markImageDownloadFailure');
  const markIn = (root) => Boolean(root && markCalls.some((call) => isDescendantOf(call.node, root)));
  const nearestTry = (node) => {
    for (let ancestor = node?.parent; ancestor; ancestor = ancestor.parent) {
      if (ts.isTryStatement(ancestor) && isDescendantOf(node, ancestor.tryBlock)) return ancestor;
    }
    return null;
  };
  const nearestFailureIfAfter = (download, predicate) => {
    const downloadFunction = enclosingFunctionScope(download.node);
    const downloadPath = statementBranchPath(download.node);
    return (handler.ifStatements || [])
      .filter(({ node, start }) => start > download.start
        && predicate(node.expression)
        && (!downloadFunction || enclosingFunctionScope(node) === downloadFunction)
        && isBranchPathPrefix(statementBranchPath(node), downloadPath))
      .sort((a, b) => a.start - b.start)[0]?.node || null;
  };
  for (const download of downloads) {
    const tryStatement = nearestTry(download.node);
    const catchMark = tryStatement?.catchClause?.block && markIn(tryStatement.catchClause.block);
    if (!catchMark) failures.push(`${download.callee} must route download throws to markImageDownloadFailure in its own catch`);
    if (download.callee === 'downloadGatewayTaskImage') {
      const notOk = nearestFailureIfAfter(download, (expression) => (
        astContainsNegatedPropertyAccess(expression, 'downloadResult', 'ok')
      ));
      if (!notOk || !markIn(notOk.thenStatement)) {
        failures.push('each gateway download !ok branch must call markImageDownloadFailure');
      }
    } else {
      const noBuffer = nearestFailureIfAfter(download, (expression) => astContainsNegatedIdentifier(expression, 'imgBuffer'));
      if (!noBuffer || !markIn(noBuffer.thenStatement)) {
        failures.push('each GeekAI download null branch must call markImageDownloadFailure');
      }
    }
  }
  return failures;
}

function unknownCatchErrors(handler, expectedCodes) {
  const failures = [];
  if (!handler) return ['handler was not discovered'];
  const catches = (handler.catchClauses || []).filter((clause) => !clause.variableName);
  if (!catches.length) {
    failures.push('unknown exception paths must use fixed safe catches');
    return failures;
  }
  for (const clause of catches) {
    const text = clause.text || '';
    if (/String\s*\(|\b(?:err|error)\s*\.\s*message\b|\$\{\s*(?:err|error)\b/.test(text)) {
      failures.push('unknown catches must not stringify or expose the complete exception');
    }
    const helperHandled = (handler.calls || []).some((call) => call.callee === 'markImageDownloadFailure'
      && call.start >= clause.start && call.end <= clause.end);
    const fixedCode = helperHandled || expectedCodes.some((code) => text.includes(code));
    if (!fixedCode) failures.push('unknown catches must return or persist a fixed safe code/message');
    const responses = (handler.calls || []).filter((call) => call.callee === 'NextResponse.json'
      && call.start >= clause.start && call.end <= clause.end);
    if (responses.length && !responses.some((call) => (call.argumentTexts || []).some((argument) => /message\s*:/.test(argument)))) {
      failures.push('unknown HTTP catches must include a fixed safe message');
    }
  }
  return failures;
}

function unsafeMediaLogErrors(handler) {
  const failures = [];
  if (!handler) return ['handler was not discovered'];
  const logCalls = (handler.calls || []).filter((call) => (
    call.callee === 'writeLog'
      || /^console\.(?:log|warn|error)$/.test(call.callee || '')
      || call.callee === 'NextResponse.json'
  ));
  for (const call of logCalls) {
    const text = (call.argumentTexts || []).join(' ');
    if (!/remoteImageUrl|pollResult\.imageUrl/.test(text)) continue;
    if (!/redactMediaUrlForLog|failure\.logUrl|logUrl/.test(text)) {
      failures.push('logs and error responses must not expose raw remote image URLs');
    }
  }
  return failures;
}

function imageCreationPolicyErrors(record) {
  const failures = [];
  if (!record) return ['project POST handler was not discovered'];
  const policyNames = importedLocalNames(record, '@/lib/image-provider-selection', [
    'resolveImageJobProvider',
    'resolveRegenerateImageJobProvider',
  ]);
  if (!policyNames.length) failures.push('project creation must import a trusted image provider policy helper');
  const policyCalls = (record.calls || []).filter((call) => policyNames.includes(call.callee));
  if (!policyCalls.length) failures.push('project creation must resolve/assert the selected image provider');
  const insertTargets = (record.calls || []).filter((call) => call.callee === 'db.prepare'
    && call.literalArguments?.some((value) => /INSERT\s+INTO\s+(?:projects|jobs)\b/i.test(value)));
  const firstInsert = insertTargets.map((call) => call.start).sort((a, b) => a - b)[0] ?? -1;
  if (firstInsert < 0) failures.push('project creation INSERT target was not discovered');
  if (firstInsert >= 0 && !policyCalls.some((call) => call.start < firstInsert)) {
    failures.push('image provider policy must run before the first projects/jobs INSERT');
  }
  if (policyCalls.length && !policyCalls.some((call) => (call.argumentTexts || []).some((argument) => argument.includes('db')))) {
    failures.push('image provider policy must receive the current database/provider selection');
  }
  return failures;
}

function imageCreationModelErrors(record) {
  const failures = [];
  if (!record) return ['project POST handler was not discovered'];
  const resolverNames = importedLocalNames(record, '@/lib/image-provider-selection', ['resolveImageJobProvider']);
  const deploymentNames = importedLocalNames(record, '@/lib/managed-deployment', ['isManagedDeployment']);
  const resolverAssignment = (record.assignments || []).find((assignment) => (
    assignment.name === 'resolvedProvider' && resolverNames.includes(assignment.initializerCallee)
  ));
  if (!resolverAssignment) {
    failures.push('project creation must bind resolvedProvider from the trusted image resolver');
  }

  const modelAssignments = (record.assignments || []).filter((assignment) => assignment.name === 'model');
  const managedModelAssignment = modelAssignments.find((assignment) => {
    const initializer = assignment.initializer;
    if (!ts.isConditionalExpression(initializer)) return false;
    const condition = initializer.condition;
    const managedCall = ts.isCallExpression(condition) && ts.isIdentifier(condition.expression)
      && deploymentNames.includes(condition.expression.text);
    return managedCall
      && astIsPropertyAccess(initializer.whenTrue, 'resolvedProvider', 'model')
      && astContainsPropertyAccess(initializer.whenFalse, 'body', 'model');
  });
  if (!managedModelAssignment) {
    failures.push('managed project model must come from resolvedProvider.model while preserving unrestricted body.model');
  } else if (resolverAssignment && managedModelAssignment.start <= resolverAssignment.start) {
    failures.push('resolvedProvider must be established before selecting the managed model');
  }

  const insertCalls = (record.calls || []).filter((call) => call.callee === 'db.prepare'
    && call.literalArguments?.some((value) => /INSERT\s+INTO\s+(?:projects|jobs)\b/i.test(value)));
  for (const insert of insertCalls) {
    const preparedAssignment = (record.assignments || []).find((assignment) => (
      insert.literalArguments?.some((value) => assignment.initializerText.includes(value))
    ));
    const runCalls = (record.calls || []).filter((call) => (
      typeof call.callee === 'string' && call.callee.endsWith('.run')
        && ((call.start <= insert.start && call.end >= insert.end)
          || (preparedAssignment && call.callee === `${preparedAssignment.name}.run`))
    ));
    if (!runCalls.some((call) => (call.argumentTexts || []).some((argument) => argument.trim() === 'model'))) {
      failures.push('every project/job INSERT must use the selected model variable, not body.model directly');
    }
  }
  return failures;
}

function videoCreationPolicyErrors(record) {
  const failures = [];
  if (!record) return ['video creation handler was not discovered'];
  const policyNames = importedLocalNames(record, '@/lib/managed-provider-policy', ['assertManagedProviderAllowed']);
  const allowlistNames = importedLocalNames(record, '@/lib/managed-provider-policy', ['loadManagedProviderAllowlist']);
  if (!policyNames.length) failures.push('video creation must import assertManagedProviderAllowed from managed-provider-policy');
  if (!allowlistNames.length) failures.push('video creation must import loadManagedProviderAllowlist from managed-provider-policy');
  const policyCalls = (record.calls || []).filter((call) => policyNames.includes(call.callee));
  const videoCalls = policyCalls.filter((call) => call.literalArguments?.includes('video'));
  if (!videoCalls.length) failures.push('video creation must assert the video provider role/allowlist');
  if (videoCalls.length && allowlistNames.length && !videoCalls.some((call) => (
    (call.argumentTexts || []).some((argument) => allowlistNames.some((name) => argument.includes(`${name}(`)))
  ))) {
    failures.push('video policy assertion must use the managed allowlist loader');
  }
  const providerSelect = (record.calls || []).filter((call) => call.callee === 'db.prepare'
    && call.literalArguments?.some((value) => /FROM\s+video_providers\b/i.test(value)))
    .map((call) => call.start)
    .sort((a, b) => a - b)[0] ?? -1;
  const targets = (record.calls || []).filter((call) => (
    call.callee === 'runVideoQueue'
      || (call.callee === 'db.prepare' && call.literalArguments?.some((value) => /INSERT\s+INTO\s+video_jobs\b/i.test(value)))
  ));
  if (!targets.length) failures.push('video creation INSERT/queue target was not discovered');
  for (const target of targets) {
    if (!videoCalls.some((call) => call.start > providerSelect && call.start < target.start)) {
      failures.push('video provider policy must run after provider load and before every INSERT/queue side effect');
    }
  }
  return failures;
}

function enclosingIterationScope(node) {
  for (let ancestor = node?.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isWhileStatement(ancestor) || ts.isDoStatement(ancestor)
      || ts.isForStatement(ancestor) || ts.isForInStatement(ancestor)
      || ts.isForOfStatement(ancestor)) return ancestor;
  }
  return null;
}

function enclosingFunctionScope(node) {
  for (let ancestor = node?.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isFunctionDeclaration(ancestor) || ts.isFunctionExpression(ancestor) || ts.isArrowFunction(ancestor)) {
      return ancestor;
    }
  }
  return null;
}

function statementBranchPath(node) {
  const path = [];
  for (let ancestor = node?.parent; ancestor; ancestor = ancestor.parent) {
    if (!ts.isIfStatement(ancestor)) continue;
    if (isDescendantOf(node, ancestor.thenStatement)) path.push(`${ancestor.getStart()}:then`);
    else if (ancestor.elseStatement && isDescendantOf(node, ancestor.elseStatement)) path.push(`${ancestor.getStart()}:else`);
  }
  return path.reverse();
}

function isBranchPathPrefix(prefix, target) {
  if (prefix.length > target.length) return false;
  return prefix.every((entry, index) => entry === target[index]);
}

function pollGatePlacementErrors(handler, helperName, pollNames, initialGate = -Infinity) {
  const failures = [];
  const pollCalls = (handler?.calls || []).filter((call) => pollNames.includes(call.callee));
  const gateCalls = (handler?.calls || []).filter((call) => call.callee === helperName && call.awaited);
  for (const poll of pollCalls) {
    const pollLoop = enclosingIterationScope(poll.node);
    const pollFunction = enclosingFunctionScope(poll.node);
    const pollBranchPath = statementBranchPath(poll.node);
    const candidateGates = gateCalls
      .filter((gate) => gate.start > initialGate && gate.start < poll.start)
      .filter((gate) => !pollLoop || enclosingIterationScope(gate.node) === pollLoop)
      .filter((gate) => !pollFunction || enclosingFunctionScope(gate.node) === pollFunction)
      .filter((gate) => isBranchPathPrefix(statementBranchPath(gate.node), pollBranchPath));
    if (!candidateGates.length) failures.push('every poll call must have a preceding poll gate in the same async loop/branch');
  }
  return failures;
}

function findDirectImageBranch(node) {
  for (let ancestor = node?.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isIfStatement(ancestor)
      && astContainsNegatedIdentifier(ancestor.expression, 'taskId')
      && astContainsIdentifier(ancestor.expression, 'remoteImageUrl')) return ancestor;
  }
  return null;
}

function isDescendantOf(node, ancestor) {
  if (!ancestor) return false;
  for (let current = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

const syntheticWeakClaims = parseHandlers([
  'export async function POST() {',
  '  if (!taskId && remoteImageUrl) {',
  '    const claim = db.prepare(`UPDATE jobs SET status = \'running\' WHERE id = ?`).run(job.id);',
  '    if (claim.changes !== 1) return NextResponse.json({ error: \'resume_in_progress\' }, { status: 409 });',
  '  }',
  '  const pollClaim = db.prepare(`UPDATE jobs SET status = \'running\' WHERE id = ? AND status = \'needs_check\'`).run(job.id);',
  '  if (pollClaim.changes !== 1) return new Response(\'busy\');',
  '}',
].join('\n'));
const syntheticWeakClaimFailures = imageResumeClaimErrors(syntheticWeakClaims[0]);
assert.ok(syntheticWeakClaimFailures.some((failure) => /direct remote.*status = needs_check/.test(failure)), 'synthetic direct claim status guard regression');
assert.ok(syntheticWeakClaimFailures.some((failure) => /task-poll.*HTTP 409/.test(failure)), 'synthetic poll claim conflict response regression');

const syntheticMissingDownloadFailureBranch = parseHandlers([
  'export async function POST() {',
  '  const markImageDownloadFailure = (url) => {};',
  '  try {',
  '    const downloadResult = await downloadGatewayTaskImage(url);',
  '    if (!downloadResult.ok) return;',
  '  } catch {',
  '    return;',
  '  }',
  '}',
].join('\n'));
assert.ok(imageDownloadFailureBranchErrors(syntheticMissingDownloadFailureBranch[0]).length >= 2, 'synthetic per-download failure branch regression');

const syntheticUnsafeCatch = parseHandlers([
  'export async function POST() {',
  '  try { await work(); } catch {',
  '    const msg = String(err);',
  '    return NextResponse.json({ error: msg });',
  '  }',
  '}',
].join('\n'));
const syntheticUnsafeCatchFailures = unknownCatchErrors(syntheticUnsafeCatch[0], ['resume_poll_failed']);
assert.ok(syntheticUnsafeCatchFailures.some((failure) => /stringify/.test(failure)), 'synthetic unsafe catch stringification regression');
assert.ok(syntheticUnsafeCatchFailures.some((failure) => /fixed safe code/.test(failure)), 'synthetic unsafe catch code regression');

const syntheticUnsafeMediaLog = parseHandlers([
  'export async function POST() {',
  '  writeLog({ message: remoteImageUrl });',
  '  return NextResponse.json({ error: pollResult.imageUrl });',
  '}',
].join('\n'));
const syntheticUnsafeMediaFailures = unsafeMediaLogErrors(syntheticUnsafeMediaLog[0]);
assert.ok(syntheticUnsafeMediaFailures.length >= 2, 'synthetic raw media URL log regression');

const syntheticWrongBranchGate = parseHandlers([
  'export async function POST() {',
  '  const assertImageExecution = async () => {};',
  '  await assertImageExecution();',
  '  while (ready) {',
  '    if (other) {',
  '      await assertImageExecution();',
  '    } else {',
  '      await pollGatewayTaskImage();',
  '    }',
  '  }',
  '}',
].join('\n'));
assert.ok(
  pollGatePlacementErrors(syntheticWrongBranchGate[0], 'assertImageExecution', ['pollGatewayTaskImage'], 0)
    .some((failure) => /same async loop\/branch/.test(failure)),
  'synthetic cross-branch poll gate regression',
);

const syntheticLateImagePolicy = parseHandlers([
  'export async function POST() {',
  '  const fake = \'resolveImageJobProvider(db, body.providerId)\';',
  '  db.prepare(\'INSERT INTO projects (id) VALUES (?)\').run(id);',
  '}',
].join('\n'));
assert.ok(imageCreationPolicyErrors({ ...syntheticLateImagePolicy[0], imports: new Map() })
  .some((failure) => /trusted image provider policy/.test(failure)), 'synthetic fake image policy regression');
const syntheticImportedLateImagePolicy = parseHandlers([
  'import { resolveImageJobProvider } from \'@/lib/image-provider-selection\';',
  'export async function POST() {',
  '  db.prepare(\'INSERT INTO projects (id) VALUES (?)\').run(id);',
  '  resolveImageJobProvider(db, body.providerId, { providerId: \'default\', model: \'m\' });',
  '}',
].join('\n'));
assert.ok(imageCreationPolicyErrors(syntheticImportedLateImagePolicy[0])
  .some((failure) => /before the first/.test(failure)), 'synthetic late image policy regression');
const syntheticBodyModelImagePolicy = parseHandlers([
  'import { resolveImageJobProvider } from \'@/lib/image-provider-selection\';',
  'import { isManagedDeployment } from \'@/lib/managed-deployment\';',
  'export async function POST() {',
  '  const resolvedProvider = resolveImageJobProvider(db, body.providerId, { providerId: \'default\', model: body.model });',
  '  const model = body.model;',
  '  db.prepare(\'INSERT INTO projects (id, model) VALUES (?, ?)\').run(id, body.model);',
  '}',
].join('\n'));
const syntheticBodyModelFailures = imageCreationModelErrors(syntheticBodyModelImagePolicy[0]);
assert.ok(syntheticBodyModelFailures.some((failure) => /resolvedProvider\.model/.test(failure)), 'synthetic body.model managed selection regression');
assert.ok(syntheticBodyModelFailures.some((failure) => /selected model variable/.test(failure)), 'synthetic body.model INSERT regression');

const syntheticLateVideoPolicy = parseHandlers([
  'import { assertManagedProviderAllowed, loadManagedProviderAllowlist } from \'@/lib/managed-provider-policy\';',
  'export async function POST() {',
  '  const provider = db.prepare(\'SELECT * FROM video_providers WHERE id = ?\').get(id);',
  '  db.prepare(\'INSERT INTO video_jobs (id) VALUES (?)\').run(id);',
  '  assertManagedProviderAllowed(\'image\', provider, loadManagedProviderAllowlist());',
  '  runVideoQueue({});',
  '}',
].join('\n'));
const syntheticLateVideoFailures = videoCreationPolicyErrors(syntheticLateVideoPolicy[0]);
assert.ok(syntheticLateVideoFailures.some((failure) => /video provider role/.test(failure)), 'synthetic wrong video role regression');
assert.ok(syntheticLateVideoFailures.some((failure) => /before every INSERT/.test(failure)), 'synthetic late video policy regression');
const syntheticFakeVideoPolicy = parseHandlers([
  'export async function POST() {',
  '  const fake = \'assertManagedProviderAllowed(\\\'video\\\', provider, loadManagedProviderAllowlist())\';',
  '  db.prepare(\'INSERT INTO video_jobs (id) VALUES (?)\').run(id);',
  '  runVideoQueue({});',
  '}',
].join('\n'));
assert.ok(videoCreationPolicyErrors({ ...syntheticFakeVideoPolicy[0], imports: new Map() })
  .some((failure) => /import assertManagedProviderAllowed/.test(failure)), 'synthetic fake video policy regression');

const syntheticMissingResumeGates = parseHandlers([
  'export async function POST() {',
  '  const assertImageExecution = async () => {};',
  '  await assertProviderExecutionAvailable({ enabled: true }, { kind: \'image\' });',
  '  await assertImageExecution();',
  '  db.prepare(\'UPDATE jobs SET status = running\');',
  '  await pollGatewayTaskImage();',
  '  await downloadGatewayTaskImage();',
  '}',
].join('\n'));
assert.ok(
  executionResumeBoundaryErrors(
    syntheticMissingResumeGates[0],
    'image',
    'assertImageExecution',
    { initialCalls: ['db.prepare'], initialText: ['status = running'], pollCalls: ['pollGatewayTaskImage', 'pollGeekAITask'], downloadCalls: ['downloadGatewayTaskImage', 'downloadGeekAIImage'] },
  ).some((failure) => /at least three/.test(failure)),
  'synthetic missing resume gate calls regression',
);
const syntheticFakeResume = parseHandlers([
  'export async function POST() {',
  '  const fake = \'await assertProviderExecutionAvailable(); await assertImageExecution(); await pollGatewayTaskImage();\';',
  '  // await assertImageExecution(); await pollGatewayTaskImage(); await downloadGatewayTaskImage();',
  '  return new Response(fake);',
  '}',
].join('\n'));
assert.ok(
  executionResumeBoundaryErrors(
    syntheticFakeResume[0],
    'image',
    'assertImageExecution',
    { initialCalls: ['db.prepare'], initialText: ['status = running'], pollCalls: ['pollGatewayTaskImage'], downloadCalls: ['downloadGatewayTaskImage'] },
  ).length > 0,
  'synthetic fake resume calls regression',
);
const syntheticSpoofResume = parseHandlers([
  'import { assertProviderExecutionAvailable, assertProviderExecutionIdentityStable } from ' + String.fromCharCode(39) + '@/lib/provider-execution-gate' + String.fromCharCode(39) + ';',
  'export async function POST() {',
  '  const spoof = ' + String.fromCharCode(34) + 'enabled: true; kind: image; db.prepare SELECT FROM providers' + String.fromCharCode(34) + ';',
  '  await assertProviderExecutionAvailable(spoof, spoof);',
  '  await assertProviderExecutionIdentityStable(spoof, spoof);',
  '  return new Response(spoof);',
  '}',
].join(String.fromCharCode(10)));
const syntheticSpoofFailures = executionResumeBoundaryErrors(
  syntheticSpoofResume[0],
  'image',
  'assertImageExecution',
  { initialCalls: ['db.prepare'], initialText: ['status = running'], pollCalls: ['pollGatewayTaskImage'], downloadCalls: ['downloadGatewayTaskImage'] },
);
assert.ok(syntheticSpoofFailures.some((failure) => /provider execution kind/.test(failure)), 'synthetic spoof kind regression');
assert.ok(syntheticSpoofFailures.some((failure) => /enabled/.test(failure)), 'synthetic spoof enabled regression');
assert.ok(syntheticSpoofFailures.some((failure) => /generation helper/.test(failure)), 'synthetic spoof generation helper regression');
assert.ok(syntheticSpoofFailures.some((failure) => /managed provisioning generation/.test(failure)), 'synthetic spoof generation regression');
assert.ok(syntheticSpoofFailures.some((failure) => /current provider DB reload/.test(failure)), 'synthetic spoof DB reload regression');
const syntheticNoPostResume = parseHandlers([
  'import { assertProviderExecutionAvailable, assertProviderExecutionIdentityStable, readManagedExecutionGeneration } from ' + String.fromCharCode(39) + '@/lib/provider-execution-gate' + String.fromCharCode(39) + ';',
  'export async function POST() {',
  '  const readCurrentImageProvider = () => db.prepare(' + String.fromCharCode(34) + 'SELECT * FROM providers WHERE id = ?' + String.fromCharCode(34) + ').get();',
  '  const imageProviderIdentity = (current) => ({ enabled: true, managedGeneration: readManagedExecutionGeneration() });',
  '  const assertImageExecution = async () => {',
  '    const pre = readCurrentImageProvider();',
  '    const preExecution = imageProviderIdentity(pre);',
  '    assertProviderExecutionIdentityStable(preExecution, preExecution);',
  '    await assertProviderExecutionAvailable(preExecution, { kind: ' + String.fromCharCode(34) + 'image' + String.fromCharCode(34) + ' });',
  '  };',
  '  await assertImageExecution();',
  '  db.prepare(' + String.fromCharCode(34) + 'UPDATE jobs SET status = running' + String.fromCharCode(34) + ');',
  '  await pollGatewayTaskImage();',
  '  await assertImageExecution();',
  '  await downloadGatewayTaskImage();',
  '  await assertImageExecution();',
  '}',
].join(String.fromCharCode(10)));
const syntheticNoPostFailures = executionResumeBoundaryErrors(
  syntheticNoPostResume[0],
  'image',
  'assertImageExecution',
  {
    identityFunction: 'imageProviderIdentity',
    currentReadCalls: ['readCurrentImageProvider'],
    currentReadFunctions: ['readCurrentImageProvider'],
    postAssignments: ['activeImageExecution'],
    postValue: 'postExecution',
    initialCalls: ['db.prepare'],
    initialText: ['status = running'],
    pollCalls: ['pollGatewayTaskImage'],
    downloadCalls: ['downloadGatewayTaskImage'],
    snapshotPollCalls: ['pollGatewayTaskImage'],
    snapshotPollValue: 'activeImageExecution',
    snapshotDownloadCalls: ['downloadGatewayTaskImage'],
    snapshotDownloadValue: 'activeImageExecution',
  },
);
assert.ok(syntheticNoPostFailures.some((failure) => /reload provider before and after/.test(failure)), 'synthetic missing post reload regression');
assert.ok(syntheticNoPostFailures.some((failure) => /compare both pre and post/.test(failure)), 'synthetic missing post stability regression');
assert.ok(syntheticNoPostFailures.some((failure) => /build identities from both pre and post/.test(failure)), 'synthetic missing post identity regression');
assert.ok(syntheticNoPostFailures.some((failure) => /post-gate provider snapshot/.test(failure)), 'synthetic stale adapter source regression');
const syntheticUnrelatedIdentity = parseHandlers([
  'import { assertProviderExecutionAvailable, assertProviderExecutionIdentityStable, readManagedExecutionGeneration } from ' + String.fromCharCode(39) + '@/lib/provider-execution-gate' + String.fromCharCode(39) + ';',
  'export async function POST() {',
  '  const readCurrentImageProvider = () => ' + String.fromCharCode(34) + 'db.prepare(SELECT * FROM providers)' + String.fromCharCode(34) + ';',
  '  const imageProviderIdentity = (current) => {',
  '    const unrelated = { enabled: true, managedGeneration: readManagedExecutionGeneration() };',
  '    return { id: current.id };',
  '  };',
  '  const assertImageExecution = async () => {',
  '    const pre = readCurrentImageProvider();',
  '    const preExecution = imageProviderIdentity(pre);',
  '    assertProviderExecutionIdentityStable(preExecution, preExecution);',
  '    await assertProviderExecutionAvailable(preExecution, { kind: ' + String.fromCharCode(34) + 'image' + String.fromCharCode(34) + ' });',
  '  };',
  '  await assertImageExecution();',
  '} ',
].join(String.fromCharCode(10)));
const syntheticUnrelatedFailures = executionResumeBoundaryErrors(
  syntheticUnrelatedIdentity[0],
  'image',
  'assertImageExecution',
  { identityFunction: 'imageProviderIdentity', currentReadCalls: ['readCurrentImageProvider'], currentReadFunctions: ['readCurrentImageProvider'] },
);
assert.ok(syntheticUnrelatedFailures.some((failure) => /managed identity object must own/.test(failure)), 'synthetic unrelated identity properties regression');
assert.ok(syntheticUnrelatedFailures.some((failure) => /actual provider DB query/.test(failure)), 'synthetic fake DB reload regression');

function relativeRoute(absolute) {
  return path.relative(repoRoot, absolute).split(path.sep).join('/');
}

const routeRecords = [];
for (const absolute of walkRoutes(apiRoot)) {
  const route = relativeRoute(absolute);
  const source = fs.readFileSync(absolute, 'utf8');
  for (const handler of parseHandlers(source)) routeRecords.push({ absolute, route, source, ...handler });
}

const errors = [];
const providerRecords = routeRecords.filter(({ route }) => route.startsWith('app/api/providers/'));
assert(providerRecords.length > 0, 'provider routes were not discovered by the coverage scan');

// Provider CRUD is owned by Task 5. Keep it in this scan (so a new provider
// route cannot silently disappear), but leave its policy assertion to the
// dedicated provider-route contract. The preview endpoint is a producer route,
// not provider CRUD, and is covered by the normal shared guard below when it is
// changed by its owning task.
for (const record of routeRecords) {
  const { method, route, body } = record;
  const key = `${method} ${route}`;
  if (LOCKED_EXEMPTIONS.has(key)) continue;

  const isProvider = route.startsWith('app/api/providers/');
  const isProviderPreview = route === 'app/api/providers/tts/[id]/preview/route.ts';
  if (isProvider && !isProviderPreview) {
    if (MUTATION_METHODS.has(method)) {
      const providerNames = importedLocalNames(record, PROVIDER_GUARD_MODULE, PROVIDER_GUARD_NAMES);
      if (!providerNames.length) {
        errors.push(`${key}: provider read-only helper must come from managed-provider-policy`);
      }
      const providerGuard = record.calls?.find(({ callee }) => providerNames.includes(callee));
      if (!providerGuard) errors.push(`${key}: missing managed provider read-only guard`);
      else if (!hasProviderGuardPrelude(record, providerNames)) errors.push(`${key}: provider read-only guard must be the first statement and return immediately`);
      else {
        const firstSideEffect = firstIndex(body, SIDE_EFFECT_MARKERS);
        if (firstSideEffect >= 0 && providerGuard.start > firstSideEffect) {
          errors.push(`${key}: provider read-only guard must precede ${SIDE_EFFECT_MARKERS.find((marker) => body.indexOf(marker) === firstSideEffect)}`);
        }
      }
    }
    continue;
  }

  const isActionRoute = ACTION_ROUTES.has(route) && method === 'POST';
  const sideEffectCalls = method === 'GET' ? getSideEffectCalls(record) : [];
  const isSideEffectGet = method === 'GET' && sideEffectCalls.length > 0;
  if (!MUTATION_METHODS.has(method) && !isActionRoute && !isSideEffectGet) continue;

  const sharedNames = importedLocalNames(record, SHARED_GUARD_MODULE, SHARED_GUARD_NAMES);
  const guardCall = record.calls?.find(({ callee }) => sharedNames.includes(callee));
  if (!sharedNames.length) {
    errors.push(`${key}: shared guard must come from app/api/managed-deployment/guard`);
  }
  if (!guardCall) {
    errors.push(`${key}: missing shared managed-workbench guard`);
    continue;
  }
  const guardIndex = guardCall.start;

  if (isActionRoute) {
    const config = ACTION_ROUTES.get(route);
    if (!hasActionGuardPrelude(record, config, sharedNames)) {
      errors.push(`${key}: only action parsing/validation may precede the conditional guard`);
      continue;
    }
    const actionIndex = body.search(/\b(?:body\?\.action|body\.action)\b/);
    const bodyParseIndex = body.search(/await\s+request\.json\s*\(/);
    if (bodyParseIndex < 0 || actionIndex < 0 || actionIndex < bodyParseIndex || guardIndex <= actionIndex) {
      errors.push(`${key}: action must be parsed before the conditional guard`);
      continue;
    }
    if (!config.branch.test(body.slice(actionIndex, guardIndex + guardCall.text.length + 80))) {
      errors.push(`${key}: guard is not scoped to the ready-only ${config.ready} action`);
    }
    const validationIndex = body.indexOf('invalid_action');
    if (validationIndex >= 0 && validationIndex > guardIndex) {
      errors.push(`${key}: invalid action validation occurs after guard`);
    }
    for (const action of config.safe) {
      if (!new RegExp(`['"]${action}['"]`).test(body.slice(actionIndex, guardIndex))) {
        errors.push(`${key}: safe action ${action} is not declared before guard`);
      }
    }
    const beforeGuard = body.slice(0, guardIndex);
    const forbiddenBeforeGuard = SIDE_EFFECT_MARKERS.filter((marker) => marker !== 'await request.json' && beforeGuard.includes(marker));
    if (forbiddenBeforeGuard.length) {
      errors.push(`${key}: only action parsing/validation may precede guard; found ${forbiddenBeforeGuard[0]}`);
    }
    for (const failure of actionSchedulerErrors(record, config)) {
      errors.push(`${key}: ${failure}`);
    }
    continue;
  }

  if (!hasSharedGuardPrelude(record, sharedNames)) {
    errors.push(`${key}: first statements must assign the shared guard and immediately return its response`);
    continue;
  }

  const firstSideEffect = firstIndex(body, SIDE_EFFECT_MARKERS);
  if (firstSideEffect >= 0 && guardIndex > firstSideEffect) {
    errors.push(`${key}: guard must precede ${SIDE_EFFECT_MARKERS.find((marker) => body.indexOf(marker) === firstSideEffect)}`);
  }
}

const discoveredSideEffectGets = routeRecords
  .filter(({ method }) => method === 'GET')
  .filter((record) => getSideEffectCalls(record).length > 0);
const expectedSideEffectGets = new Set([
  'GET app/api/batch-production/batches/[id]/tasks/route.ts',
  'GET app/api/batch-production/batches/[id]/workspace/route.ts',
  'GET app/api/batch-production/prepare/route.ts',
  'GET app/api/projects/[id]/creative-package/route.ts',
  'GET app/api/projects/[id]/final-edit/bootstrap/route.ts',
  'GET app/api/projects/[id]/final-edit/context/route.ts',
  'GET app/api/projects/[id]/final-edit/groups/route.ts',
]);
for (const expected of expectedSideEffectGets) {
  if (!discoveredSideEffectGets.some(({ route, method }) => `${method} ${route}` === expected)) {
    errors.push(`side-effect GET discovery missing ${expected}`);
  }
}

function resumeRecord(route) {
  return routeRecords.find((record) => record.route === route && record.method === 'POST');
}

function requireExecutionResumeBoundary(route, kind, helperName, stages) {
  const record = resumeRecord(route);
  if (!record) {
    errors.push(`POST ${route}: resume-poll handler was not discovered`);
    return;
  }
  for (const failure of executionResumeBoundaryErrors(record, kind, helperName, stages)) {
    errors.push(`POST ${route}: ${failure}`);
  }
}

requireExecutionResumeBoundary('app/api/jobs/[id]/resume-poll/route.ts', 'image', 'assertImageExecution', {
  identityFunction: 'imageProviderIdentity',
  currentReadCalls: ['readCurrentImageProvider'],
  currentReadFunctions: ['readCurrentImageProvider'],
  postAssignments: ['activeImageExecution'],
  postValue: 'postExecution',
  initialCalls: ['db.prepare'],
  initialText: [`status = 'running'`],
  pollCalls: ['pollGatewayTaskImage', 'pollGeekAITask'],
  downloadCalls: ['downloadGatewayTaskImage', 'downloadGeekAIImage'],
  snapshotPollCalls: ['pollGatewayTaskImage', 'pollGeekAITask'],
  snapshotPollValue: 'activeImageExecution',
  snapshotDownloadCalls: ['downloadGatewayTaskImage'],
  snapshotDownloadValue: 'activeImageExecution',
});
requireExecutionResumeBoundary('app/api/video-jobs/[id]/resume-poll/route.ts', 'video', 'assertVideoExecution', {
  identityFunction: 'videoProviderExecution',
  currentReadCalls: ['readCurrentVideoProvider'],
  currentReadFunctions: ['readCurrentVideoProvider'],
  postAssignments: ['runtime', 'apiKey'],
  postValue: 'postExecution',
  initialCalls: ['getVideoAdapter'],
  pollCalls: ['adapter.poll'],
  downloadCalls: ['downloadVideoMediaForProvider', 'fetch'],
  snapshotPollCalls: ['adapter.poll'],
  snapshotPollValue: 'apiKey',
  snapshotDownloadCalls: ['downloadVideoMediaForProvider'],
  snapshotDownloadValue: 'apiKey',
});
const imageResumeRecord = resumeRecord('app/api/jobs/[id]/resume-poll/route.ts');
for (const failure of directImageDownloadErrors(imageResumeRecord)) {
  errors.push(`POST app/api/jobs/[id]/resume-poll/route.ts: ${failure}`);
}
for (const failure of imageResumeClaimErrors(imageResumeRecord)) {
  errors.push(`POST app/api/jobs/[id]/resume-poll/route.ts: ${failure}`);
}
for (const failure of imagePollDownloadFailureErrors(imageResumeRecord)) {
  errors.push(`POST app/api/jobs/[id]/resume-poll/route.ts: ${failure}`);
}
for (const failure of imageDownloadFailureBranchErrors(imageResumeRecord)) {
  errors.push(`POST app/api/jobs/[id]/resume-poll/route.ts: ${failure}`);
}
for (const failure of unknownCatchErrors(imageResumeRecord, ['resume_download_failed', 'resume_poll_failed'])) {
  errors.push(`POST app/api/jobs/[id]/resume-poll/route.ts: ${failure}`);
}
for (const failure of unsafeMediaLogErrors(imageResumeRecord)) {
  errors.push(`POST app/api/jobs/[id]/resume-poll/route.ts: ${failure}`);
}
const videoResumeRecord = resumeRecord('app/api/video-jobs/[id]/resume-poll/route.ts');
for (const failure of videoKlingTokenErrors(videoResumeRecord)) {
  errors.push(`POST app/api/video-jobs/[id]/resume-poll/route.ts: ${failure}`);
}
const imageRetryRecord = resumeRecord('app/api/jobs/[id]/retry/route.ts');
for (const failure of retryRemoteIdentityErrors(imageRetryRecord)) {
  errors.push(`POST app/api/jobs/[id]/retry/route.ts: ${failure}`);
}
for (const failure of unknownCatchErrors(imageRetryRecord, ['retry_failed'])) {
  errors.push(`POST app/api/jobs/[id]/retry/route.ts: ${failure}`);
}
const projectCreateRecord = routeRecords.find((record) => record.route === 'app/api/projects/route.ts' && record.method === 'POST');
for (const failure of imageCreationPolicyErrors(projectCreateRecord)) {
  errors.push(`POST app/api/projects/route.ts: ${failure}`);
}
for (const failure of imageCreationModelErrors(projectCreateRecord)) {
  errors.push(`POST app/api/projects/route.ts: ${failure}`);
}
for (const route of ['app/api/shot-sets/[id]/video-jobs/route.ts', 'app/api/shot-sets/[id]/video-jobs/batch/route.ts']) {
  const record = routeRecords.find((candidate) => candidate.route === route && candidate.method === 'POST');
  for (const failure of videoCreationPolicyErrors(record)) errors.push(`POST ${route}: ${failure}`);
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  const mutationCount = routeRecords.filter(({ method }) => MUTATION_METHODS.has(method)).length;
  const sideEffectGetCount = discoveredSideEffectGets.length;
  assert.equal(mutationCount, 83, `mutation handler baseline changed: ${mutationCount}`);
  assert.equal(providerRecords.length, 17, `provider handler baseline changed: ${providerRecords.length}`);
  assert.equal(sideEffectGetCount, 7, `side-effect GET baseline changed: ${sideEffectGetCount}`);
  console.log(`managed API guard coverage PASS (${mutationCount} mutation handlers, ${providerRecords.length} provider handlers, ${sideEffectGetCount} side-effect GETs)`);
}
