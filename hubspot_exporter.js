/**
 * HubSpot Ticket Exporter (hapikey mode)
 *
 * - Requires: set environment variable HUBSPOT_API_KEY
 * - Output: ./hubspot_export.json
 *
 * Notes:
 * - Uses CRM Search to page through tickets (POST /crm/v3/objects/tickets/search)
 * - Respects 429 Retry-After and uses exponential backoff
 * - Fetches associations for each ticket (companies, contacts, deals)
 * - Fetches workflows via /automation/v3/workflows
 *
 * See HubSpot docs for endpoints:
 * - Tickets / Properties / Search: https://developers.hubspot.com/docs/api-reference/crm-tickets-v3/guide
 * - Properties API: https://developers.hubspot.com/docs/api-reference/crm-properties-v3/guide
 * - CRM Search: https://developers.hubspot.com/docs/api-reference/search/guide
 * - Workflows: https://developers.hubspot.com/docs/api-reference/legacy/create-manage-workflows-v3/get-automation-v3-workflows
 */

const fs = require('fs');
const axios = require('axios');
const pLimit = require('p-limit');

const HAPIKEY = process.env.HUBSPOT_API_KEY;
if (!HAPIKEY) {
  console.error('Error: set HUBSPOT_API_KEY environment variable (your hapikey).');
  process.exit(1);
}

const BASE = 'https://api.hubapi.com';
const OUTPUT = './hubspot_export.json';

// Config: adjust as needed
const TICKET_BATCH_SIZE = 100;      // max reasonable batch size for search
const MAX_CONCURRENT_ASSOC = 6;     // concurrency for fetching associations
const MAX_RETRIES = 6;              // max exponential backoff attempts

const axiosInstance = axios.create({
  baseURL: BASE,
  timeout: 10000,
  // hapikey will be appended to each request via params in call wrapper
});

// Generic request wrapper that handles 429s (Retry-After) with exponential backoff
async function hubspotRequest(opts, attempt = 0) {
  const params = Object.assign({}, opts.params || {}, { hapikey: HAPIKEY });
  try {
    const resp = await axiosInstance.request(Object.assign({}, opts, { params }));
    return resp;
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      if (status === 429 && attempt < MAX_RETRIES) {
        // Respect Retry-After header if present; otherwise exponential backoff
        const retryAfter = parseInt(err.response.headers['retry-after'] || '0', 10);
        const waitSeconds = retryAfter > 0 ? retryAfter : Math.pow(2, attempt);
        console.warn(`429 received. Waiting ${waitSeconds} seconds (attempt ${attempt + 1})...`);
        await new Promise(res => setTimeout(res, waitSeconds * 1000));
        return hubspotRequest(opts, attempt + 1);
      }
    }
    // rethrow after retries or other errors
    throw err;
  }
}

// 1) Fetch ticket properties metadata
async function fetchTicketProperties() {
  const resp = await hubspotRequest({
    method: 'GET',
    url: '/crm/v3/properties/tickets'
  });
  return resp.data;
}

// 2) Search tickets (paged) using POST /crm/v3/objects/tickets/search
//    This uses 'after' cursor paging in the response
async function* searchAllTickets(properties = []) {
  // initial body, no 'after'
  let body = {
    limit: TICKET_BATCH_SIZE,
    properties,
    sorts: [ { propertyName: 'createdate', direction: 'ASCENDING' } ]
    // optionally add filterGroups to restrict date range or product
  };

  while (true) {
    const resp = await hubspotRequest({
      method: 'POST',
      url: '/crm/v3/objects/tickets/search',
      headers: { 'Content-Type': 'application/json' },
      data: body
    });

    const { results, paging } = resp.data;
    if (!results || results.length === 0) break;

    yield results;

    if (!paging || !paging.next || !paging.next.after) break;
    body.after = paging.next.after;
  }
}

