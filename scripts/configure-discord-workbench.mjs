#!/usr/bin/env node
/**
 * Configure the Discord Guild workbench block of one bot without editing JSON
 * by hand.
 *
 * Usage:
 *   node scripts/configure-discord-workbench.mjs --config <config.json> \
 *     --bot <botId> --guild <guildId> [--allow <userId> ...] \
 *     [--root <absolutePath> ...] [--max-tasks N] [--project-concurrency N]
 *   node scripts/configure-discord-workbench.mjs --config <config.json> --bot <botId> --disable
 *
 * The command never prints or copies credentials: only the workbench block is
 * touched, and a timestamped backup of the previous document is written first.
 */
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function parseArgs(argv) {
  const result = { allow: [], root: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    switch (arg) {
      case '--config': result.config = next(); break;
      case '--bot': result.bot = next(); break;
      case '--guild': result.guild = next(); break;
      case '--allow': result.allow.push(next()); break;
      case '--root': result.root.push(next()); break;
      case '--max-tasks': result.maxTasks = Number(next()); break;
      case '--project-concurrency': result.projectConcurrency = Number(next()); break;
      case '--disable': result.disable = true; break;
      case '--help': result.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return result;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/configure-discord-workbench.mjs --config <config.json> --bot <botId> \\',
    '    --guild <guildId> [--allow <userId> ...] [--root <absolutePath> ...] \\',
    '    [--max-tasks N] [--project-concurrency N]',
    '  node scripts/configure-discord-workbench.mjs --config <config.json> --bot <botId> --disable',
  ].join('\n');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (!args.config) throw new Error(`--config is required\n\n${usage()}`);
if (!args.bot) throw new Error(`--bot is required\n\n${usage()}`);
if (!args.disable && !args.guild) throw new Error(`--guild is required unless --disable is used\n\n${usage()}`);

const path = resolve(args.config);
const document = JSON.parse(await readFile(path, 'utf8'));
if (!document || document.version !== 1 || !Array.isArray(document.bots)) {
  throw new Error('the Discord config document is not a version 1 bot list');
}
const index = document.bots.findIndex((bot) => bot?.botId === args.bot);
if (index === -1) {
  throw new Error(`bot ${args.bot} is not present in ${path}`);
}
const bot = document.bots[index];

const workbench = args.disable ? { enabled: false }
  : {
    enabled: true,
    guildId: String(args.guild),
    allowedUserIds: args.allow.map(String),
    projectRoots: args.root.map((root) => resolve(root)),
    ...(Number.isSafeInteger(args.maxTasks) ? { maxConcurrentTasks: args.maxTasks } : {}),
    ...(Number.isSafeInteger(args.projectConcurrency)
      ? { projectConcurrency: args.projectConcurrency } : {}),
  };

const backup = `${path}.bak-workbench-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
await copyFile(path, backup);
document.bots[index] = { ...bot, workbench };
await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

console.log(`workbench ${args.disable ? 'disabled' : 'enabled'} for ${args.bot}`);
console.log(`backup: ${backup}`);
console.log('Restart the Discord bot (or reconnect it from the DSH settings page) to apply.');
