import { Client as ESClient } from '@elastic/elasticsearch';
import { Client as OSClient } from '@opensearch-project/opensearch';

import { envs } from '../env.js';
import { CircuitBreaker } from './circuitBreaker.js';

// Both clients expose the same REST-compatible surface for the operations used here.
// We keep `ESClient` as the shared type alias since its typings cover the full API.
type SearchClient = ESClient;

function createESClient(): SearchClient {
    return new ESClient({
        nodes: envs.NANGO_LOGS_ES_URL || 'http://localhost:0',
        requestTimeout: envs.NANGO_LOGS_ES_REQUEST_TIMEOUT_MS,
        maxRetries: envs.NANGO_LOGS_ES_MAX_RETRIES,
        auth: {
            username: envs.NANGO_LOGS_ES_USER!, // ggignore
            password: envs.NANGO_LOGS_ES_PWD! // ggignore
        }
    });
}

function createOSClient(): SearchClient {
    const osClient = new OSClient({
        nodes: envs.NANGO_LOGS_ES_URL || 'http://localhost:0',
        requestTimeout: envs.NANGO_LOGS_ES_REQUEST_TIMEOUT_MS,
        maxRetries: envs.NANGO_LOGS_ES_MAX_RETRIES,
        auth: {
            username: envs.NANGO_LOGS_ES_USER!, // ggignore
            password: envs.NANGO_LOGS_ES_PWD! // ggignore
        }
    });
    // Cast to SearchClient – API surface is REST-compatible for all operations used in this package
    return osClient as unknown as SearchClient;
}

const rawClient: SearchClient = envs.NANGO_LOGS_ES_TYPE === 'opensearch' ? createOSClient() : createESClient();

function withCircuitBreaker(target: SearchClient): SearchClient {
    const circuitBreaker = new CircuitBreaker({
        healthCheck: async () => {
            try {
                await target.cluster.health();
                return true;
            } catch {
                return false;
            }
        },
        healthCheckIntervalMs: envs.NANGO_LOGS_CIRCUIT_BREAKER_HEALTHCHECK_INTERVAL_MS,
        failureThreshold: envs.NANGO_LOGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
        recoveryThreshold: envs.NANGO_LOGS_CIRCUIT_BREAKER_RECOVERY_THRESHOLD
    });
    return new Proxy(target, {
        get(targetClient, prop) {
            const originalMethod = Reflect.get(targetClient, prop);

            if (typeof originalMethod !== 'function') {
                return originalMethod;
            }

            return async function (...args: any[]) {
                if (circuitBreaker.isUnhealthy()) {
                    throw new Error('Search backend circuit breaker is unhealthy - failing fast');
                }

                if (prop === 'close') {
                    circuitBreaker.destroy();
                }

                return await originalMethod.apply(targetClient, args);
            };
        }
    });
}

export const client = withCircuitBreaker(rawClient);
