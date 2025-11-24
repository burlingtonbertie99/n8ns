/**
 * backfill-first-response.js
 *
 * Usage:
 *   node backfill-first-response.js
 *
 * Behavior:
 * - If TICKET_IDS_FILE is set and exists, the script reads ticket IDs from it (one per line).
 * - Otherwise, the script lists all tickets via /crm/v3/objects/tickets (paginated) and processes them.
 *
 * For each ticket:
 * - fetch ticket properties (createdAt/createdate)
 * - list associated emails via /crm/v3/objects/tickets/{id}/associations/emails (paginated)
 * - fetch each email metadata and detect:
 *     * earliest inbound email timestamp (customer_start)
 *     * earliest outbound agent email after customer_start (first_agent_reply)
 * - compute delta and write first_agent_reply timestamp to ticket property FIRST_RESPONSE_PROPERTY
 *
 * Rate limit handling:
 * - Retries with exponential backoff on 429 and transient errors, honoring Retry-After header when present.
 */

import fs from "fs";
import path from "path";
import axios from "axios";
import pRetry from "p-retry";
import dotenv from "dotenv";

dotenv.config();

//HUBSPOT_TOKEN=your_private_app_or_oauth_access_token_here
// FIRST_RESPONSE_PROPERTY=first_agent_reply_timestamp    # HubSpot ticket property to write (must exist)
// TICKET_IDS_FILE=./ticket_ids.txt                       # optional: newline separated list of ticket IDs
// TICKET_FETCH_LIMIT=100                                 # optional, default limit when listing (max 100)
// LOG_LEVEL=info

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const FIRST_RESPONSE_PROPERTY = process.env.FIRST_RESPONSE_PROPERTY || "first_agent_reply_timestamp";
const TICKET_IDS_FILE = process.env.TICKET_IDS_FILE || null;
const TICKET_FETCH_LIMIT = parseInt(process.env.TICKET_FETCH_LIMIT || "100", 10);
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

if (!HUBSPOT_TOKEN) {
    console.error("HUBSPOT_TOKEN is required in environment. Exiting.");
    process.exit(1);
}

const api = axios.create({
    baseURL: "https://api.hubapi.com",
    headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json",
    },
    timeout: 60_000,
});

/**
 * requestWithRetry: wraps axios requests in a retry loop handling 429/Retry-After and transient errors
 */
async function requestWithRetry(config, opts = {}) {
    const operation = async () => {
        try {
            const resp = await api.request(config);
            return resp;
        } catch (err) {
            if (err.response) {
                const status = err.response.status;
                // If rate-limited, throw a special error with retryAfter to let p-retry schedule correctly
                if (status === 429) {
                    const ra = err.response.headers["retry-after"];
                    const waitSec = ra ? parseFloat(ra) : undefined;
                    const e = new Error("Rate limited (429)");
                    e.isRetryable = true;
                    e.retryAfter = waitSec;
                    throw e;
                }
                // treat 5xx as retryable
                if (status >= 500 && status < 600) {
                    const e = new Error(`Server error ${status}`);
                    e.isRetryable = true;
                    throw e;
                }
                // other 4xx are not retryable
                throw err;
            } else {
                // network or timeout
                const e = new Error("Network/timeout error");
                e.isRetryable = true;
                throw e;
            }
        }
    };

    const onFailedAttempt = error => {
        const attempt = error.attemptNumber;
        const remaining = error.retriesLeft;
        // If error has retryAfter, wait that amount (p-retry won't automatically wait that header)
        if (error.message === "Rate limited (429)" && error.retryAfter) {
            const ms = Math.max(1000, Math.round(error.retryAfter * 1000));
            log("warn", `429 -> honoring Retry-After ${error.retryAfter}s, sleeping ${ms}ms before retry (attempt ${attempt}).`);
            return new Promise(res => setTimeout(res, ms));
        }
        log("warn", `Attempt ${attempt} failed. ${remaining} retries left. Error: ${error.message}`);
    };

    return pRetry(operation, {
        onFailedAttempt,
        retries: opts.retries ?? 6,
        factor: 2,
        minTimeout: opts.minTimeout ?? 1000,
        maxTimeout: opts.maxTimeout ?? 30_000,
    });
}

// simple logger
function log(level, ...args) {
    const levels = ["debug", "info", "warn", "error"];
    if (levels.indexOf(level) < levels.indexOf(LOG_LEVEL)) return;
    console.log(`[${level.toUpperCase()}]`, ...args);
}

/** Utility: list all tickets (paginated) */
async function listAllTickets(limit = 100) {
    const tickets = [];
    let after = undefined;
    do {
        const params = {
            limit,
            properties: "createdate,createdAt", // try both common properties
        };
        if (after) params.after = after;
        const resp = await requestWithRetry({
            method: "GET",
            url: "/crm/v3/objects/tickets",
            params,
        });

        const data = resp.data;
        if (!data.results || data.results.length === 0) break;
        tickets.push(...data.results);
        after = data.paging && data.paging.next && data.paging.next.after;
    } while (after);

    return tickets;
}

