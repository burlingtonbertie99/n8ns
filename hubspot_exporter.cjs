/**
 * HubSpot Ticket Exporter (Bearer Token Authentication)
 *
 * - Requires: set environment variable HUBSPOT_ACCESS_TOKEN
 * - Output: ./hubspot_export.json
 *
 * Endpoints used:
 * - /crm/v3/properties/tickets
 * - /crm/v3/objects/tickets/search
 * - /crm/v4/objects/tickets/{ticketId}/associations/*
 * - /automation/v3/workflows
 */

const fs = require('fs');
const axios = require('axios');


//const pLimit = require("p-limit");
//const pLimit = require('p-limit');

//const pLimit = require('p-limit');


const ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (!ACCESS_TOKEN) {
    console.error('Error: set HUBSPOT_ACCESS_TOKEN environment variable (Bearer token).');
    process.exit(1);
}

const BASE = 'https://api.hubapi.com';
const OUTPUT = './hubspot_export.json';

const TICKET_BATCH_SIZE = 100;
const MAX_CONCURRENT_ASSOC = 6;
const MAX_RETRIES = 6;

const axiosInstance = axios.create({
    baseURL: BASE,
    timeout: 20000,
    headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`
    }
});

// Wrapper that handles 429 with exponential backoff + Retry-After
async function hubspotRequest(opts, attempt = 0) {
    try {
        const resp = await axiosInstance.request(opts);
        return resp;
    } catch (err) {
        const response = err.response;

        if (response && response.status === 429 && attempt < MAX_RETRIES) {
            const retryAfter = parseInt(response.headers['retry-after'] || '0', 10);
            const waitSeconds = retryAfter > 0 ? retryAfter : Math.pow(2, attempt);
            console.warn(`429 rate-limit. Waiting ${waitSeconds}s (attempt ${attempt + 1})...`);
            await new Promise(res => setTimeout(res, waitSeconds * 1000));
            return hubspotRequest(opts, attempt + 1);
        }

        throw err;
    }
}

// 1) properties
async function fetchTicketProperties() {
    const resp = await hubspotRequest({
        method: 'GET',
        url: '/crm/v3/properties/tickets'
    });
    return resp.data;
}

// 2) search tickets
async function* searchAllTickets(properties = []) {
    let body = {
        limit: TICKET_BATCH_SIZE,
        properties,
        sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }]
    };

    while (true) {
        const resp = await hubspotRequest({
            method: 'POST',
            url: '/crm/v3/objects/tickets/search',
            data: body,
            headers: { 'Content-Type': 'application/json' }
        });

        const { results, paging } = resp.data;

        if (!results || results.length === 0) break;
        yield results;

        if (!paging?.next?.after) break;
        body.after = paging.next.after;
    }
}

// 3) associations
async function fetchAssociationsForTicket(ticketId) {
    const types = ['companies', 'contacts', 'deals'];
    const out = {};

    for (const t of types) {
        try {
            const resp = await hubspotRequest({
                method: 'GET',
                url: `/crm/v4/objects/tickets/${ticketId}/associations/${t}`
            });
            out[t] = resp.data.results || [];
        } catch (err) {
            console.warn(`Association fetch failed for ticket ${ticketId} → ${t}: ${err.message}`);
            out[t] = [];
        }
    }

    return out;
}

async function fetchAssociationsForTickets(ids) {

    const pLimit = (await import('p-limit')).default;

   const limit = pLimit(MAX_CONCURRENT_ASSOC);


   // const limit = 100;
    const tasks = ids.map(id =>
        limit(async () => ({
            id,
            associations: await fetchAssociationsForTicket(id)
        }))
    );
    return Promise.all(tasks);
}

// 4) workflows
async function fetchWorkflows() {
    const resp = await hubspotRequest({
        method: 'GET',
        url: '/automation/v3/workflows'
    });
    return resp.data;
}

// Main
async function runExport() {
    console.log('Fetching ticket property metadata...');
    const propertiesData = await fetchTicketProperties();

    const baseProps = [
        'hs_object_id','subject','content',
        'createdate','closedate',
        'hs_pipeline','hs_pipeline_stage',
        'hubspot_owner_id','ticket_priority','channel'
    ];

    const productProp = (propertiesData.results || propertiesData).find(
        p => p.name && p.name.toLowerCase().includes('product')
    );
    if (productProp) {
        baseProps.push(productProp.name);
        console.log(`Detected a product-like property: ${productProp.name}`);
    }

    console.log('Fetching workflows...');
    const workflows = await fetchWorkflows();

    console.log('Fetching tickets via CRM Search...');
    const tickets = [];
    let total = 0;

    for await (const batch of searchAllTickets(baseProps)) {
        total += batch.length;
        console.log(`Fetched ${batch.length} (total ${total})`);

        const ids = batch.map(t => t.id);
        const assocBlock = await fetchAssociationsForTickets(ids);

        const assocMap = Object.fromEntries(assocBlock.map(a => [a.id, a.associations]));

        for (const t of batch) {
            tickets.push({
                id: t.id,
                properties: t.properties,
                createdAt: t.createdAt,
                updatedAt: t.updatedAt,
                associations: assocMap[t.id] || {}
            });
        }
    }

    const out = {
        meta: {
            exportedAt: new Date().toISOString(),
            ticketCount: tickets.length,
            propertiesFetched: baseProps
        },
        properties: propertiesData,
        workflows,
        tickets
    };

    fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
    console.log(`Done. Export written to ${OUTPUT}`);
}

runExport().catch(err => {
    console.error('Export failed:', err.response ? err.response.status : err.message);
    if (err.response?.data) {
        console.error(JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
});
