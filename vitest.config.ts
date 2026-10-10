import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: { '@portmii/mcp': fileURLToPath(new URL('./src/index.ts', import.meta.url)) }
	},
	test: {
		include: ['test/**/*.spec.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/**/index.ts', 'src/**/*.types.ts'],
			thresholds: {
				branches: 85,
				functions: 90,
				lines: 90,
				statements: 90
			}
		}
	}
});