/** Utility: get a ticket by id (with properties) */
async function getTicket(ticketId) {
    const resp = await requestWithRetry({
        method: "GET",
        url: `/crm/v3/objects/tickets/${ticketId}`,
        params: { properties: "createdate,createdAt" },
    });
    return resp.data;
}

/** Utility: list associated emails for a ticket (paginated) */
async function listTicketEmailAssociations(ticketId, limit = 100) {
    const emailIds = [];
    let after = undefined;
    do {
        const params = { limit };
        if (after) params.after = after;
        const resp = await requestWithRetry({
            method: "GET",
            url: `/crm/v3/objects/tickets/${ticketId}/associations/emails`,
            params,
        });
        const data = resp.data;
        if (data.results && data.results.length) {
            data.results.forEach(r => {
                if (r.id) emailIds.push(r.id);
            });
        }
        after = data.paging && data.paging.next && data.paging.next.after;
    } while (after);
    return emailIds;
}

/** Utility: get email metadata by id */
async function getEmail(emailId) {
    // which properties we want to inspect
    const props = [
        "hs_timestamp",
        "hs_email_direction",
        "hs_email_status",
        "hubspot_owner_id",
        "from",
        "to",
        "createdAt",
    ].join(",");
    const resp = await requestWithRetry({
        method: "GET",
        url: `/crm/v3/objects/emails/${emailId}`,
        params: { properties: props },
    });
    return resp.data;
}

/** Update ticket property */
async function patchTicketProperty(ticketId, propertyName, propertyValue) {
    const body = { properties: { [propertyName]: propertyValue } };
    const resp = await requestWithRetry({
        method: "PATCH",
        url: `/crm/v3/objects/tickets/${ticketId}`,
        data: body,
    });
    return resp.data;
}

/** Heuristic: determine if an email looks like inbound (customer) */
function isInboundEmail(email) {
    const p = email.properties || {};
    const dir = (p.hs_email_direction || "").toLowerCase();
    // common inbound markers
    if (dir.includes("inbound") || dir.includes("incoming")) return true;
    // sometimes hs_email_direction is absent — use from/to perhaps
    // if it has no hubspot_owner_id and from is not a company address, consider inbound
    return false;
}

/** Heuristic: determine if an email looks like an agent outbound reply */
function looksLikeAgentOutbound(email, companyDomains = []) {
    const p = email.properties || {};
    const dir = (p.hs_email_direction || "").toLowerCase();

    if (dir.includes("outbound") || dir.includes("outgoing")) return true;
    if (p.hubspot_owner_id) return true;

    // Try to parse 'from' if present
    if (p.from) {
        // p.from might be "Name <email@domain>"
        const m = /<([^>]+)>$/.exec(p.from.trim());
        const fromAddr = m ? m[1] : p.from.trim();
        const domain = (fromAddr.split("@")[1] || "").toLowerCase();
        if (companyDomains.includes(domain)) return true;
    }

    return false;
}

/** Simple auto-reply / ooo detector */
function looksLikeAutoReply(email) {
    const p = email.properties || {};
    const subject = (p.hs_email_subject || "").toLowerCase();
    const status = (p.hs_email_status || "").toLowerCase();

    if (status.includes("bounce") || status.includes("auto")) return true;
    if (subject.includes("out of office") || subject.includes("auto-reply") || subject.includes("vacation")) return true;
    // also check body? (not fetched to keep calls light) — if you want to be stricter, fetch the email body.
    return false;
}

/** Try to get ISO timestamp from email properties */
function emailTimestampIso(email) {
    const p = email.properties || {};
    // try hs_timestamp, createdAt, createdate
    const tsCandidates = [p.hs_timestamp, p.createdAt, p.createdate, email.createdAt];
    for (const t of tsCandidates) {
        if (!t) continue;
        // HubSpot sometimes gives milliseconds, sometimes ISO; normalize
        // If purely numeric, assume epoch ms or secs (we try ms first)
        if (/^\d+$/.test(String(t))) {
            const n = Number(t);
            // reasonable ms (>= 1e11) else maybe seconds
            if (n > 1e11) return new Date(n).toISOString();
            return new Date(n * 1000).toISOString();
        }
        // fallback to parseable date string
        const d = new Date(t);
        if (!isNaN(d.getTime())) return d.toISOString();
    }
    return null;
}

