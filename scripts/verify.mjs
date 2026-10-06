// `pnpm verify`: todo lo que debe pasar antes de un commit (CLAUDE.md §1). Se detiene en el
// primer paso que falle. Requiere PostgreSQL y Redis levantados (docker compose up -d).
import { spawnSync } from 'node:child_process';

const GENERATED = ['apps/api/openapi.json', 'packages/shared/src/generated'];

const steps = [
  ['Lint', 'pnpm', ['lint']],
  ['Typecheck', 'pnpm', ['typecheck']],
  ['Formato', 'pnpm', ['format:check']],
  ['Pruebas unitarias', 'pnpm', ['test']],
  ['Pruebas e2e', 'pnpm', ['test:e2e']],
  ['Cobertura de availability (mínimo 80 %)', 'pnpm', ['--filter', 'api', 'test:cov:availability']],
  ['Cobertura de search (mínimo 80 %)', 'pnpm', ['--filter', 'api', 'test:cov:search']],
  [
    'Cobertura de bookings y payments (mínimo 80 %)',
    'pnpm',
    ['--filter', 'api', 'test:cov:bookings'],
  ],
  [
    'Generar OpenAPI y tipos de packages/shared',
    'pnpm',
    ['--filter', '@charles/shared', 'generate'],
  ],
  // Lo generado debe coincidir con lo versionado (en un commit, con lo que está en el índice).
  ['OpenAPI y tipos al día', 'git', ['diff', '--exit-code', '--stat', '--', ...GENERATED]],
  ['Auditoría de dependencias (high)', 'pnpm', ['audit', '--audit-level=high']],
];

const started = Date.now();
for (const [index, [title, command, args]] of steps.entries()) {
  console.log(`\n▶ [${index + 1}/${steps.length}] ${title}`);
  // En Windows, pnpm es un .cmd y necesita shell; los argumentos son fijos (no hay entrada externa).
  const result =
    process.platform === 'win32'
      ? spawnSync([command, ...args].join(' '), { stdio: 'inherit', shell: true })
      : spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n✖ Falló: ${title}`);
    if (title === 'OpenAPI y tipos al día') {
      console.error('  Se regeneraron; revisa el cambio y agrégalo al commit (git add).');
    }
    process.exit(result.status ?? 1);
  }
}
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`\n✔ pnpm verify: todo pasó (${steps.length} pasos, ${seconds} s).`);
