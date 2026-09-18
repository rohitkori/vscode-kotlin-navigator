import { report } from './harness';
import { run as runParser } from './parser.test';
import { run as runResolve } from './resolve.test';
import { run as runIntegration } from './integration.test';

async function main(): Promise<void> {
  runParser();
  runResolve();
  await runIntegration();
  process.exit(report());
}

void main();
