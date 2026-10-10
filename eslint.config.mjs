import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['coverage/**', 'dist/**', 'node_modules/**']
	},
	eslint.configs.recommended,
	...tseslint.configs.strictTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ['*.mjs', 'scripts/*.mjs']
				},
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			'@typescript-eslint/consistent-type-imports': 'error',
			'@typescript-eslint/no-confusing-void-expression': 'off',
			'@typescript-eslint/no-unnecessary-condition': 'off'
		}
	},
	{
		files: ['test/**/*.ts'],
		rules: {
			'@typescript-eslint/require-await': 'off'
		}
	},
	{
		files: ['**/*.mjs'],
		...tseslint.configs.disableTypeChecked
	}
);
