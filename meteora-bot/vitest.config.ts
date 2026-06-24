import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // better-sqlite3 — нативный аддон; гоняем тесты в форк-процессе и грузим его
    // нативным require (а не через Vite-трансформацию), иначе bindings не находит .node.
    pool: 'forks',
    server: {
      deps: {
        external: ['better-sqlite3'],
      },
    },
  },
});
