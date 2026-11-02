import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export const TEAM_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const TEAM_ROUTE_CATEGORIES = ['public', 'authenticated', 'resource', 'admin', 'local_only', 'server_disabled'];
const METHODS = new Set(TEAM_HTTP_METHODS);
const CATEGORIES = new Set(TEAM_ROUTE_CATEGORIES);

function routeName(repoRoot, file) {
  const relative = path.relative(path.join(repoRoot, 'app', 'api'), file).split(path.sep).join('/');
  return `/api/${relative.slice(0, -'/route.ts'.length)}`.replace(/\/$/, '');
}

function routeFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...routeFiles(absolute));
    else if (entry.isFile() && entry.name === 'route.ts') files.push(absolute);
  }
  return files.sort();
}

function exportedEndpoints(repoRoot, file) {
  const route = routeName(repoRoot, file);
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const endpoints = [];
  const errors = [];
  const pushError = (code, message, key) => errors.push({ code, message, key });

  for (const statement of source.statements) {
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement) && exported && statement.name && METHODS.has(statement.name.text)) {
      const method = statement.name.text;
      endpoints.push({ route, method, wrapped: false, file });
      pushError('missing_wrapper', `${route} ${method} 未通过 withTeamRoute 导出。`, `${route} ${method}`);
      continue;
    }
    if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !METHODS.has(declaration.name.text)) continue;
        const method = declaration.name.text;
        const initializer = declaration.initializer;
        const wrapped = initializer && ts.isCallExpression(initializer)
          && ts.isIdentifier(initializer.expression)
          && initializer.expression.text === 'withTeamRoute';
        if (!wrapped) {
          endpoints.push({ route, method, wrapped: false, file });
          pushError('missing_wrapper', `${route} ${method} 未通过 withTeamRoute 导出。`, `${route} ${method}`);
          continue;
        }
        const [routeArgument, methodArgument] = initializer.arguments;
        if (!routeArgument || !ts.isStringLiteral(routeArgument)
          || !methodArgument || !ts.isStringLiteral(methodArgument)
          || initializer.arguments.length < 3) {
          endpoints.push({ route, method, wrapped: false, file });
          pushError('invalid_wrapper', `${route} ${method} 的 wrapper 必须使用静态 route/method 并传入 handler。`, `${route} ${method}`);
          continue;
        }
        if (routeArgument.text !== route || methodArgument.text !== method) {
          pushError('wrapper_mismatch', `${route} ${method} 的 wrapper 键为 ${routeArgument.text} ${methodArgument.text}。`, `${route} ${method}`);
        }
        endpoints.push({ route, method, wrapped: true, file });
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const names = statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text)
        : [];
      if (!statement.exportClause || names.some((name) => METHODS.has(name))) {
        pushError('unsupported_export', `${route} 含无法静态确认的 HTTP re-export/alias。`, route);
      }
    }
    if (ts.isExportAssignment(statement)) {
      pushError('unsupported_export', `${route} 含不支持的默认 HTTP 导出。`, route);
    }
  }
  return { endpoints, errors };
}

function validatePolicy(policy) {
  const errors = [];
  const key = `${policy?.route ?? '(missing)'} ${policy?.method ?? '(missing)'}`;
  if (!policy || typeof policy.route !== 'string' || !policy.route.startsWith('/api/') || !METHODS.has(policy.method)) {
    errors.push({ code: 'invalid_policy', key, message: '策略必须使用规范 /api route 与受支持 method。' });
  }
  if (!CATEGORIES.has(policy?.category)) {
    errors.push({ code: 'invalid_policy', key, message: '策略缺少六类中的精确 category。' });
  }
  if (typeof policy?.csrf !== 'boolean') {
    errors.push({ code: 'invalid_policy', key, message: '策略必须显式声明 csrf 布尔值。' });
  }
  if (policy?.category === 'resource'
    && (typeof policy.resource !== 'string' || !policy.resource || !['read', 'write'].includes(policy.action))) {
    errors.push({ code: 'invalid_policy', key, message: 'resource 策略必须声明 resource resolver 与 read/write action。' });
  }
  if (policy?.route === '/api/shutdown' && policy.category !== 'local_only') {
    errors.push({ code: 'invalid_server_exception', key, message: 'shutdown 只能分类为 local_only。' });
  }
  if (policy?.route?.startsWith('/api/desktop/') && policy.category !== 'local_only') {
    errors.push({ code: 'invalid_server_exception', key, message: '同机桌面入口只能分类为 local_only。' });
  }
  if (policy?.route?.startsWith('/api/reassembled-films') && policy.category !== 'server_disabled') {
    errors.push({ code: 'invalid_server_exception', key, message: '实拍重组入口必须分类为 server_disabled。' });
  }
  return errors;
}

