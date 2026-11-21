import type { OarsClient } from './client.js';
import type { operations } from './generated/schema.js';

/** The catalog filters and paging `GET /billing/datasets` reads; each is optional. */
export type SearchDatasetsInput = NonNullable<operations['searchDatasets']['parameters']['query']>;

export interface GetDatasetInput {
  /** The listing's public UUID, as `datasets.search` returns it. */
  listingId: string;
}

/**
 * The public dataset catalog (K2 B1, B2). Both reads need no credential. Each call returns what openapi-fetch returns
 * (`data` or `error` plus the `response`), so the caller decides how a refusal reads.
 */
export const datasets = {
  /** `GET /billing/datasets`: a page of listings, filtered by text, harness, permitted use, training, and price per fetch. */
  search: (client: OarsClient, input: SearchDatasetsInput) => client.GET('/billing/datasets', { params: { query: input } }),
  /** `GET /billing/datasets/{listingId}`: one listing, or 404 `DATASET_NOT_FOUND`. */
  get: (client: OarsClient, input: GetDatasetInput) => client.GET('/billing/datasets/{listingId}', { params: { path: { listingId: input.listingId } } }),
};
