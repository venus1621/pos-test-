# Restaurant POS + EIMS e-invoicing (Node, Express, MongoDB, plain HTML/CSS/JS)

1. `npm install`
2. `cp .env.example .env` and fill `EIMS_API_KEY` (OPERATOR key) and `EIMS_WEBHOOK_SECRET`
3. Start MongoDB, then `npm start` and open http://localhost:3000

Webhooks need a public https URL, e.g. `ngrok http 3000`, then add
`https://<your-ngrok>/webhooks/eims` under Administration -> Integrations -> Add webhook.
Without webhooks the Orders tab still refreshes in-flight invoices every 8 seconds.

Flow: order saved (number = externalRef) -> POST /invoices -> finalize {submit:"now"} -> IRN + QR.
Retry always re-sends the SAME externalRef, so it never creates duplicates.
