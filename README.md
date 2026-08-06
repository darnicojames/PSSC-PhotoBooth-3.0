# PSSC PhotoBooth 3.0 🎉

A professional **photobooth web application** built with Flask + vanilla JS, designed for events. Features a live webcam feed, photo templates, voice guides, music player with audio ducking, real-time audio visualizer, and external viewfinder support.

---

## ✨ Features

- 📸 **Live Webcam Capture** — 3-photo session with countdown, flash, and auto-compositing
- 🎨 **Template System** — Multiple photobooth strip layouts with slot-based editing
- 🎵 **Music Player** — Spotify-style player with YouTube import, shuffle, repeat, alphabetical playlist
- 🔊 **Voice Guides** — Round-robin audio cues for each session stage with automatic music ducking
- 🖼️ **Filters** — B&W, Sepia, Vintage, Cyberpunk, Vivid — baked into exported photos
- 📡 **Viewfinder Popout** — External screen sync for a second monitor
- 🎛️ **Audio Visualizer** — Avee-player style with Circle, Bars, Waveform, and Particle modes
- 🖨️ **Export** — Download composited photobooth tickets as PNG

---

## 🚀 Setup

### Requirements
- Python 3.9+
- pip

### Install & Run

```bash
pip install flask pillow
python app.py
```

Open **http://localhost:5000** in your browser.

---

## 📁 Project Structure

```
photobooth-app/
├── app.py                  # Flask backend
├── static/
│   ├── index.html          # Main photobooth UI
│   ├── viewfinder.html     # External screen popout
│   ├── visualizer.html     # Audio visualizer
│   ├── css/styles.css
│   ├── js/app.js
│   └── img/pssc_logo.png
├── audio/                  # Voice guides + music (not tracked in git)
├── sessions/               # Generated photobooth outputs (not tracked)
└── templates_data/         # Template JSON definitions
```

---

## 🎙️ Voice Guide Audio Files

Place your MP3s in the `audio/` folder:

| Filename | Purpose |
|---|---|
| `welcome.mp3`, `welcome(2).mp3` | Session start greeting |
| `get_ready_2.mp3`, `get_ready_2(2).mp3` | Before photo 2 |
| `get_ready_3.mp3`, `get_ready_3(2).mp3` | Before photo 3 |
| `switch_props.mp3`, `switch_props(2).mp3` | Between photos |
| `countdown.mp3`, `countdown(2).mp3` | 3.5s before shutter |
| `complete.mp3`, `complete(2).mp3` | Session complete |
| `cancelled.mp3`, `cancelled(2).mp3` | Session cancelled |

---

## 📄 License

MIT — built for PSSC events.
