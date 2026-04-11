import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

type DeployTarget = 'cloudflare' | 'regular';
type ResourceKind = 'd1' | 'kv' | 'r2' | 'queue';
type PromptFn = (message: string) => Promise<string>;
type LogFn = (message: string) => void;
type FetchFn = typeof fetch;

interface ParsedArgs {
    target: DeployTarget;
    envPath?: string;
    interactive: boolean;
}

interface CloudflareEnv {
    CLOUDFLARE_API_TOKEN: string;
    CLOUDFLARE_ACCOUNT_ID: string;
    CLOUDFLARE_WORKER_NAME: string;
    CLOUDFLARE_D1_DATABASE: string;
    CLOUDFLARE_KV_NAMESPACE: string;
    CLOUDFLARE_R2_BUCKET: string;
    CLOUDFLARE_QUEUE: string;
}

interface DeploymentOptions {
    cwd?: string;
    target: DeployTarget;
    envPath?: string;
    interactive?: boolean;
    prompt?: PromptFn;
    fetchFn?: FetchFn;
    log?: LogFn;
}

interface ResourceSummary {
    kind: ResourceKind;
    name: string;
    id: string | null;
    action: 'created' | 'existing';
}

interface DeploymentSummary {
    target: DeployTarget;
    envPath: string | null;
    manifestPath: string | null;
    notes: string[];
    resources: ResourceSummary[];
}

interface CloudflareApiResponse<T> {
    success: boolean;
    result: T;
    errors?: { message?: string }[];
}

const DEFAULT_ENV_PATH = '.env.cloudflare';
const DEFAULT_MANIFEST_PATH = 'cloudflare.resources.json';
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const REQUIRED_ENV_KEYS = [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_WORKER_NAME',
    'CLOUDFLARE_D1_DATABASE',
    'CLOUDFLARE_KV_NAMESPACE',
    'CLOUDFLARE_R2_BUCKET',
    'CLOUDFLARE_QUEUE'
] as const satisfies readonly (keyof CloudflareEnv)[];

export function parseArgs(argv: string[]): ParsedArgs {
    let target: DeployTarget | null = null;
    let envPath: string | undefined;
    let interactive = process.stdin.isTTY;

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];

        if (arg === '--target') {
            const value = argv[index + 1];
            if (value === 'cloudflare' || value === 'regular') {
                target = value;
                index++;
                continue;
            }
            throw new Error('Missing or invalid value for --target. Expected "cloudflare" or "regular".');
        }

        if (arg === '--env-file') {
            envPath = argv[index + 1];
            if (!envPath) {
                throw new Error('Missing value for --env-file.');
            }
            index++;
            continue;
        }

        if (arg === '--non-interactive') {
            interactive = false;
        }
    }

    if (!target) {
        throw new Error('Missing required --target argument. Expected "cloudflare" or "regular".');
    }

    return { target, envPath, interactive };
}

