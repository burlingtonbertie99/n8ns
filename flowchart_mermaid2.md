flowchart TD

%% =========== EXTERNAL SYSTEMS ===========
subgraph EXTERNAL["🌍 External Systems & Triggers"]
direction TB
A1["📧 Customer Email\n(IMAP/Connected Inbox)"] --> B1
A2["💬 Live Chat / Chatbot"] --> B1
A3["📄 Web Form Submission"] --> B1
A4["🔗 n8n / Integration Script\n(API: POST http://crm/v3/objects/tickets)"] --> B1
A5["☎️ Manual Agent Entry\n(HubSpot UI)"] --> B1
end

%% =========== HUBSPOT TICKET CREATION ===========
B1["🆕 Ticket Created in HubSpot"] -->|Generates ticketId| C1
C1["📦 HubSpot CRM Ticket Object\n(ticketId, createdate, subject, etc.)"]

%% API: GET TICKET INFO
C1 -->|API: GET /crm/v3/objects/tickets/ticketId\n→ returns hs_createdate, status| D1

%% =========== INTERNAL PROCESSES ===========
subgraph INTERNAL["🏢 Internal HubSpot Processing"]
direction TB
D1["📥 Ticket enters 'New' stage"] --> D2["⏱ SLA Timer starts\n(e.g., time-to-first-response)"]
D2 --> D3["🤖 Workflow Automation\n(Assign owner, tag, priority)"]
D3 --> D4["👩‍💻 Agent opens ticket & replies"]
D4 --> D5["📤 First Response Logged\n→ hs_first_agent_response_date set"]
D5 --> D6["📊 SLA properties auto-updated\nhs_time_to_first_agent_reply"]
D6 --> D7["🔁 Status transitions\n(In progress / Waiting / Escalated)"]
D7 --> D8["✅ Resolution sent → Ticket Closed\nhs_closed_date recorded"]
D8 --> D9["📦 SLA metrics finalized\nhs_time_to_close calculated"]
end

%% API Calls for Internal Data
D5 -->|API: GET /crm/v3/objects/tickets/ticketId?properties=hs_first_agent_response_date,hs_time_to_first_agent_reply| E1
D8 -->|API: GET /crm/v3/objects/tickets/ticketId?properties=hs_closed_date,hs_time_to_close| E1
D9 -->|Optional: CRM Associations API\nGET /crm/v4/objects/tickets/ticketId/associations/company| E1

%% =========== REPORTING ===========
subgraph REPORTING["📈 Reporting & Analytics"]
direction TB
E1["📡 Data retrieved via API or HubSpot Reports"]
E1 --> F1["🧮 External System (e.g., n8n, BI tool)\nCalculates business-hour SLA metrics"]
F1 --> G1["📜 Dashboard / SLA KPI Display"]
end

%% STYLING
style EXTERNAL fill:#e3f2fd,stroke:#1e88e5,stroke-width:1px
style INTERNAL fill:#fff3e0,stroke:#f57c00,stroke-width:1px
style REPORTING fill:#e8f5e9,stroke:#43a047,stroke-width:1px
