#!/usr/bin/env node

/**
 * TanStack Start Route Validator
 *
 * 检查路由代码是否符合 TanStack Start 最佳实践
 *
 * 用法：
 *   node scripts/validate-routes.mjs
 *   pnpm validate-routes
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const ROUTES_DIR = join(ROOT_DIR, 'src', 'routes');

// 白名单：必须保留的 REST API（WS 服务器依赖、第三方集成、脚手架自带等）
const REST_API_WHITELIST = [
  // WS 服务器依赖
  '/api/agent-sessions',
  '/api/agent-sessions/by-sdk-id',
  '/api/run-summary',
  // 第三方集成
  '/api/auth',                      // Better Auth 集成
  '/api/auth/polar',                // Polar webhook
  // 脚手架自带的 API（保持不变）
  '/api/billing',                   // 计费相关
  '/api/subscription',              // 订阅管理
  '/api/invoices',                  // 发票管理
  '/api/settings',                  // 设置相关
  // 系统端点
  '/api/health',                    // 健康检查
  '/api/jobs',                      // 定时任务
  '/api/test-email',                // 测试端点
  '/api/search',                    // 搜索服务
  '/api/workflow',                  // 工作流 API
];

// 检查结果统计
const results = {
  passed: 0,
  warnings: 0,
  errors: 0,
  files: [],
};

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

// 检查规则
const rules = {
  // 错误级别：违反核心原则
  errors: [
    {
      id: 'no-rest-api-routes',
      name: '禁止 REST API 路由',
      check: (filePath, content) => {
        if (!filePath.includes('/api/')) return null;

        // 检查是否在白名单中
        const isWhitelisted = REST_API_WHITELIST.some(api => filePath.includes(api));
        if (isWhitelisted) {
          return null;  // 跳过白名单 API
        }

        // 检查是否使用 server handlers 模式
        if (content.includes('server:') && content.includes('handlers:')) {
          return {
            message: '检测到 REST API 路由（使用 server handlers），应使用 Server Functions',
            suggestion: '将路由逻辑移到 src/server/function/*.server.ts，使用 createServerFn()',
          };
        }
        return null;
      },
    },
    {
      id: 'no-fetch-in-loader',
      name: 'Loader 中禁止使用 fetch',
      check: (filePath, content) => {
        if (!content.includes('loader:')) return null;
        // 检查 loader 中是否有 fetch 调用
        const loaderMatch = content.match(/loader:\s*(?:async\s*\(\)|\(\)\s*=>)/);
        if (!loaderMatch) return null;

        const loaderStart = content.indexOf(loaderMatch[0]);
        const loaderEnd = findLoaderEnd(content, loaderStart);
        const loaderContent = content.slice(loaderStart, loaderEnd);

        if (loaderContent.includes('fetch(') || loaderContent.includes('fetch (')) {
          return {
            message: 'Loader 中检测到 fetch() 调用，应使用 Server Functions',
            suggestion: '定义 Server Function (createServerFn) 并在 loader 中调用',
          };
        }
        return null;
      },
    },
    {
      id: 'no-zustand-data-fetching',
      name: '禁止在 zustand store 中获取数据',
      check: (filePath, content) => {
        if (!filePath.includes('/lib/') && !filePath.includes('/stores/')) return null;
        if (!content.includes('create') && !content.includes('create(')) return null;

        // 检查 zustand store 中是否有 fetch 调用
        if (content.includes('fetch(') || content.includes('await fetch')) {
          return {
            message: '检测到 zustand store 中使用 fetch() 进行数据获取',
            suggestion: '数据应在 route loader 中使用 Server Functions 获取，zustand 仅用于客户端状态',
          };
        }
        return null;
      },
    },
  ],

  // 警告级别：可能需要优化
  warnings: [
    {
      id: 'use-server-functions',
      name: '推荐使用 Server Functions',
      check: (filePath, content) => {
        // 检查是否有 fetch 调用
        if (!content.includes('fetch(') && !content.includes('fetch (')) return null;

        // 排除 Server Functions 文件本身
        if (filePath.includes('.server.ts')) return null;

        // 排除合法的 fetch 使用场景
        const isHealthCheck = content.includes(`fetch('/api/health')`);
        const isWebSocket = content.includes('fetch(') && content.includes('cl.ws');
        if (isHealthCheck || isWebSocket) {
          return null;
        }

        return {
          message: '检测到 fetch() 调用，考虑使用 Server Functions',
          suggestion: 'Server Functions 提供类型安全和自动序列化',
        };
      },
    },
    {
      id: 'useuseffect-for-data',
      name: '避免 useEffect 获取数据',
      check: (filePath, content) => {
        if (!content.includes('useEffect')) return null;

        // 检查 useEffect 中是否有数据获取模式
        const useEffectMatches = content.matchAll(/useEffect\([^)]*\)/g);
        for (const match of useEffectMatches) {
          const useEffectContent = content.slice(
            content.indexOf(match[0]),
            content.indexOf(match[0]) + match[0].length + 500
          );

          if (
            useEffectContent.includes('fetch(') ||
            (useEffectContent.includes('await') && useEffectContent.includes('get'))
          ) {
            return {
              message: 'useEffect 中可能包含数据获取逻辑',
              suggestion: '考虑在 route loader 中获取数据，或使用 React Query + Server Functions',
            };
          }
        }
        return null;
      },
    },
    {
      id: 'loader-not-optimized',
      name: 'Loader 应并行加载数据',
      check: (filePath, content) => {
        if (!content.includes('loader:')) return null;

        const loaderMatch = content.match(/loader:\s*(?:async\s*\(\)|\(\)\s*=>)/);
        if (!loaderMatch) return null;

        const loaderStart = content.indexOf(loaderMatch[0]);
        const loaderEnd = findLoaderEnd(content, loaderStart);
        const loaderContent = content.slice(loaderStart, loaderEnd);

        // 检查是否有多个 await 但未使用 Promise.all
        const awaitMatches = loaderContent.match(/await\s+\w+/g);
        if (awaitMatches && awaitMatches.length > 1 && !loaderContent.includes('Promise.all')) {
          return {
            message: 'Loader 中有多个 await 调用，未使用 Promise.all 并行加载',
            suggestion: '使用 Promise.all([fn1(), fn2()]) 并行加载数据以提升性能',
          };
        }
        return null;
      },
    },
  ],
};

// 辅助函数：找到 loader 的结束位置
function findLoaderEnd(content, startIndex) {
  const braceCount = { '{': 0, '}': 0 };
  let inObject = false;
  let depth = 0;

  for (let i = startIndex; i < content.length; i++) {
    const char = content[i];
    if (char === '{') {
      braceCount['{']++;
      inObject = true;
    } else if (char === '}') {
      braceCount['}']++;
      if (inObject && braceCount['{'] === braceCount['}']) {
        return i + 1;
      }
    }
  }
  return content.length;
}

// 递归扫描路由文件
function scanRoutes(dir, baseDir = dir) {
  const files = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        files.push(...scanRoutes(fullPath, baseDir));
      } else if (stat.isFile() && (entry.endsWith('.tsx') || entry.endsWith('.ts'))) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // 忽略无法访问的目录
  }

  return files;
}

// 检查单个文件
function checkFile(filePath) {
  const relativePath = relative(ROOT_DIR, filePath);
  const content = readFileSync(filePath, 'utf-8');

  const fileResult = {
    path: relativePath,
    errors: [],
    warnings: [],
  };

  // 运行所有错误检查
  for (const rule of rules.errors) {
    const result = rule.check(filePath, content);
    if (result) {
      fileResult.errors.push({
        rule: rule.id,
        name: rule.name,
        ...result,
      });
      results.errors++;
    }
  }

  // 运行所有警告检查
  for (const rule of rules.warnings) {
    const result = rule.check(filePath, content);
    if (result) {
      fileResult.warnings.push({
        rule: rule.id,
        name: rule.name,
        ...result,
      });
      results.warnings++;
    }
  }

  if (fileResult.errors.length === 0 && fileResult.warnings.length === 0) {
    results.passed++;
  }

  results.files.push(fileResult);
}

// 输出结果
function printResults() {
  console.log(`\n${colors.blue}=== TanStack Start 路由验证报告 ===${colors.reset}\n`);

  // 显示有问题的文件
  const problemFiles = results.files.filter(
    (f) => f.errors.length > 0 || f.warnings.length > 0
  );

  if (problemFiles.length === 0) {
    console.log(`${colors.green}✓ 所有检查通过！${colors.reset}\n`);
    return;
  }

  problemFiles.forEach((file) => {
    console.log(`${colors.blue}${file.path}${colors.reset}`);

    // 显示错误
    file.errors.forEach((error) => {
      console.log(`  ${colors.red}✗ ${colors.reset}${error.name}`);
      console.log(`    ${colors.gray}${error.message}${colors.reset}`);
      console.log(`    ${colors.yellow}➜${colors.reset} ${error.suggestion}\n`);
    });

    // 显示警告
    file.warnings.forEach((warning) => {
      console.log(`  ${colors.yellow}⚠ ${colors.reset}${warning.name}`);
      console.log(`    ${colors.gray}${warning.message}${colors.reset}`);
      console.log(`    ${colors.yellow}➜${colors.reset} ${warning.suggestion}\n`);
    });
  });

  // 统计信息
  console.log(`${colors.blue}=== 统计 ===${colors.reset}`);
  console.log(`  ${colors.green}通过:${colors.reset} ${results.passed}`);
  console.log(`  ${colors.yellow}警告:${colors.reset} ${results.warnings}`);
  console.log(`  ${colors.red}错误:${colors.reset} ${results.errors}`);
  console.log('');
}

// 主函数
function main() {
  console.log(`${colors.blue}扫描路由文件...${colors.reset}`);

  const routeFiles = scanRoutes(ROUTES_DIR);
  console.log(`找到 ${routeFiles.length} 个路由文件\n`);

  routeFiles.forEach(checkFile);
  printResults();

  // 根据结果设置退出码
  if (results.errors > 0) {
    process.exit(1);
  }
}

main();