// 3) For a given ticketId, fetch associations to companies/contacts/deals
async function fetchAssociationsForTicket(ticketId) {
  // We will request associations for common objects: companies, contacts, deals
  // Using the v4 associations endpoint pattern:
  // GET /crm/v4/objects/tickets/{ticketId}/associations/{toObjectType}
  const toTypes = ['companies', 'contacts', 'deals'];
  const results = {};
  for (const t of toTypes) {
    try {
      const resp = await hubspotRequest({
        method: 'GET',
        url: `/crm/v4/objects/tickets/${encodeURIComponent(ticketId)}/associations/${t}`
      });
      // HubSpot returns an object with "results" array of association objects
      results[t] = resp.data.results || [];
    } catch (err) {
      // If 404 or similar, just set empty and continue
      console.warn(`Warning: association fetch for ${ticketId} -> ${t} failed: ${err.message}`);
      results[t] = [];
    }
  }
  return results;
}

// 4) Fetch workflows list
async function fetchWorkflows() {
  const resp = await hubspotRequest({
    method: 'GET',
    url: '/automation/v3/workflows'
  });
  return resp.data;
}

// Utility: limit concurrency and fetch associations for many tickets
async function fetchAssociationsForTickets(ticketIds) {
  const limit = pLimit(MAX_CONCURRENT_ASSOC);
  const tasks = ticketIds.map(id => limit(() => fetchAssociationsForTicket(id).then(a => ({ id, associations: a }))));
  return Promise.all(tasks);
}

// Main runner
async function runExport() {
  console.log('Starting HubSpot export...');

  // a) properties
  console.log('Fetching ticket properties metadata...');
  const propertiesData = await fetchTicketProperties();

  // choose some default properties to fetch for each ticket - you can adjust these
  // We'll attempt to include the 'product' property if present; fallback to common fields
  const propertyNames = ['hs_object_id', 'subject', 'content', 'createdate', 'closedate', 'hs_pipeline', 'hs_pipeline_stage', 'hubspot_owner_id', 'ticket_priority', 'channel'];
  // try to detect if there's a property with name like 'product' (case-insensitive)
  const props = propertiesData.results || propertiesData;
  const productProp = (props || []).find(p => p.name && p.name.toLowerCase().includes('product'));
  if (productProp && !propertyNames.includes(productProp.name)) {
    propertyNames.push(productProp.name);
    console.log(`Detected product-like property: ${productProp.name} — adding to fetched properties.`);
  } else {
    console.log('No explicit product property auto-detected.');
  }

  // b) fetch workflows
  console.log('Fetching workflows...');
  const workflows = await fetchWorkflows();

  // c) iterate tickets via search, fetch associations alongside
  console.log('Searching and exporting tickets (this may take a while for large portals)...');
  const tickets = [];
  let totalTickets = 0;

  for await (const batch of searchAllTickets(propertyNames)) {
    totalTickets += batch.length;
    console.log(`Fetched batch of ${batch.length} tickets (total so far: ${totalTickets})`);

    // fetch associations for each ticket in this batch (parallel limited)
    const ids = batch.map(t => t.id);
    const assocResults = await fetchAssociationsForTickets(ids);

    // merge associations into tickets data
    const assocMap = Object.fromEntries(assocResults.map(a => [a.id, a.associations]));
    for (const t of batch) {
      tickets.push({
        id: t.id,
        properties: t.properties || t,
        createdAt: t.createdAt || t.properties?.createdate,
        updatedAt: t.updatedAt || t.properties?.lastmodifieddate,
        associations: assocMap[t.id] || {}
      });
    }
    // small delay to be polite (optional)
    await new Promise(r => setTimeout(r, 200));
  }

  const out = {
    meta: {
      exportedAt: new Date().toISOString(),
      ticketCount: tickets.length,
      propertiesFetched: propertyNames,
    },
    properties: propertiesData,
    workflows,
    tickets
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Export complete — ${tickets.length} tickets saved to ${OUTPUT}`);
}

runExport().catch(err => {
  console.error('Export failed:', err.response ? `${err.response.status} ${err.response.statusText}` : err.message);
  if (err.response && err.response.data) {
    console.error('Response body:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
