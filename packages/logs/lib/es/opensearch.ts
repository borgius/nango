/**
 * OpenSearch-specific helpers for lifecycle management (ISM) and index pipeline alternatives.
 *
 * Key differences from Elasticsearch:
 * - No ILM (Index Lifecycle Management) → uses ISM (Index State Management) plugin
 * - No `date_index_name` ingest processor → indices are created without daily rotation
 * - ISM policies are attached via `index.plugins.index_state_management.policy_id` index setting
 */

/**
 * Build an OpenSearch ISM policy equivalent to the given ES ILM phases.
 * OpenSearch ISM uses state-machine semantics with explicit `states` + `transitions`.
 */
export function buildISMPolicy(opts: { policyId: string; deleteAfterDays: number }) {
    return {
        policy: {
            description: `Retention policy: delete after ${opts.deleteAfterDays} days`,
            default_state: 'hot',
            states: [
                {
                    name: 'hot',
                    actions: [],
                    transitions: [
                        {
                            state_name: 'delete',
                            conditions: {
                                min_index_age: `${opts.deleteAfterDays}d`
                            }
                        }
                    ]
                },
                {
                    name: 'delete',
                    actions: [{ delete: {} }],
                    transitions: []
                }
            ],
            ism_template: {
                index_patterns: [`${opts.policyId}*`],
                priority: 100
            }
        }
    };
}
