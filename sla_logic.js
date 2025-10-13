// n8n Function node — SLA calculation using $input (avoids 'items' linter errors)
// Paste into a Function node. Returns one output item per ticket: { json: { ... } }

// === CONFIG ===
const DEFAULT_SLA_FIRST_RESPONSE_HOURS = 48; // change if needed
const DEFAULT_SLA_RESOLUTION_HOURS = 1000;   // change if needed

// If true, and hs_time_to_first_agent_reply is missing, use hs_lastmodifieddate/updatedAt as a fallback
//const FALLBACK_USE_LAST_MODIFIED_AS_FIRST_RESPONSE = true;

// === helpers ===
function parseTimestamp(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') {
    // heuristic: large numbers are ms
    if (v > 1e11) return new Date(v);
    return new Date(v * 1000);
  }
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return parseTimestamp(Number(v));
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
    return null;
  }
  return null;
}
function msToHours(ms) {
  return ms == null ? null : ms / (1000 * 60 * 60);
}
function round4(n) {
  return n == null ? null : Number(n.toFixed(4));
}
function getProp(o, key) {
  if (!o) return undefined;
  if (o.properties && o.properties[key] !== undefined) return o.properties[key];
  if (o[key] !== undefined) return o[key];
  return undefined;
}

// END === helpers ===


// Use n8n $input helper to get incoming items (linter-friendly)
const incoming = $input.all(); // array of { json:, binary: }

// === normalize input (support multiple possible paste shapes) ===
let rawTickets = [];
if (incoming.length === 1) {
  const firstJson = incoming[0].json;
  if (Array.isArray(firstJson) && firstJson.length > 0 && Array.isArray(firstJson[0].results)) {
    // shape: [ { total, results: [...] } ]
    rawTickets = firstJson[0].results;
  } else if (firstJson && Array.isArray(firstJson.results)) {
    // shape: { total, results: [...] }
    rawTickets = firstJson.results;
  } else if (Array.isArray(firstJson)) {
    // shape: [ { id, properties... }, ... ]
    rawTickets = firstJson;
  } else {
    // fallback: treat each incoming item as a ticket (single item per input)
    rawTickets = incoming.map(i => i.json);
  }
} else {
  rawTickets = incoming.map(i => i.json);
}

