# PSSC PhotoBooth 3.0

A simple, complete photobooth application for events, school programs, and photo studios. It runs locally in your web browser and handles everything from live camera countdowns, photo capture, and print templates to queue numbers, voice directions, and Google Drive upload links.

---

## What It Does

- Photo Capture and Countdown: Takes photos with live camera preview, countdown beeps, and photo strip layout generation.
- Ready-to-Use Templates: Comes with preloaded photo strip templates and an 8-ticket A4 printable sheet layout. You can also import Photoshop (.psd) files or PNG frames directly.
- Voice Prompts and Sound Effects: Built-in voice guides prompt guests when to get ready, change poses, switch props, and when their photos are done.
- Queue Tracking: Keeps track of guests in order (#1, #2, #3, etc.) so you know who is next and whether their prints were paid for and given out.
- Dual Display Support: Open a second viewfinder screen for guests facing the camera while you manage settings and controls from the operator screen.
- Google Sheets and Drive Logging: Automatically sends session details to your Google Sheet and generates QR codes for guest photo downloads from Google Drive.

---

## Quick Start

### Requirements
- Python 3.9 or newer
- Google Chrome, Microsoft Edge, or Mozilla Firefox
- A connected USB webcam or built-in camera

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/darnicojames/PSSC-PhotoBooth-3.0.git
cd PSSC-PhotoBooth-3.0

pip install flask pillow psd-tools imageio-ffmpeg
```

### 2. Start the Application

```bash
python app.py
```

Open your browser and go to:
**http://localhost:5000**

---

## How to Use

1. Go to the **Settings** page in the top menu.
2. Select your camera and microphone.
3. If using Google Sheets and Google Drive, enter your webhook link and folder link.
4. Click **Save Settings**.
5. Go to the **Photobooth** page, choose your template on the right side, and click **Start Session**.
6. Once the countdown finishes and photos are taken, you can print the finished photo strip or save it.

---

## Adding Custom Templates

You can upload your own templates under the **Templates** tab:
- Upload any `.psd`, `.png`, or `.jpg` file.
- When designing Photoshop (`.psd`) templates, label your photo box layers as:
  - `Pic 1`
  - `Pic 2`
  - `Pic 3`
  Or fill the photo boxes with solid Orange (Photo 1), Red (Photo 2), or Blue (Photo 3). The system will automatically detect the boxes and place the photos there.

---

## Included Print Templates and Assets

- **A4 8-Ticket Sheet**: Located at `A4_Photoprint_8_Tickets_Template.psd` and `A4_Photoprint_8_Tickets_Preview.png`, designed to print 8 photobooth tickets on a single A4 page with cutting marks.
- **Bundled Photo Strips**: Ready-to-use strip layouts located in `static/uploads/` and `static/previews/`.
- **Voice Guides**: Ready-to-use audio voice prompts located in `audio/`.

---

## Folder Overview

- `app.py`: The main program that runs the web server.
- `database.py`: Handles saving queue numbers, templates, and settings.
- `create_samples.py`: Loads the built-in templates when the app starts for the first time.
- `generate_a4_psd_template.py`: Helper script that generates the 8-ticket A4 print sheet.
- `A4_Photoprint_8_Tickets_Template.psd`: Master 8-ticket A4 print template.
- `static/`: Contains the web pages, styling, scripts, and template images.
- `audio/`: Contains the voice prompts and sound effects.

---

## License

MIT License. Built for PSSC events.
