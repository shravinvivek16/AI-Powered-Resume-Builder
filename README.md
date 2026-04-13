# AI Resume Builder

Professional AI-powered resume generator with:
- Form fields for years of experience, career start, company history, and duration.
- Theme selection for resume styling.
- Gemini-powered generation of high-quality summary and impact bullets.
- One-click PDF export of the generated resume.

## Tech Stack
- React + TypeScript + Vite (frontend)
- Express.js (backend API)
- Gemini API via `@google/generative-ai`
- `html2canvas` + `jspdf` for PDF download

## Setup
1. Install dependencies:
   - `npm install`
2. Create a local env file:
   - `cp .env.example .env`
3. Add your Gemini key in `.env`:
   - `GEMINI_API_KEY=your_real_key`
4. Start the app:
   - `npm run dev`

This runs:
- Frontend at `http://localhost:5173`
- Backend at `http://localhost:8787`

## Build
- `npm run build`
- `npm run preview`
