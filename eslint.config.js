// Code checker. Run: npm run lint   (npm run lint:fix tidies what it can)
import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        files: ['js/**/*.js'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser } },
        rules: {
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
            'no-empty': ['warn', { allowEmptyCatch: true }]
        }
    },
    {
        files: ['functions/**/*.js'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
        rules: {
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
            'no-empty': ['warn', { allowEmptyCatch: true }]
        }
    },
    { ignores: ['node_modules/**', 'functions/node_modules/**'] }
];
