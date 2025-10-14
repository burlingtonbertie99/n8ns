
const fs = require('fs');


// n8n Function node — SLA calculation using $input (avoids 'items' linter errors)
// Paste into a Function node. Returns one output item per ticket: { json: { ... } }

// === CONFIG ===
const DEFAULT_SLA_FIRST_RESPONSE_HOURS = 48; // change if needed
const DEFAULT_SLA_RESOLUTION_HOURS = 1000;   // change if needed

// If true, and hs_time_to_first_agent_reply is missing, use hs_lastmodifieddate/updatedAt as a fallback
//const FALLBACK_USE_LAST_MODIFIED_AS_FIRST_RESPONSE = true;


// Use n8n $input helper to get incoming items (linter-friendly)
//const incoming = $input.all(); // array of { json:, binary: }

//var incoming=[];

var incoming=[];
try {
    const data = fs.readFileSync('tickets_input.json', 'utf8')

    const incoming___ = JSON.parse(data);
    //console.log(data)
    incoming = incoming___;

} catch (err) {
    console.error(err)
}



//fs.readFile('tickets_input.json', function(err, data) {

//fs.readFileSync('tickets_input.json', function(err, data) {

  //  if (err)
        //throw err;
    //    console.log("Error while reading data!");

    //const books = JSON.parse(data);
//	console.log("Input data = ");
 //   console.log(books);
	//incoming = books["results"];
	//incoming = books[0].results;

    //incoming = books[0];
//	console.log("Data to process = ");
//	console.log(incoming);
//});



// === normalize input (support multiple possible paste shapes) ===
let rawTickets = [];

if (incoming.length > 0) {

	//console.log("Processing tickets");

   // const firstJson = incoming[0].json;
    const firstJson = incoming[0].results;

    // const firstJson = incoming.results[0].json;

// TODO can probably simplify this!!!!

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



//console.log("rawTickets = ");
//console.log(rawTickets);




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

 // console.log('DEBUG 000');
   //   console.log(lastMod);
  //console.log(msToHours(lastModgetTime));
  //console.log('DEBUG 001');
    //  console.log(createdAt);
  //console.log(msToHours(createdAtgetTime));
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
      subject,
      createdAt: createdAt ? createdAt.toISOString() : null,
      closedAt: closedAt ? closedAt.toISOString() : null,

      timeToFirstReadable: timeToFirstHours == null ? null : `${Math.floor(timeToFirstHours)}h ${Math.round((timeToFirstHours % 1) * 60)}m`,

      timeToCloseReadable: timeToCloseHours == null ? null : `${Math.floor(timeToCloseHours)}h ${Math.round((timeToCloseHours % 1) * 60)}m`,
      firstResponseMet,
      resolutionMet

    }
  };
});

// n8n expects an array of items back
//return {"results":{output} };
//const output2 = output.map(() => {
 // json:"results":{});
//});
  
//return  { "results": output } ;
//
//
//console.log("Output = ");
console.log(output);



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


