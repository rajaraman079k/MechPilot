# MechPilot — Multi-agent Engineering Copilot

A responsive web app for Windows, iPhone, Android and desktop browsers. It uses four sequential server-side AI calls through OpenRouter:
1. Fault diagnosis
2. Maintenance planning (consumes diagnosis)
3. Efficiency optimisation (consumes diagnosis + maintenance)
4. Safety and quality review (reviews the complete plan)

The OpenRouter key is **server-only**. It is never sent to or stored in the browser. The UI has no key field.

## Security note
The API key previously pasted into chat should be revoked/rotated. Do not reuse it. Add the replacement as the backend environment variable `OPENROUTER_API_KEY`. Do not paste secrets into HTML/JavaScript, `render.yaml`, GitHub, or a ZIP file.

## Run locally (Windows/macOS/Linux)
Requirements: Node.js 20+.

PowerShell:
```powershell
$env:OPENROUTER_API_KEY="YOUR_ROTATED_KEY"
$env:OPENROUTER_MODEL="openrouter/free"
npm start
```
Then open http://localhost:4173

macOS/Linux:
```bash
export OPENROUTER_API_KEY="YOUR_ROTATED_KEY"
export OPENROUTER_MODEL="openrouter/free"
npm start
```
No app-side API key entry is needed. The key is loaded once by the server process. If you already have an `.env` loader, you can use `.env` locally, but this project intentionally has no `.env` dependency so secrets don't accidentally get packaged.

## Deploy for a shareable HTTPS link (Render)
1. Create a new GitHub repository and upload this project **without a real key**.
2. In Render, create a new Blueprint from that repository. It reads `render.yaml`.
3. In the Render environment settings, add `OPENROUTER_API_KEY` with your newly rotated OpenRouter key and deploy.
4. Wait for the health check to pass. Open the generated `onrender.com` URL from Windows or any phone.
5. `/api/health` validates the secret server-side with OpenRouter's `GET /api/v1/key` endpoint, and returns only a validity status plus safe quota metadata; it never returns the key itself. Validation is cached for 60 seconds.

Render docs:
- Environment secrets: https://render.com/docs/configure-environment-variables\n- OpenRouter key verification: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
- Web services: https://render.com/docs/web-services

## Notes
- The app uses `openrouter/free` by default. This routes to a currently available free model. Free models can be busy, limited or changed by the provider; analysis can fail temporarily.
- A single analysis uses four sequential model calls, so it may take a little time. The loading overlay shows which stage is running.
- A lightweight in-memory limit restricts each network to five analyses per ten minutes. It resets if the server restarts and isn't a substitute for stronger production abuse protection.
- AI-generated outputs are decision support, not certified engineering advice. The safety reviewer is advisory and cannot establish that equipment is safe.
- The UI theme toggle is saved in the browser. Theme preference and run-history are local to that browser only.
