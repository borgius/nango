import { describe, expect, it } from 'vitest';

import { parseArgs, parseEnvFile, serializeEnvFile } from '../../scripts/cloudflare/deploy.js';

describe('cloudflare deploy script', () => {
    it('parses the deployment target arguments', () => {
        expect(parseArgs(['--target', 'cloudflare', '--env-file', '.env.custom', '--non-interactive'])).toEqual({
            target: 'cloudflare',
            envPath: '.env.custom',
            interactive: false
        });
    });

    it('throws when target is missing', () => {
        expect(() => parseArgs([])).toThrow('Missing required --target argument');
    });

    it('parses dotenv files and strips wrapping quotes', () => {
        expect(
            parseEnvFile(`
                CLOUDFLARE_API_TOKEN="token"
                CLOUDFLARE_ACCOUNT_ID='account'
                # comment
            `)
        ).toEqual({
            CLOUDFLARE_API_TOKEN: 'token',
            CLOUDFLARE_ACCOUNT_ID: 'account'
        });
    });

    it('serializes dotenv files in deterministic key order', () => {
        expect(
            serializeEnvFile({
                B: '2',
                A: '1'
            })
        ).toBe('A=1\nB=2\n');
    });
});
