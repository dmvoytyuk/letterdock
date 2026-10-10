// Opt-in timing benchmarks (not run by `npm test`).
import { spawnSync } from 'node:child_process';
const r = spawnSync('npx', ['vitest', 'run', 'tests/unit/contacts.test.ts', '-t', 'benchmark'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, BENCH: '1' },
});
process.exit(r.status ?? 1);
