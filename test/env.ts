/**
 * Preloaded for every test process (`node --import ./test/env.ts --test …`).
 * The service's own configuration is in the environment of anything started
 * from its terminal: CODETERM_ALLOW_BYPASS=1, ports, tokens. Tests assume the
 * defaults, so five of them failed for whoever ran them from such a shell
 * (and the pre-push hook only passed once the variables were unset by hand).
 * Clear them here, so the suite means the same thing wherever it runs.
 */
for (const k of Object.keys(process.env)) if (k.startsWith("CODETERM_")) delete process.env[k];