export async function runDeployment({
    cwd = process.cwd(),
    target,
    envPath = DEFAULT_ENV_PATH,
    interactive = process.stdin.isTTY,
    prompt = createPrompt(),
    fetchFn = fetch,
    log = console.log
}: DeploymentOptions): Promise<DeploymentSummary> {
    if (target === 'regular') {
        log('Using the existing self-hosted deployment path for regular hosting.');
        log('See docs/guides/platform/self-hosting.mdx and scripts/build_docker_self_hosted.sh for the current regular-hosting flow.');
        return {
            target,
            envPath: null,
            manifestPath: null,
            notes: ['Regular hosting keeps the existing self-hosted image and infrastructure flow.'],
            resources: []
        };
    }

    const resolvedEnvPath = path.resolve(cwd, envPath);
    const envs = await loadOrCreateCloudflareEnv({ filePath: resolvedEnvPath, interactive, prompt });
    const cloudflareEnv = toCloudflareEnv(envs);
    const resources = await ensureCloudflareResources({ envs: cloudflareEnv, fetchFn });
    const manifestPath = path.resolve(cwd, DEFAULT_MANIFEST_PATH);

    await fs.writeFile(
        manifestPath,
        `${JSON.stringify(
            {
                workerName: cloudflareEnv.CLOUDFLARE_WORKER_NAME,
                resources: {
                    postgresReplacement: resources.find((resource) => resource.kind === 'd1') ?? null,
                    redisReplacement: resources.find((resource) => resource.kind === 'kv') ?? null,
                    objectStorageReplacement: resources.find((resource) => resource.kind === 'r2') ?? null,
                    queueReplacement: resources.find((resource) => resource.kind === 'queue') ?? null
                }
            },
            null,
            2
        )}\n`
    );

    log(`Cloudflare bootstrap complete. Resource manifest written to ${manifestPath}.`);

    return {
        target,
        envPath: resolvedEnvPath,
        manifestPath,
        notes: [
            'The script provisions native Cloudflare replacements for Postgres, Redis, object storage, and queueing.',
            'Runtime migration of the Node services to Workers remains a separate follow-up tracked in docs/guides/platform/cloudflare-workers.mdx.'
        ],
        resources
    };
}

export async function loadOrCreateCloudflareEnv({
    filePath,
    interactive,
    prompt
}: {
    filePath: string;
    interactive: boolean;
    prompt: PromptFn;
}): Promise<Record<string, string>> {
    const examplePath = path.resolve(path.dirname(filePath), '.env.cloudflare.example');
    const current = {
        ...parseEnvFile(await readIfExists(examplePath)),
        ...parseEnvFile(await readIfExists(filePath))
    };
    const missing = REQUIRED_ENV_KEYS.filter((key) => !current[key]);

    if (missing.length === 0) {
        return current;
    }

    if (!interactive) {
        throw new Error(`Missing required Cloudflare configuration in ${filePath}: ${missing.join(', ')}`);
    }

    const updates: Record<string, string> = { ...current };
    for (const key of missing) {
        const value = (await prompt(`Enter ${key}: `)).trim();
        if (!value) {
            throw new Error(`A value is required for ${key}`);
        }
        updates[key] = value;
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, serializeEnvFile(updates));

    return updates;
}

export function parseEnvFile(content: string): Record<string, string> {
    return content
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .reduce<Record<string, string>>((accumulator, line) => {
            const separatorIndex = line.indexOf('=');
            if (separatorIndex === -1) {
                return accumulator;
            }

            const key = line.slice(0, separatorIndex).trim();
            const value = line.slice(separatorIndex + 1).trim();
            accumulator[key] = stripWrappingQuotes(value);
            return accumulator;
        }, {});
}

export function serializeEnvFile(envs: Record<string, string>): string {
    return `${Object.keys(envs)
        .sort()
        .map((key) => `${key}=${envs[key]}`)
        .join('\n')}\n`;
}

