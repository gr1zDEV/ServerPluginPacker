# Modrinth Bulk Downloader

Modrinth Bulk Downloader is a fully static web app that helps you resolve and download matching Modrinth files for a list of project slugs/IDs, then packages them into one ZIP archive directly in the browser.
https://gr1zdev.github.io/ServerPluginPacker/
## Why this project exists

Managing plugin or modpack-compatible downloads manually is repetitive. This tool lets you:

- pick a Minecraft version
- pick a loader/platform
- paste project slugs/IDs
- resolve best matching versions from Modrinth
- download one ZIP generated fully client-side

## GitHub Pages compatibility

This project is designed specifically for **GitHub Pages**:

- Static files only (`index.html`, `style.css`, `script.js`)
- No backend/server required
- No database
- All API calls happen from browser JavaScript
- ZIP creation happens in-browser using JSZip

## How ZIP creation works

After matching versions/files, each file is downloaded as a browser `Blob`. Those blobs are added to a JSZip archive in memory. The final archive is generated client-side and downloaded to your machine.

## Run locally

You can open `index.html` directly, but using a local static server is recommended.

### Option A: Python

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

### Option B: VS Code Live Server

Serve the repo root and open the page in your browser.

## Deploy to GitHub Pages

This repo includes a GitHub Actions workflow at `.github/workflows/pages.yml` that automatically builds and publishes GitHub Pages whenever you push to `main`.

One-time setup:

1. In GitHub: **Settings → Pages**.
2. Set **Build and deployment** source to **GitHub Actions**.
3. Push to `main` and wait for the **Deploy GitHub Pages** workflow to finish.
4. Open the published Pages URL.

## Modrinth API notes

The app uses:

- `GET /v2/project/{id_or_slug}/version`
- query filters for `game_versions` and `loaders`

A custom `User-Agent` header is often requested by APIs, but browsers do not allow setting `User-Agent` from frontend JavaScript. This app uses normal browser `fetch` headers and documents the limitation here.

## Limitations

- Browser memory limits can affect very large packs or many large files.
- Some Modrinth projects do not publish builds for every Minecraft version/loader.
- Some entries require exact Modrinth slugs or IDs.
- Network/CORS problems can interrupt requests or file downloads.

## Future improvements

- Dependency resolution between projects
- Import/export plugin lists
- Profile presets
- Search-based project picker

## License

MIT (or your preferred license)

## Supported Minecraft versions

Minecraft versions are loaded dynamically from Modrinth (`/v2/tag/game_version`), so newly released versions appear automatically without requiring manual updates.
If that request fails, the UI falls back to a small built-in list so the app remains usable.
