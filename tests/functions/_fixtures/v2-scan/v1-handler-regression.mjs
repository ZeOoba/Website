// POSITIVE, and VIOLATES the V2 contract: imports Blobs and exports `handler`, which makes Netlify treat it
// as legacy V1 (no Blobs auto-provisioning). The contract helper must reject this module.
import { getStore } from '@netlify/blobs';
export const handler = async () => ({ statusCode: 200, body: String(typeof getStore) });
export default async () => new Response('ok');