export async function checkTeamApiCoverage(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(import.meta.dirname, '..'));
  const files = routeFiles(path.join(repoRoot, 'app', 'api'));
  const endpoints = [];
  const errors = [];
  for (const file of files) {
    const result = exportedEndpoints(repoRoot, file);
    endpoints.push(...result.endpoints);
    errors.push(...result.errors);
  }

  const policyUrl = options.policyUrl ?? pathToFileURL(path.join(repoRoot, 'lib', 'team-service', 'route-policy.ts')).href;
  let policies;
  try {
    const url = new URL(policyUrl);
    url.searchParams.set('coverage', `${Date.now()}-${Math.random()}`);
    policies = (await import(url.href)).TEAM_ROUTE_POLICIES;
    if (!Array.isArray(policies)) throw new Error('TEAM_ROUTE_POLICIES 不是数组');
  } catch (error) {
    return {
      ok: false,
      repoRoot,
      routeCount: files.length,
      methodCount: endpoints.length,
      endpoints,
      policies: [],
      errors: [...errors, { code: 'policy_load', key: policyUrl, message: error instanceof Error ? error.message : String(error) }],
    };
  }

  const endpointMap = new Map();
  for (const endpoint of endpoints) {
    const key = `${endpoint.route} ${endpoint.method}`;
    if (endpointMap.has(key)) errors.push({ code: 'duplicate_endpoint', key, message: '同一路由方法被重复导出。' });
    endpointMap.set(key, endpoint);
  }
  const policyMap = new Map();
  for (const policy of policies) {
    const key = `${policy?.route} ${policy?.method}`;
    if (policyMap.has(key)) errors.push({ code: 'duplicate_policy', key, message: '策略键重复。' });
    policyMap.set(key, policy);
    errors.push(...validatePolicy(policy));
    if (policyMap.get(key)?.category !== 'public' && !endpointMap.get(key)?.wrapped) {
      if (endpointMap.has(key)) errors.push({ code: 'missing_wrapper', key, message: '已分类方法未实际接入 wrapper。' });
    }
  }
  for (const key of endpointMap.keys()) {
    if (!policyMap.has(key)) errors.push({ code: 'unclassified', key, message: '路由方法缺少权限分类。' });
  }
  for (const key of policyMap.keys()) {
    if (!endpointMap.has(key)) errors.push({ code: 'stale_policy', key, message: '策略指向不存在的路由方法。' });
  }
  const sortedErrors = errors.sort((a, b) => `${a.key}:${a.code}:${a.message}`.localeCompare(`${b.key}:${b.code}:${b.message}`));
  return {
    ok: sortedErrors.length === 0,
    repoRoot,
    routeCount: files.length,
    methodCount: endpoints.length,
    endpoints: endpoints.sort((a, b) => `${a.route} ${a.method}`.localeCompare(`${b.route} ${b.method}`)),
    policies,
    errors: sortedErrors,
  };
}

async function main() {
  const result = await checkTeamApiCoverage();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ routeCount: result.routeCount, methodCount: result.methodCount, endpoints: result.endpoints, policies: result.policies, errors: result.errors }, null, 2));
  } else {
    console.log(`team API coverage: ${result.routeCount} routes, ${result.methodCount} methods`);
    for (const error of result.errors) console.error(`${error.code}\t${error.key}\t${error.message}`);
    if (result.ok) console.log('team API coverage passed');
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main();
