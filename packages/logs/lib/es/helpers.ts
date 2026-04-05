import { errors as ESErrors } from '@elastic/elasticsearch';
import { errors as OSErrors } from '@opensearch-project/opensearch';

import { Err, Ok, isTest } from '@nangohq/utils';

import { envs } from '../env.js';
import { logger } from '../utils.js';
import { client } from './client.js';
import { buildISMPolicy } from './opensearch.js';
import { getDailyIndexPipeline, indexMessages, indexOperations, policyMessages, policyOperations } from './schema.js';
import { getFormattedMessage, getFormattedOperation } from '../models/helpers.js';
import { createMessage } from '../models/messages.js';
import { createOperation } from '../models/operations.js';

import type { Result } from '@nangohq/utils';

const isOpenSearch = envs.NANGO_LOGS_ES_TYPE === 'opensearch';

export async function start() {
    if (!envs.NANGO_LOGS_ENABLED) {
        logger.warning(`${isOpenSearch ? 'OpenSearch' : 'Elasticsearch'} is disabled, skipping`);
        return;
    }

    logger.info(`🔄 ${isOpenSearch ? 'OpenSearch' : 'Elasticsearch'} service starting...`);

    const res = await migrateMapping();

    if (res.isErr()) {
        if (res.error.message === 'failed_to_connect_elasticsearch') {
            logger.error(`❌ ${isOpenSearch ? 'OpenSearch' : 'Elasticsearch'} connection failed. Skipping migration`);
            return;
        } else {
            logger.error(`❌ ${isOpenSearch ? 'OpenSearch' : 'Elasticsearch'} initialization failed`);
            throw res.error;
        }
    }
    logger.info(`✅ ${isOpenSearch ? 'OpenSearch' : 'Elasticsearch'}`);
}

export async function migrateMapping(): Promise<Result<void>> {
    try {
        if (isOpenSearch) {
            await migrateOpenSearch();
        } else {
            await migrateElasticsearch();
        }
        return Ok(undefined);
    } catch (err) {
        const isConnectionError = err instanceof ESErrors.ConnectionError || err instanceof OSErrors.ConnectionError;
        const errMsg = isConnectionError ? 'failed_to_connect_elasticsearch' : 'failed_to_init_elasticsearch';
        logger.error(errMsg);
        return Err(errMsg);
    }
}

async function migrateElasticsearch(): Promise<void> {
    for (const index of [indexMessages, indexOperations]) {
        logger.info(`Migrating index "${index.index}"...`);
        const isMessages = index.index.includes('messages');

        // -- Policy
        logger.info(`  Updating policy`);
        await client.ilm.putLifecycle(isMessages ? policyMessages : policyOperations);

        // -- Index
        const existsTemplate = await client.indices.existsIndexTemplate({ name: `${index.index}-template` });
        logger.info(`  ${existsTemplate ? 'updating' : 'creating'} index template "${index.index}"...`);

        await client.indices.putIndexTemplate({
            name: `${index.index}-template`,
            index_patterns: `${index.index}.*`,
            template: {
                settings: index.settings!,
                mappings: index.mappings!,
                aliases: { [index.index]: {} }
            }
        });

        // -- Pipeline
        // Pipeline will automatically create an index based on a field
        // In our case we create a daily index based on "createdAt"
        logger.info(`  Updating pipeline`);
        await client.ingest.putPipeline(getDailyIndexPipeline(index.index));

        const existsAlias = await client.indices.exists({ index: index.index });
        if (!existsAlias) {
            // insert a dummy record to create first index
            logger.info(`  Inserting dummy record`);
            if (index.index.includes('messages')) {
                await createMessage(getFormattedMessage({ parentId: '-1', accountId: 0 }));
            } else {
                await createOperation(getFormattedOperation({ id: '-1', accountId: 0, operation: { type: 'sync', action: 'run' } }));
            }
        }
    }
}

async function migrateOpenSearch(): Promise<void> {
    for (const index of [indexMessages, indexOperations]) {
        logger.info(`Migrating OpenSearch index "${index.index}"...`);
        const isMessages = index.index.includes('messages');
        const policyId = isMessages ? policyMessages.name : policyOperations.name;

        // -- ISM Policy (replaces Elasticsearch ILM)
        logger.info(`  Updating ISM policy "${policyId}"`);
        await (client as any).transport.request({
            method: 'PUT',
            path: `/_plugins/_ism/policies/${encodeURIComponent(policyId)}`,
            body: buildISMPolicy({ policyId: index.index, deleteAfterDays: 15 })
        });

        // -- Index template (OpenSearch supports composable index templates like ES)
        const existsTemplate = await client.indices.existsIndexTemplate({ name: `${index.index}-template` });
        logger.info(`  ${existsTemplate ? 'updating' : 'creating'} index template "${index.index}"...`);

        // Build settings without ILM (lifecycle); attach ISM policy instead
        const { lifecycle: _lifecycle, ...settingsWithoutLifecycle } = (index.settings as any) || {};
        await client.indices.putIndexTemplate({
            name: `${index.index}-template`,
            index_patterns: [`${index.index}*`],
            template: {
                settings: {
                    ...settingsWithoutLifecycle,
                    'index.plugins.index_state_management.policy_id': policyId
                },
                mappings: index.mappings!,
                aliases: { [index.index]: {} }
            }
        });

        // OpenSearch does NOT support the `date_index_name` ingest processor, so we skip
        // the daily index pipeline. All documents are written to the base index and rotated
        // by the ISM policy instead.

        const existsAlias = await client.indices.exists({ index: index.index });
        if (!existsAlias) {
            logger.info(`  Inserting dummy record`);
            if (index.index.includes('messages')) {
                await createMessage(getFormattedMessage({ parentId: '-1', accountId: 0 }));
            } else {
                await createOperation(getFormattedOperation({ id: '-1', accountId: 0, operation: { type: 'sync', action: 'run' } }));
            }
        }
    }
}

export async function deleteIndex({ prefix }: { prefix: string }) {
    if (!isTest) {
        throw new Error('Trying to delete stuff in prod');
    }

    try {
        const indices = await client.cat.indices({ format: 'json' });
        await Promise.all(
            indices.map(async (index) => {
                if (!index.index?.startsWith(prefix)) {
                    return;
                }

                await client.indices.delete({ index: index.index, ignore_unavailable: true });
            })
        );
    } catch (err) {
        logger.error(err);
        throw new Error('failed_to_deleteIndex');
    }
}
