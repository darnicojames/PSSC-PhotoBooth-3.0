# PSSC PhotoBooth 3.0 📸🎉

A modern, professional **photobooth web application** built with Python (Flask) and Vanilla JavaScript for event photography, booth rentals, and institutional showcases. Features a **Green × Black × White dark theme**, sequential queue tracking, Google Sheets & Drive database sync, PSD template parsing, Avee-style audio visualizer, voice guides with automatic audio ducking, and dual-screen viewfinder support.

---

## ✨ Key Features

### 🟢 Modern Dark Aesthetic & UX
- **Green × Black × White Theme**: Pure black `#000000` base with Apple-style glassmorphism cards and vibrant `#00e676` PSSC green accents.
- **Fluid Micro-Animations**: Smooth spring transitions, glowing ambient background orbs, click ripple feedback, and live status badges.

### 🎟️ Sequential Queue Tracking System
- **Queue Numbering**: Sequential `#1`, `#2`, `#3` counter replacing legacy random alphanumeric codes.
- **Real-Time Topbar Sync**: Displays active queue numbers live on the top navigation bar, completion ticket modals, and session gallery items.

### ☁️ Google Sheets & Drive Database Sync
- **Google Sheets Webhook Sync**: Configurable Webhook URL in Settings to log session details (`date`, `guest_name`, `queue_number`, `filename`, `paid`) to your Google Sheet in real time.
- **Google Drive Integration**: Configurable link for uploading templates via cloud or syncing photobooth outputs to Google Drive.

### 🛡️ Enforced 3 Crucial Pre-requisite Startup Checks
The photobooth enforces 3 setup checks before any session can start:
1. 📷 **Active Camera**: Connected and enabled camera device.
2. 🖼️ **Template Selected**: Active photobooth layout selected from the library.
3. ☁️ **Google Sheets Database Link**: Valid Google Sheets Webhook URL configured in Settings.

### 🎨 Template Studio & PSD Auto-Detection
- **PSD Layer Parsing**: Drag & drop `.PSD`, `.PNG`, or `.JPG` templates into Template Studio.
- ⚠️ **Photo Slot Auto-Detection Rules**: Photo slots are automatically detected **ONLY** if layers are labeled (`pic 1`, `pic 2`, `pic 3`) OR filled with solid colors:
  - 🟠 **Orange** = Pic 1
  - 🔴 **Red** = Pic 2
  - 🔵 **Blue** = Pic 3

### 🎵 Audio Engine & Visualizer
- **Voice Cues & Audio Ducking**: Dual voice guides with round-robin variations and automatic background music attenuation (ducks to 20% volume during announcements).
- **Music Player**: Spotify & YouTube music importer with playlist management, shuffle, and repeat.
- **Audio Visualizer**: Standalone Avee-player window with Circle, Bars, Waveform, and Particle modes.

---

## 🚀 Installation & Quick Start

### Requirements
- **Python**: Version 3.9 or higher
- **Browser**: Chrome / Edge / Firefox (recommended for WebRTC camera access)

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/darnicojames/PSSC-PhotoBooth-3.0.git
cd PSSC-PhotoBooth-3.0

pip install flask pillow psd-tools imageio-ffmpeg
```

### 2. Run the Application

```bash
python app.py
```

Open **[http://localhost:5000](http://localhost:5000)** in your web browser.

---

## ⚙️ Initial Setup Guide

1. Navigate to the **Settings** tab.
2. Under **Camera & Video**, select your preferred camera device.
3. Under **Google Sheets & Drive Sync**, enter your **Google Sheets Webhook URL** (e.g. Google Apps Script Webhook).
4. Click **💾 Save Settings** and test with **⚡ Test Queue Sync**.
5. Switch to the **Photobooth** tab, pick a template from the right panel, and click **Start Session**!

---

## 📁 Project Structure

```
PSSC-PhotoBooth-3.0/
├── app.py                  # Main Flask application & API routes
├── database.py             # SQLite database manager & config persistence
├── psd_parser.py           # PSD & image template slot detector
├── static/
│   ├── index.html          # Main application interface
│   ├── visualizer.html     # Avee-player audio visualizer window
│   ├── css/styles.css      # Green x Black x White glassmorphism stylesheet
│   ├── js/app.js           # Frontend session, camera & audio logic
│   └── img/pssc_logo.png   # PSSC brand logo
├── database/
│   └── photobooth.db       # SQLite database (templates, queue sessions, config)
└── README.md
```

---

## 📄 License

Distributed under the MIT License. Built for PSSC events.
