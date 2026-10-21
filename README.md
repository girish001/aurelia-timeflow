# Aurelia TimeFlow

Build a polished, demo-ready B2B SaaS web application named "Aurelia TimeFlow" by Aurelia Business Services. This is the first product we will demonstrate and sell to small and midsize IT services companies, software consultancies, and digital agencies in India and internationally. Create a usable MVP/prototype, not just a marketing landing page.

Product goal: make employee time entry, manager approvals, project/client tracking, billable hours, and management reporting simple. Keep scope focused; do not copy Replicon's branding or assets.

Brand/design: trustworthy modern enterprise SaaS, clean light interface, navy/indigo accents, subtle teal highlights, generous spacing, clear typography, responsive desktop/tablet/mobile. Brand text "Aurelia TimeFlow" with "by Aurelia Business Services". No fake customer logos, fake testimonials, unsupported compliance claims, or claims that the app is production-certified.

Build these pages with a clear left sidebar and top navigation:
1) Overview dashboard with summary cards (hours this week, pending approvals, billable utilization, active projects), weekly hours chart, recent timesheets, pending approvals, and a clear date range.
2) My Timesheet: weekly grid with days Monday–Sunday; add/edit/delete time entries; select client, project, task; hours; billable/non-billable; notes; validation to prevent negative or invalid hours; weekly total; save draft and submit for approval. Use realistic sample data.
3) Approvals: manager view listing submitted timesheets, employee, week, total hours, submitted date and status; open details; approve or reject with comments; status changes visibly in UI.
4) Projects: searchable/filterable list with client, project, project manager, status, budgeted hours, logged hours, billable rate (only display demo data); create/edit project dialog.
5) Clients: client list with contact, active projects and status; add/edit client dialog.
6) Reports: date filter, project/client/employee breakdown, billable vs non-billable hours, utilization chart and export to CSV that actually downloads a CSV.
7) Team: team members and role/status list; invite member UI with validation and a clear demo-only notice if invitations do not actually send.
8) Settings: company profile, week starts Monday, time display preferences, currency setting with INR/USD options, and a visible demo mode label.

Behavior: Make navigation and major interactions work. Use seeded demo data and persistent client-side state/local storage if backend/auth is not configured. The demo should be easy to explore without needing login; include a "Demo workspace" indicator and a reset demo data action. Clearly distinguish demo data from real customer data. No real employee or confidential data. Do not implement fake authentication that appears secure. If real auth/database can be configured safely within the available stack, explain what is configured and what still needs setup; otherwise keep this as a local demo prototype and don't imply multi-tenant production readiness.

Also create a concise public product landing page at / with value proposition, key features, "Book a demo" CTA, and pricing marked "Pilot pricing" (Starter pilot ₹3,000/month; Team pilot ₹6,000/month; custom setup quoted separately), plus a contact form that validates fields and gives a clear demo-only success state rather than pretending an email was sent. Link to the demo workspace/app.

Make the result visually strong enough to screen-share with prospective customers and practical to test. Include empty/loading/error states where relevant, accessible labels, responsive layout, and concise sample copy. Prioritize core workflows over extra features. At the end, summarize what works, whether data is persistent, and any important limitations before real customer use.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/8840905f-3ea9-4e34-b594-0c8042d8951f).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
