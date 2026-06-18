import path from 'node:path';

/**
 * 将相对/绝对路径解析为工作目录内的安全绝对路径。
 * 若解析结果越出工作目录，则抛出错误（基础安全防护）。
 */
export function resolveSafe(workdir: string, target: string): string {
  const base = path.resolve(workdir);
  const resolved = path.resolve(base, target);
  const rel = path.relative(base, resolved);
  if (rel === '' ) return resolved;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界，禁止访问工作目录之外: ${target}`);
  }
  return resolved;
}

export function displayPath(workdir: string, abs: string): string {
  const rel = path.relative(path.resolve(workdir), abs);
  return rel === '' ? '.' : rel;
}