/** Main: process one ticket */
async function processTicket(ticketId) {
    log("info", `Processing ticket ${ticketId}...`);
    const ticket = await getTicket(ticketId);
    const ticketProps = ticket.properties || {};

    // derive ticket start: prefer earliest inbound email (customer message), else fallback to ticket create date
    let ticketStartIso = null;
    // ticket properties
    const ticketCreatedIso = ticketProps.createdate || ticketProps.createdAt || ticket.createdAt || null;
    // list associated emails
    const emailIds = await listTicketEmailAssociations(ticketId, 100);

    if (emailIds.length === 0) {
        log("warn", `Ticket ${ticketId} has no email associations. Using ticket created date (if any).`);
        ticketStartIso = normalizePossibleTimestamp(ticketCreatedIso);
    } else {
        // fetch metadata for all emails (serially to reduce burst)
        const emails = [];
        for (const eid of emailIds) {
            try {
                const e = await getEmail(eid);
                emails.push(e);
            } catch (err) {
                log("warn", `Failed to fetch email ${eid} for ticket ${ticketId}: ${err.message}`);
            }
        }

        // detect earliest inbound email (customer)
        let earliestInbound = null;
        for (const e of emails) {
            if (looksLikeAutoReply(e)) continue; // skip auto replies as "customer" start
            const iso = emailTimestampIso(e);
            if (!iso) continue;
            // treat as inbound when hs_email_direction contains inbound or if it lacks owner and looks non-agent
            const dir = ((e.properties && e.properties.hs_email_direction) || "").toLowerCase();
            const isInbound = dir.includes("inbound") || dir.includes("incoming");
            if (isInbound) {
                if (!earliestInbound || iso < earliestInbound) earliestInbound = iso;
            }
        }

        if (earliestInbound) {
            ticketStartIso = earliestInbound;
        } else {
            // fallback to ticket create date if no inbound found
            ticketStartIso = normalizePossibleTimestamp(ticketCreatedIso);
        }

        // find first agent outbound AFTER ticketStartIso
        if (ticketStartIso) {
            // infer company domains from agent-sent emails in this ticket (to detect 'from' domain)
            const companyDomains = emails
                .filter(e => e.properties && e.properties.hubspot_owner_id && e.properties.from)
                .map(e => {
                    const m = /<([^>]+)>$/.exec((e.properties.from || "").trim());
                    const addr = m ? m[1] : (e.properties.from || "").trim();
                    return (addr.split("@")[1] || "").toLowerCase();
                })
                .filter(Boolean);
            const uniqueDomains = Array.from(new Set(companyDomains));

            // candidate agent replies
            const candidates = [];
            for (const e of emails) {
                if (looksLikeAutoReply(e)) continue;
                const iso = emailTimestampIso(e);
                if (!iso) continue;
                if (iso <= ticketStartIso) continue; // must be after start
                if (looksLikeAgentOutbound(e, uniqueDomains)) {
                    candidates.push({ email: e, iso });
                }
            }

            // pick earliest candidate
            candidates.sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
            if (candidates.length > 0) {
                const first = candidates[0];
                log("info", `Ticket ${ticketId} -> first agent reply at ${first.iso}`);
                // write this ISO into the ticket property
                try {
                    await patchTicketProperty(ticketId, FIRST_RESPONSE_PROPERTY, first.iso);
                    log("info", `Updated ticket ${ticketId} property ${FIRST_RESPONSE_PROPERTY} -> ${first.iso}`);
                } catch (err) {
                    log("error", `Failed to update ticket ${ticketId}: ${err.message}`);
                }
                return;
            } else {
                log("warn", `No outbound agent email found after start for ticket ${ticketId}. Skipping patch.`);
                return;
            }
        } else {
            log("warn", `Cannot determine ticket start for ${ticketId}. Skipping.`);
            return;
        }
    }

    // If reached here and ticketStartIso exists but no emails detected, we already handled earlier branch
    log("info", `Finished ${ticketId} (no update performed).`);
}

/** Helper: normalize possible HubSpot timestamp into ISO. */
function normalizePossibleTimestamp(t) {
    if (!t) return null;
    if (/^\d+$/.test(String(t))) {
        const n = Number(t);
        if (n > 1e11) return new Date(n).toISOString();
        return new Date(n * 1000).toISOString();
    }
    const d = new Date(t);
    if (!isNaN(d.getTime())) return d.toISOString();
    return null;
}

/** Main entrypoint */
async function main() {
    try {
        let ticketIds = [];

        if (TICKET_IDS_FILE && fs.existsSync(TICKET_IDS_FILE)) {
            const raw = fs.readFileSync(TICKET_IDS_FILE, "utf8");
            ticketIds = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            log("info", `Loaded ${ticketIds.length} ticket IDs from ${TICKET_IDS_FILE}`);
        } else {
            log("info", "No ticket IDs file provided; fetching all tickets (this may take a while)...");
            const tickets = await listAllTickets(TICKET_FETCH_LIMIT);
            ticketIds = tickets.map(t => t.id);
            log("info", `Fetched ${ticketIds.length} tickets from HubSpot.`);
        }

        // process sequentially (safe); can be parallelized with concurrency control if desired
        for (const id of ticketIds) {
            try {
                await processTicket(id);
            } catch (err) {
                log("error", `Error processing ticket ${id}: ${err.stack || err.message}`);
            }
            // short delay between tickets to reduce burst risk
            await new Promise(res => setTimeout(res, 300));
        }

        log("info", "All done.");
    } catch (err) {
        console.error("Fatal error:", err);
        process.exit(2);
    }
}

main();
