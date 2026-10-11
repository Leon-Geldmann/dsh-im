import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Project workspace containment for the Guild workbench.
 *
 * A project always points at an explicit absolute directory. New directories
 * may only be created underneath one of the configured project roots, and an
 * existing directory is accepted only after it resolves inside a root, so a
 * symlink cannot escape the operator's confinement.
 */

export class WorkspacePathError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function normalizeRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) return null;
  return resolve(root);
}

function contains(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** Find the configured root that contains `path`, if any. */
export function rootFor(path, projectRoots = []) {
  const candidate = resolve(path);
  for (const root of projectRoots) {
    const normalized = normalizeRoot(root);
    if (normalized && contains(normalized, candidate)) return normalized;
  }
  return null;
}

async function realpathOrNull(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Resolve the deepest existing ancestor of `path` and prove that both it and
 * its configured root live inside the confinement after symlink resolution.
 */
async function assertConfined(path, projectRoots) {
  const candidate = resolve(path);
  const root = rootFor(candidate, projectRoots);
  if (!root) {
    throw new WorkspacePathError(
      'workbench-path-outside-roots',
      'The directory is outside the configured project roots.',
    );
  }
  const realRoot = await realpathOrNull(root);
  if (!realRoot) {
    throw new WorkspacePathError(
      'workbench-root-missing',
      'The configured project root does not exist yet.',
    );
  }
  let ancestor = candidate;
  for (;;) {
    const resolved = await realpathOrNull(ancestor);
    if (resolved) {
      if (!contains(realRoot, resolved)) {
        throw new WorkspacePathError(
          'workbench-path-outside-roots',
          'The directory resolves outside the configured project roots.',
        );
      }
      return { root: realRoot, candidate, realAncestor: resolved };
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new WorkspacePathError(
        'workbench-path-unresolvable',
        'The directory cannot be resolved.',
      );
    }
    ancestor = parent;
  }
}

/** Bind an existing directory, proving it is real and confined. */
export async function verifyExistingDirectory(path, projectRoots) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new WorkspacePathError('workbench-path-invalid', 'An absolute directory path is required.');
  }
  const { realAncestor } = await assertConfined(path, projectRoots);
  const resolved = await realpathOrNull(path);
  if (!resolved || !contains(realAncestor, resolved)) {
    throw new WorkspacePathError('workbench-path-missing', 'The directory does not exist.');
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new WorkspacePathError('workbench-path-not-directory', 'The path is not a directory.');
  }
  return resolved;
}

/** Create (or accept) a project directory underneath a configured root. */
export async function ensureProjectDirectory(path, projectRoots) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new WorkspacePathError('workbench-path-invalid', 'An absolute directory path is required.');
  }
  await assertConfined(path, projectRoots);
  await mkdir(path, { recursive: true, mode: 0o750 });
  return verifyExistingDirectory(path, projectRoots);
}

export function isWorkspacePathError(error) {
  return error instanceof WorkspacePathError;
}
