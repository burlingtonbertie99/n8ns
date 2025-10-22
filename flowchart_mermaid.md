flowchart TD

%% =========== EXTERNAL SOURCES ===========
subgraph EXTERNAL["External Triggers (Inbound Sources)"]
A1["📧 Customer sends support email\n(mailTo: support@cryptomathic.com)"] --> B1
A2["💬 Live Chat / Chatbot conversation"] --> B1
A3["📄 Web Form submission\n(e.g., Contact Us form)"] --> B1
A4["🔗 API Integration / Third-Party App\n(e.g., CRM, n8n, Zapier)"] --> B1
A5["☎️ Manual entry by agent\n(via HubSpot UI)"] --> B1
end

B1["🆕 Ticket Created\nHubSpot Ticket Object Instantiated"] --> C1

%% =========== INTERNAL HUBSPOT PIPELINE ===========
subgraph INTERNAL["Internal HubSpot Ticket Handling & Timing"]
direction TB
C1["📥 Ticket enters 'New' stage\nPipeline = Support Pipeline"] --> D1["⏱ SLA / Timer starts\n(e.g., time_to_first_response)"]
D1 --> D2["🤖 Automation Triggers\n(assignment, tags, priority rules)"]
D2 --> E1["👩‍💻 Agent Assigned / Views ticket"]
E1 --> E2["📤 First agent response sent\n→ First_Response_Date recorded"]
E2 --> F1["📊 SLA monitor updates\n(First_response_time logged)"]
F1 --> G1["🔁 Ticket status changes\n(e.g., Waiting_on_customer, In_progress)"]
G1 --> H1["✅ Resolution sent\n→ Time_to_close clock stops"]
H1 --> I1["📦 Ticket moves to Closed stage\n→ SLA metrics finalized"]
end

%% =========== DATA + REPORTING ===========
I1 --> J1["📈 Data synced to Reporting Dashboard"]
J1 --> K1["📜 SLA & performance metrics logged\n(e.g., response time, resolution time)"]

%% =========== NOTES ===========
style EXTERNAL fill:#e8f4ff,stroke:#6baed6,stroke-width:1px
style INTERNAL fill:#fdf6e3,stroke:#b58900,stroke-width:1px
style J1 fill:#f0fdf4,stroke:#31a354,stroke-width:1px
style K1 fill:#f0fdf4,stroke:#31a354,stroke-width:1px
