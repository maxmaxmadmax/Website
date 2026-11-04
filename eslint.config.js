// Code checker. Run: npm run lint   (npm run lint:fix tidies what it can)
import js from '@eslint/js';
import globals from 'globals';
import fs from 'fs';

/* The admin page's plain scripts (the defer tags in admin.html) share one page scope, so each may use
   what the others declare at the top level, plus what boot.js hands over. Everything else is a module. */
const adminHtml = fs.readFileSync('pages/admin/admin.html', 'utf8');
const adminScripts = [...adminHtml.matchAll(/src="(js\/admin\/[\w-]+\.js)\?v=\d+" defer/g)].map((m) => m[1]);
const adminNames = {};
for (const f of adminScripts.concat('js/admin/boot.js')) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/^(?:async )?function\*? (\w+)|^(?:const|let|var) (\w+)/gm)) adminNames[m[1] || m[2]] = 'writable';
    for (const m of s.matchAll(/^import \{([^}]*)\}/gm)) {
        for (const name of m[1].split(','))
            adminNames[
                name
                    .trim()
                    .split(/\s+as\s+/)
                    .pop()
            ] = 'readonly';
    }
}

const rules = {
    'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    'no-empty': ['warn', { allowEmptyCatch: true }]
};

export default [
    js.configs.recommended,
    {
        files: ['js/**/*.js'],
        ignores: adminScripts,
        languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser } },
        rules
    },
    {
        files: adminScripts,
        languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser, ...adminNames } },
        rules: {
            ...rules,
            // top-level names are used by the other admin files, so only local ones are checked here
            'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none' }],
            'no-redeclare': 'off'
        }
    },
    {
        files: ['functions/**/*.js'],
        languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
        rules
    },
    { ignores: ['node_modules/**', 'functions/node_modules/**'] }
];
