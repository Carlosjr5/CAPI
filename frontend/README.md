# CAPI React Dashboard (Vite)

This is a small React (Vite) dashboard to visualize trades created by the FastAPI backend.

Quick start (from repo root):

1. Install dependencies

```powershell
cd frontend
npm install
```

2. Start dev server (Vite)

```powershell
npm run dev
```

3. Open the app in the browser

- Vite prints a local URL (usually http://localhost:5173). The dashboard will fetch `http://127.0.0.1:8000/trades` and connect to WebSocket `ws://127.0.0.1:8000/ws` by default. Make sure the FastAPI server is running.

Build for production

```powershell
npm run build
npm run preview
```

Notes

- The backend must allow CORS from the dev server; `app/main.py` already includes a CORS middleware for common dev ports.
- If you deploy the built frontend, you can serve the static files from the FastAPI `static/` folder (not automated here).