// === process tickets ===
const output = rawTickets.map(ticket => {
  // ids & subject
  const ticketId = ticket.id ?? ticket.properties?.hs_object_id ?? ticket.properties?.hs_object_id ?? null;
  const subject = getProp(ticket, 'subject') ?? ticket.title ?? null;

  // created / closed
  const createdRaw = getProp(ticket, 'createdate') ?? ticket.createdAt ?? ticket.created_at ?? ticket.created;
  const createdAt = parseTimestamp(createdRaw);

  const closedRaw = getProp(ticket, 'closed_date') ?? ticket.closedAt ?? ticket.closed_at ?? ticket.closed;
  const closedAt = parseTimestamp(closedRaw);

  // built-in ms fields (HubSpot sometimes gives ms, sometimes numeric-string)
  const rawFirstMs = getProp(ticket, 'hs_time_to_first_agent_reply') ?? getProp(ticket, 'hs_time_to_first_reply') ?? ticket.hs_time_to_first_agent_reply;
  const rawCloseMs = getProp(ticket, 'hs_time_to_close') ?? ticket.hs_time_to_close;
 // console.log('DEBUG 000');
 // console.log(rawFirstMs);
 // console.log('DEBUG 001');
 // console.log(Number(rawFirstMs));
 // console.log('DEBUG 002');
  const firstMs = rawFirstMs ? Number(rawFirstMs) : null;
  const closeMs = rawCloseMs ? Number(rawCloseMs) : null;
  //console.log(firstMs);
 // console.log('DEBUG 003');
  // compute durations (hours)
  let timeToFirstHours = firstMs ? msToHours(firstMs) : null;
  ///console.log(timeToFirstHours);
  //console.log('DEBUG END');
  let timeToCloseHours = closeMs ? msToHours(closeMs) : null;

  // fallback: compute timeToFirst using last modified / updated if enabled
  //if (!timeToFirstHours && FALLBACK_USE_LAST_MODIFIED_AS_FIRST_RESPONSE && createdAt) 

  if (!timeToFirstHours && createdAt) 
  
  {
    const lastModRaw = getProp(ticket, 'hs_lastmodifieddate') ?? ticket.updatedAt ?? ticket.updated_at;
    const lastMod = parseTimestamp(lastModRaw);

    const lastModgetTime = lastMod.getTime();

    const createdAtgetTime = createdAt.getTime();
    
    if (lastMod) {
      timeToFirstHours = msToHours(lastModgetTime - createdAtgetTime);

  console.log('DEBUG 000');
      console.log(lastMod);
  console.log(msToHours(lastModgetTime));
  console.log('DEBUG 001');
      console.log(createdAt);
  console.log(msToHours(createdAtgetTime));
 // console.log('DEBUG 002');


      
    }
  }

    


  // fallback: compute timeToClose from createdAt/closedAt when hs_time_to_close is missing
  if (timeToCloseHours == null && createdAt && closedAt) {
    timeToCloseHours = msToHours(closedAt.getTime() - createdAt.getTime());
  }

  // per-ticket SLA override (optional): ticket.sla = { firstResponseHours, resolutionHours }
  const SLA_FIRST_HOURS = (ticket.sla && ticket.sla.firstResponseHours) ? Number(ticket.sla.firstResponseHours) : DEFAULT_SLA_FIRST_RESPONSE_HOURS;
  const SLA_RES_HOURS = (ticket.sla && ticket.sla.resolutionHours) ? Number(ticket.sla.resolutionHours) : DEFAULT_SLA_RESOLUTION_HOURS;

  const firstResponseMet = (timeToFirstHours != null) ? (timeToFirstHours <= SLA_FIRST_HOURS) : false;
  const resolutionMet = (timeToCloseHours != null) ? (timeToCloseHours <= SLA_RES_HOURS) : true;

  // reasons
  const breachReasons = [];
  if (timeToFirstHours == null) breachReasons.push('missing_first_response_time');
  else if (!firstResponseMet) breachReasons.push('first_response_breached');

  //if (timeToCloseHours == null) breachReasons.push('missing_resolution_time');
  //if (timeToCloseHours == null) breachReasons.push('missing_resolution_time');
  //else if (!resolutionMet) breachReasons.push('resolution_breached');

  if (!resolutionMet) breachReasons.push('resolution_breached');

  const slaStatus = breachReasons.length === 0 ? 'Met' : 'Breached';

  return {
    json: {
      ticketId,
      subject,
      createdAt: createdAt ? createdAt.toISOString() : null,
      closedAt: closedAt ? closedAt.toISOString() : null,
      timeToFirstHours: round4(timeToFirstHours),
      timeToFirstReadable: timeToFirstHours == null ? null : `${Math.floor(timeToFirstHours)}h ${Math.round((timeToFirstHours % 1) * 60)}m`,
      timeToCloseHours: round4(timeToCloseHours),
      timeToCloseReadable: timeToCloseHours == null ? null : `${Math.floor(timeToCloseHours)}h ${Math.round((timeToCloseHours % 1) * 60)}m`,
      firstResponseMet,
      resolutionMet,
      SLA_firstHours: SLA_FIRST_HOURS,
      SLA_resolutionHours: SLA_RES_HOURS,
      breachReasons,
      slaStatus,
      raw: ticket // include raw ticket for debugging if desired
     
    }
  };
});

// n8n expects an array of items back
//return {"results":{output} };
//const output2 = output.map(() => {
 // json:"results":{});
//});
  
return  { "results": output } ;
