import type { components, OarsClient } from '@manyoars/oars-client';
import { apiClient, unwrap } from '../api.js';
import { resolveAuthToken } from '../session.js';
import type { Outcome, RunDeps } from '../cli.js';

export type AgentTemplate = components['schemas']['AgentTemplateResponse'];

export interface TemplatesOptions {
  apiUrl: string;
}

export const STEP = 'templates';

// The catalog holds a handful of entries; a page this large is the whole of it, and the loop below only covers a catalog that outgrows it.
const PAGE_SIZE = 100;

/** Every entry of `GET /agents/templates`, following the pages until the last one. */
export const listTemplates = async (client: OarsClient): Promise<AgentTemplate[]> => {
  const templates: AgentTemplate[] = [];
  for (let page = 0; ; page += 1) {
    const result = unwrap(STEP, await client.GET('/agents/templates', { params: { query: { page, size: PAGE_SIZE } } }));
    templates.push(...result.content);
    if (result.last) return templates;
  }
};

const describePrice = (price: AgentTemplate['starterPrices'][number]): string =>
  `${price.priceRef} ($${price.amountUsd}${typeof price.credits === 'number' ? `, ${String(price.credits)} credits` : ''})`;

/** `oars templates`: the platform's starter-template catalog, the ids `oars deploy --template` takes. */
export const templates = async (deps: RunDeps, options: TemplatesOptions): Promise<Outcome> => {
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: STEP, token: await resolveAuthToken(deps, options.apiUrl) });
  const catalog = await listTemplates(client);
  const lines =
    catalog.length === 0
      ? ['No starter templates are available.']
      : [
          ...catalog.flatMap((template) => [
            `${template.templateId}: ${template.name}`,
            `  ${template.description}`,
            ...(template.starterPrices.length === 0 ? [] : [`  Prices: ${template.starterPrices.map(describePrice).join(', ')}`]),
          ]),
          'Deploy one with: oars deploy --template <id>',
        ];
  return { document: { ok: true, templates: catalog }, text: lines.join('\n') };
};
