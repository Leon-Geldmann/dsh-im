import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensureProjectDirectory,
  isWorkspacePathError,
  rootFor,
  verifyExistingDirectory,
} from '../../../src/channels/discord/workbench/project-registry.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workbench-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'dsh-workbench-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  return { root, outside };
}

test('roots only contain their own subtree', async (t) => {
  const { root, outside } = await fixture(t);
  assert.equal(rootFor(join(root, 'alpha'), [root]), root);
  assert.equal(rootFor(root, [root]), root);
  assert.equal(rootFor(outside, [root]), null);
  assert.equal(rootFor(join(root, '..', 'elsewhere'), [root]), null);
});

test('binding an existing directory proves it is real and confined', async (t) => {
  const { root, outside } = await fixture(t);
  const project = join(root, 'alpha');
  await mkdir(project);
  assert.equal(await verifyExistingDirectory(project, [root]), project);
  await assert.rejects(
    verifyExistingDirectory(join(root, 'missing'), [root]),
    { code: 'workbench-path-missing' },
  );
  await assert.rejects(
    verifyExistingDirectory(outside, [root]),
    { code: 'workbench-path-outside-roots' },
  );
  const file = join(root, 'file.txt');
  await writeFile(file, 'x');
  await assert.rejects(
    verifyExistingDirectory(file, [root]),
    { code: 'workbench-path-not-directory' },
  );
  assert.equal(isWorkspacePathError(new Error('x')), false);
});

test('a symlink cannot bind a directory outside the roots', async (t) => {
  const { root, outside } = await fixture(t);
  const link = join(root, 'escape');
  await symlink(outside, link);
  await assert.rejects(
    verifyExistingDirectory(link, [root]),
    { code: 'workbench-path-outside-roots' },
  );
});

test('new project directories may only be created underneath a configured root', async (t) => {
  const { root, outside } = await fixture(t);
  const created = await ensureProjectDirectory(join(root, 'nested', 'project'), [root]);
  assert.equal(created, join(root, 'nested', 'project'));
  await assert.rejects(
    ensureProjectDirectory(join(outside, 'project'), [root]),
    { code: 'workbench-path-outside-roots' },
  );
  await assert.rejects(
    ensureProjectDirectory('relative/project', [root]),
    { code: 'workbench-path-invalid' },
  );
});

test('an unset root list refuses every bind', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    verifyExistingDirectory(root, []),
    { code: 'workbench-path-outside-roots' },
  );
});
