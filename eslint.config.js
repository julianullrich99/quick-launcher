import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {ignores: ['dist/', 'build/', 'node_modules/']},
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts', 'tools/driver/*.js'],
        languageOptions: {globals: {global: 'readonly'}},
    },
    {
        files: ['test/**/*.ts', 'scripts/**/*.js', '*.js'],
        languageOptions: {globals: globals.node},
    },
    {
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
            'no-empty': ['error', {allowEmptyCatch: true}],
            'prefer-const': 'error',
            'eqeqeq': ['error', 'smart'],
        },
    },
);
