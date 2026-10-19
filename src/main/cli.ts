#!/usr/bin/env node
import { loadConfig } from '../infrastructure/config.js';
import { runCli } from '../presentation/cli/cli.js';
import { appVersion, buildAuditLog, buildUseCases } from './container.js';

const config = loadConfig();
process.exitCode = await runCli(process.argv.slice(2), buildUseCases(config), {
  env: process.env,
  out: text => console.log(text),
  err: text => console.error(text),
  isTTY: process.stdout.isTTY === true,
  status: process.stderr.isTTY ? { write: t => process.stderr.write(t), isTTY: true, columns: process.stderr.columns ?? 100 } : undefined,
  columns: process.stdout.columns ?? 100
}, appVersion, { policy: config.policy, audit: buildAuditLog(config) });
