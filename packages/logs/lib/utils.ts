import { errors as ESErrors } from '@elastic/elasticsearch';
import { errors as OSErrors } from '@opensearch-project/opensearch';

import { getLogger } from '@nangohq/utils';

import { envs } from './env.js';
import { client } from './es/client.js';

export const logger = getLogger('logs');

export const isCli = process.argv.find((value) => value.includes('/bin/nango') || value.includes('cli/dist/index'));

export async function destroy() {
    logger.info('Destroying logs...');
    await client.close();
}

export const logLevelToLogger = {
    info: 'info',
    debug: 'debug',
    error: 'error',
    warn: 'warning',
    http: 'info',
    verbose: 'debug',
    silly: 'debug'
} as const;

// Use the ResponseError from the configured backend (ES or OpenSearch).
// Both classes have a compatible interface – cast to ES type to keep downstream
// code unchanged.
export const ResponseError =
    envs.NANGO_LOGS_ES_TYPE === 'opensearch' ? (OSErrors.ResponseError as unknown as typeof ESErrors.ResponseError) : ESErrors.ResponseError;