export async function ensureCloudflareResources({ envs, fetchFn }: { envs: CloudflareEnv; fetchFn: FetchFn }): Promise<ResourceSummary[]> {
    const api = createCloudflareClient({ accountId: envs.CLOUDFLARE_ACCOUNT_ID, apiToken: envs.CLOUDFLARE_API_TOKEN, fetchFn });

    const d1 = await ensureResource({
        kind: 'd1',
        name: envs.CLOUDFLARE_D1_DATABASE,
        list: async () => api.get<{ uuid?: string; id?: string; name?: string }[]>('/d1/databases'),
        create: async (name) => api.post<{ uuid?: string; id?: string; name?: string }>('/d1/databases', { name }),
        matcher: (resource, name) => resource.name === name,
        identifier: (resource) => resource.uuid ?? resource.id ?? null
    });

    const kv = await ensureResource({
        kind: 'kv',
        name: envs.CLOUDFLARE_KV_NAMESPACE,
        list: async () => api.get<{ id?: string; title?: string }[]>('/storage/kv/namespaces'),
        create: async (name) => api.post<{ id?: string; title?: string }>('/storage/kv/namespaces', { title: name }),
        matcher: (resource, name) => resource.title === name,
        identifier: (resource) => resource.id ?? null
    });

    const r2 = await ensureResource({
        kind: 'r2',
        name: envs.CLOUDFLARE_R2_BUCKET,
        list: async () => api.get<{ name?: string }[]>('/r2/buckets'),
        create: async (name) => api.put<{ name?: string }>(`/r2/buckets/${encodeURIComponent(name)}`),
        matcher: (resource, name) => resource.name === name,
        identifier: (resource) => resource.name ?? null
    });

    const queue = await ensureResource({
        kind: 'queue',
        name: envs.CLOUDFLARE_QUEUE,
        list: async () => api.get<{ id?: string; name?: string; queue_name?: string }[]>('/queues'),
        create: async (name) => api.post<{ id?: string; name?: string; queue_name?: string }>('/queues', { name }),
        matcher: (resource, name) => resource.name === name || resource.queue_name === name,
        identifier: (resource) => resource.id ?? resource.name ?? resource.queue_name ?? null
    });

    return [d1, kv, r2, queue];
}

async function ensureResource<T>({
    kind,
    name,
    list,
    create,
    matcher,
    identifier
}: {
    kind: ResourceKind;
    name: string;
    list: () => Promise<T[]>;
    create: (name: string) => Promise<T>;
    matcher: (resource: T, name: string) => boolean;
    identifier: (resource: T) => string | null;
}): Promise<ResourceSummary> {
    const existing = (await list()).find((resource) => matcher(resource, name));
    if (existing) {
        return { kind, name, id: identifier(existing), action: 'existing' };
    }

    const created = await create(name);
    return { kind, name, id: identifier(created), action: 'created' };
}

function createCloudflareClient({ accountId, apiToken, fetchFn }: { accountId: string; apiToken: string; fetchFn: FetchFn }) {
    const request = async <T>(resourcePath: string, init?: RequestInit): Promise<T> => {
        const headers = {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
        };
        const response = await fetchFn(`${CLOUDFLARE_API_BASE}/accounts/${accountId}${resourcePath}`, {
            ...init,
            headers
        });

        const payload = (await response.json()) as CloudflareApiResponse<T>;
        if (!response.ok || !payload.success) {
            const message =
                payload.errors
                    ?.map((error) => error.message)
                    .filter(Boolean)
                    .join(', ') ||
                response.statusText ||
                'Cloudflare API request failed';
            throw new Error(message);
        }

        return payload.result;
    };

    return {
        get: <T>(resourcePath: string) => request<T>(resourcePath),
        post: <T>(resourcePath: string, body: unknown) =>
            request<T>(resourcePath, {
                method: 'POST',
                body: JSON.stringify(body)
            }),
        put: <T>(resourcePath: string, body?: unknown) =>
            request<T>(resourcePath, {
                method: 'PUT',
                body: body ? JSON.stringify(body) : undefined
            })
    };
}

function toCloudflareEnv(envs: Record<string, string>): CloudflareEnv {
    return REQUIRED_ENV_KEYS.reduce<CloudflareEnv>((accumulator, key) => {
        accumulator[key] = envs[key] || '';
        return accumulator;
    }, {} as CloudflareEnv);
}

async function readIfExists(filePath: string): Promise<string> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return '';
        }
        throw err;
    }
}

function stripWrappingQuotes(value: string): string {
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        return value.slice(1, -1);
    }
    return value;
}

function createPrompt(): PromptFn {
    return async (message: string) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
            return await rl.question(message);
        } finally {
            rl.close();
        }
    };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    await runDeployment({ target: args.target, envPath: args.envPath, interactive: args.interactive });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
    });
}
