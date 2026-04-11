import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDeployment } from '../../scripts/cloudflare/deploy.js';

describe('cloudflare deploy script e2e', () => {
    const createdDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(createdDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
        createdDirs.length = 0;
    });

    it('fills missing env values, provisions resources, and writes a manifest', async () => {
        const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'nango-cloudflare-'));
        createdDirs.push(cwd);

        await fs.writeFile(
            path.join(cwd, '.env.cloudflare'),
            ['CLOUDFLARE_API_TOKEN=token', 'CLOUDFLARE_ACCOUNT_ID=account', 'CLOUDFLARE_WORKER_NAME=nango'].join('\n')
        );

        const promptValues = ['control-db', 'cache-kv', 'artifacts-bucket', 'jobs-queue'];
        const prompt = vi.fn(() => Promise.resolve(promptValues.shift() || ''));
        const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const url = getUrl(input);
            const isCreate = Boolean(init?.method && init.method !== 'GET');

            if (url.endsWith('/d1/databases') && !isCreate) {
                return Promise.resolve(jsonResponse([]));
            }
            if (url.endsWith('/d1/databases') && init?.method === 'POST') {
                return Promise.resolve(jsonResponse({ uuid: 'd1-id', name: 'control-db' }));
            }
            if (url.endsWith('/storage/kv/namespaces') && !isCreate) {
                return Promise.resolve(jsonResponse([]));
            }
            if (url.endsWith('/storage/kv/namespaces') && init?.method === 'POST') {
                return Promise.resolve(jsonResponse({ id: 'kv-id', title: 'cache-kv' }));
            }
            if (url.endsWith('/r2/buckets') && !isCreate) {
                return Promise.resolve(jsonResponse([]));
            }
            if (url.includes('/r2/buckets/artifacts-bucket') && init?.method === 'PUT') {
                return Promise.resolve(jsonResponse({ name: 'artifacts-bucket' }));
            }
            if (url.endsWith('/queues') && !isCreate) {
                return Promise.resolve(jsonResponse([]));
            }
            if (url.endsWith('/queues') && init?.method === 'POST') {
                return Promise.resolve(jsonResponse({ id: 'queue-id', name: 'jobs-queue' }));
            }

            throw new Error(`Unhandled request ${init?.method || 'GET'} ${url}`);
        }) as typeof fetch;

        const logs: string[] = [];
        const summary = await runDeployment({
            cwd,
            target: 'cloudflare',
            interactive: true,
            prompt,
            fetchFn,
            log: (message) => logs.push(message)
        });

        expect(summary.resources).toEqual([
            { kind: 'd1', name: 'control-db', id: 'd1-id', action: 'created' },
            { kind: 'kv', name: 'cache-kv', id: 'kv-id', action: 'created' },
            { kind: 'r2', name: 'artifacts-bucket', id: 'artifacts-bucket', action: 'created' },
            { kind: 'queue', name: 'jobs-queue', id: 'queue-id', action: 'created' }
        ]);
        expect(prompt).toHaveBeenCalledTimes(4);
        expect(fetchFn).toHaveBeenCalledTimes(8);
        expect(logs.at(-1)).toContain('Cloudflare bootstrap complete');

        await expect(fs.readFile(path.join(cwd, '.env.cloudflare'), 'utf8')).resolves.toContain('CLOUDFLARE_QUEUE=jobs-queue');
        await expect(fs.readFile(path.join(cwd, 'cloudflare.resources.json'), 'utf8')).resolves.toContain('"postgresReplacement"');
    });
});

function getUrl(input: RequestInfo | URL): string {
    if (input instanceof URL) {
        return input.href;
    }
    if (typeof input === 'string') {
        return input;
    }
    return input.url;
}

function jsonResponse(result: unknown, init?: ResponseInit): Response {
    return new Response(
        JSON.stringify({
            success: true,
            result
        }),
        {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            ...init
        }
    );
}
