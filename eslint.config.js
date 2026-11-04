// Code checker. Run: npm run lint   (npm run lint:fix tidies what it can)
import js from '@eslint/js';
import globals from 'globals';
import fs from 'fs';

/* The admin files (js/admin/) are plain scripts sharing one page scope, so each one may use what the
   others declare at the top level, plus what boot.js hands over. */
const adminNames = {};
for (const f of fs.readdirSync('js/admin').filter((x) => x.endsWith('.js'))) {
    const s = fs.readFileSync('js/admin/' + f, 'utf8');
    for (const m of s.matchAll(/^(?:async )?function\*? (\w+)|^(?:const|let|var) (\w+)/gm)) adminNames[m[1] || m[2]] = 'writable';
    for (const m of s.matchAll(/^import \{([^}]*)\}/gm))
        m[1].split(',').forEach(
            (x) =>
                (adminNames[
                    x
                        .trim()
                        .split(/\s+as\s+/)
                        .pop()
                ] = 'readonly')
        );
}

export default [
    js.configs.recommended,
    {
        files: ['js/**/*.js'],
        ignores: ['js/admin/*.js'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser } },
        rules: {
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
            'no-empty': ['warn', { allowEmptyCatch: true }]
        }
    },
    {
        files: ['js/admin/*.js'],
        ignores: ['js/admin/boot.js'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser, ...adminNames } },
        rules: {
            // top-level names are used by the other admin files, so only local ones are checked here
            'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none' }],
            'no-redeclare': 'off',
            'no-empty': ['warn', { allowEmptyCatch: true }]
        }
    },
    {
        files: ['js/admin/boot.js'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser } }
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
