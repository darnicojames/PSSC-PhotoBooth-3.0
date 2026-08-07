document.addEventListener('DOMContentLoaded', () => {
    // --- TERMINAL LOGGING & BROWSER SHUTDOWN SYNC ---
    function logUserAction(action, details = '') {
        fetch('/api/log-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, details })
        }).catch(() => {});
    }

    // Send heartbeat every 6 seconds to keep backend launcher alive
    setInterval(() => {
        fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
    }, 6000);

    logUserAction("App Started", "Connected to PSSC PhotoBooth 3.0");

    // --- STATE VARIABLES ---
    let templates = [];
    let activeTemplate = null;
    let currentVideoStream = null;
    let isMirrored = true;
    let selectedFilter = 'normal';
    let isSessionRunning = false;
    let activeCameraId = null;

    // AUDIO & SEQUENCE CONTROLLER STATE
    let currentAudio = null;
    let activeSessionToken = null;
    let activeTimers = [];
    let activeCountdownResolver = null;

    const AUDIO_MAPPING = {
        'welcome.mp3': 4.0,
        'count_3.mp3': 3.0,
        'switch_props.mp3': 4.5,
        'get_ready_2.mp3': 2.0,
        'get_ready_3.mp3': 2.0,
        'complete.mp3': 4.0,
        'cancelled.mp3': 2.5
    };

    // --- DOM ELEMENTS ---
    const cameraSelect = document.getElementById('cameraSelect');
    const btnRefreshCameras = document.getElementById('btnRefreshCameras');
    const btnToggleMirror = document.getElementById('btnToggleMirror');
    const btnTestCamera = document.getElementById('btnTestCamera');
    const webcamVideo = document.getElementById('webcamVideo');
    const liveOverlayCanvas = document.getElementById('liveOverlayCanvas');
    const viewfinderWrapper = document.getElementById('viewfinderWrapper');
    const cameraStatusText = document.getElementById('cameraStatusText');
    
    const templateCardsGrid = document.getElementById('templateCardsGrid');
    const activeTemplateTitle = document.getElementById('activeTemplateTitle');
    const activeTemplateSpecs = document.getElementById('activeTemplateSpecs');
    const templateCountNum = document.getElementById('templateCountNum');
    const liveTicketCanvas = document.getElementById('liveTicketCanvas');

    const btnStartBooth = document.getElementById('btnStartBooth');
    const btnCancelBooth = document.getElementById('btnCancelBooth');
    const countdownSelect = document.getElementById('countdownSelect');
    const countdownOverlay = document.getElementById('countdownOverlay');
    const countdownNumber = document.getElementById('countdownNumber');
    const flashOverlay = document.getElementById('flashOverlay');
    const sessionProgressBadge = document.getElementById('sessionProgressBadge');
    const currentShotNum = document.getElementById('currentShotNum');
    const totalShotNum = document.getElementById('totalShotNum');

    const sessionStatusBanner = document.getElementById('sessionStatusBanner');
    const sessionStatusText = document.getElementById('sessionStatusText');

    const psdDropzone = document.getElementById('psdDropzone');
    const psdFileInput = document.getElementById('psdFileInput');
    const templateTitleInput = document.getElementById('templateTitleInput');
    const btnUploadPSD = document.getElementById('btnUploadPSD');
    const dbTemplatesTableBody = document.getElementById('dbTemplatesTableBody');
    const btnRefreshTemplates = document.getElementById('btnRefreshTemplates');

    const galleryGrid = document.getElementById('galleryGrid');
    const galleryCount = document.getElementById('galleryCount');
    const btnRefreshGallery = document.getElementById('btnRefreshGallery');

    const resultModal = document.getElementById('resultModal');
    const resultImage = document.getElementById('resultImage');
    const btnDownloadResult = document.getElementById('btnDownloadResult');
    const btnPrintResult = document.getElementById('btnPrintResult');
    const btnCloseModal = document.getElementById('btnCloseModal');
    const btnCloseModalBtn = document.getElementById('btnCloseModalBtn');

    // --- TAB SWITCHING ---
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
            btn.classList.add('active');
            const tabId = btn.getAttribute('data-tab');
            document.getElementById(tabId).classList.add('active');
            logUserAction("Navigated Tab", tabId);

            if (tabId === 'tab-gallery') loadGallery();
            if (tabId === 'tab-studio') loadTemplates();
            if (tabId === 'tab-settings') loadMusicPlaylist();
        });
    });

    // --- AUDIO DUCKING ENGINE ---
    let isAudioDuckingActive = false;
    let duckingTimer = null;
    let duckingInterval = null;
    let activeVoiceCount = 0;

    // Lazy getter — bgMusicAudio is declared later in the file, so we resolve it at call time
    function getMusicAudio() {
        return typeof bgMusicAudio !== 'undefined' ? bgMusicAudio : null;
    }

    function setBgMusicDucking(duck) {
        if (duckingTimer) {
            clearTimeout(duckingTimer);
            duckingTimer = null;
        }

        if (duck) {
            isAudioDuckingActive = true;
            applyVolumeTransition(0.20, 300); // Smoothly fade to 20% over 300ms
        } else {
            // Recover to 100% after a 250ms tail cushion once all voice lines finish
            duckingTimer = setTimeout(() => {
                if (activeVoiceCount === 0) {
                    isAudioDuckingActive = false;
                    applyVolumeTransition(1.00, 500); // Smoothly restore to 100% over 500ms
                }
            }, 250);
        }
    }

    function applyVolumeTransition(targetFactor, durationMs) {
        const music = getMusicAudio();
        if (!music) return; // music player not ready yet
        if (duckingInterval) {
            clearInterval(duckingInterval);
            duckingInterval = null;
        }

        const volSlider = typeof bgMusicVolume !== 'undefined' ? bgMusicVolume : null;
        const userVol = volSlider ? parseFloat(volSlider.value) : 1.0;
        const targetVol = Math.max(0, Math.min(1, userVol * targetFactor));
        const startVol = music.volume;
        const volDiff = targetVol - startVol;
        const steps = Math.max(1, Math.floor(durationMs / 20));
        let currentStep = 0;

        duckingInterval = setInterval(() => {
            const m = getMusicAudio();
            if (!m) { clearInterval(duckingInterval); duckingInterval = null; return; }
            currentStep++;
            const progress = currentStep / steps;
            let newVol = startVol + (volDiff * progress);
            newVol = Math.max(0, Math.min(1, newVol));
            m.volume = newVol;

            if (currentStep >= steps) {
                clearInterval(duckingInterval);
                duckingInterval = null;
                m.volume = targetVol;
            }
        }, 20);
    }


    // --- AUDIO CONTROLLER ENGINE ---
    // Stops only the current playing clip without touching voice count or ducking state.
    // Used internally when chaining voice guides so ducking stays held continuously.
    function stopCurrentAudio() {
        if (currentAudio) {
            try {
                currentAudio.pause();
                currentAudio.currentTime = 0;
            } catch (e) {}
            currentAudio = null;
        }
    }

    // Full reset — stops audio AND releases ducking. Called on cancel / explicit stop.
    function stopAllAudio() {
        stopCurrentAudio();
        activeVoiceCount = 0;
        setBgMusicDucking(false);
    }

    function clearAllActiveTimers() {
        activeTimers.forEach(t => clearTimeout(t));
        activeTimers = [];
    }

    // Clearing an interval alone leaves the Promise that is awaiting it open.
    // Resolve it as part of cancellation so a stopped session cannot linger.
    function finishActiveCountdown() {
        if (activeCountdownResolver) {
            const resolveCountdown = activeCountdownResolver;
            activeCountdownResolver = null;
            resolveCountdown();
        }
    }

    const AUDIO_CATEGORIES = {
        'welcome':      ['welcome.mp3', 'welcome(2).mp3'],
        // photo1 intentionally removed — no voice prompt for picture 1
        'photo2':       ['get_ready_2.mp3', 'get_ready_2(2).mp3'],
        'photo3':       ['get_ready_3.mp3', 'get_ready_3(2).mp3'],
        'switch_props': ['switch_props.mp3', 'switch_props(2).mp3'],
        'countdown':    ['countdown.mp3', 'countdown(2).mp3'],
        'complete':     ['complete.mp3', 'complete(2).mp3'],
        'cancelled':    ['cancelled.mp3', 'cancelled(2).mp3']
    };

    // Round-robin index pointer per category — advances +1 each time a category plays
    // So: session 1 → variant[0], session 2 → variant[1], session 3 → variant[0], etc.
    const audioCategoryIndex = {};

    function getNextAudioForCategory(categoryName) {
        const list = AUDIO_CATEGORIES[categoryName];
        if (!list || list.length === 0) return categoryName; // fallback to raw filename
        if (!(categoryName in audioCategoryIndex)) {
            audioCategoryIndex[categoryName] = 0; // start at first variant
        }
        const idx = audioCategoryIndex[categoryName] % list.length;
        audioCategoryIndex[categoryName] = (idx + 1) % list.length; // advance for next call
        return list[idx];
    }

    function playAudioCategory(categoryName, forcePlay = false) {
        const filename = getNextAudioForCategory(categoryName);
        return playAudio(filename);
    }

    /**
     * Central audio utility function.
     * Manages HTML5 Audio clip playback from /audio/ directory.
     * Dynamic delay: Waits for the audio track 'ended' event so delay equals exact duration of the track.
     */
    function playAudio(filename) {
        // Stop previous clip without releasing the duck — keeps music at 20% between chained guides
        stopCurrentAudio();

        const audioUrl = `/audio/${filename}?t=${Date.now()}`;

        return new Promise(resolve => {
            let isResolved = false;
            let timeoutId = null;

            activeVoiceCount++;
            setBgMusicDucking(true);

            const cleanupAndResolve = () => {
                if (!isResolved) {
                    isResolved = true;
                    if (timeoutId) {
                        clearTimeout(timeoutId);
                        timeoutId = null;
                    }
                    activeVoiceCount = Math.max(0, activeVoiceCount - 1);
                    if (activeVoiceCount === 0) {
                        setBgMusicDucking(false);
                    }
                    resolve();
                }
            };

            try {
                const audio = new Audio();
                audio.crossOrigin = "anonymous";
                audio.src = audioUrl;
                currentAudio = audio;

                // Web Audio API GainNode boost (200% Volume / +6dB Amplification)
                try {
                    const ctx = getAudioCtx();
                    const source = ctx.createMediaElementSource(audio);
                    const gainNode = ctx.createGain();
                    gainNode.gain.value = 1.5; // 150% volume
                    source.connect(gainNode);
                    gainNode.connect(ctx.destination);
                } catch (gainErr) {
                    console.log("Audio GainNode note:", gainErr);
                }

                // 1. Primary Completion Trigger: Wait for full 'ended' event from HTML5 audio
                audio.addEventListener('ended', () => {
                    // 200ms tail cushion so final reverb of the clip plays completely
                    timeoutId = setTimeout(cleanupAndResolve, 200);
                    if (timeoutId) activeTimers.push(timeoutId);
                }, { once: true });

                audio.addEventListener('error', () => {
                    console.warn(`Audio ${filename} missing or unplayable.`);
                    cleanupAndResolve();
                }, { once: true });

                // 2. Safety Timeout: Only fires if audio hangs or fails to emit ended (duration + 1.5s)
                audio.addEventListener('loadedmetadata', () => {
                    const audioDuration = audio.duration && !isNaN(audio.duration) ? audio.duration : 3.0;
                    timeoutId = setTimeout(cleanupAndResolve, (audioDuration + 1.5) * 1000);
                    if (timeoutId) activeTimers.push(timeoutId);
                }, { once: true });

                audio.play().catch(err => {
                    console.warn(`Audio auto-play note for ${filename}:`, err);
                    cleanupAndResolve();
                });

            } catch (err) {
                console.error(`Failed to play ${filename}:`, err);
                cleanupAndResolve();
            }
        });
    }

    // --- WEB AUDIO SYNTHESIZERS (FALLBACK / EFFECTS) ---
    let audioCtx = null;
    function getAudioCtx() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    function playBeepSound(freq = 880, duration = 0.12) {
        try {
            const ctx = getAudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.30, ctx.currentTime); // 200% volume
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + duration);
        } catch (e) {}
    }

    function playShutterSound() {
        try {
            const ctx = getAudioCtx();
            const bufferSize = ctx.sampleRate * 0.1;
            const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = Math.random() * 2 - 1;
            }
            const noise = ctx.createBufferSource();
            noise.buffer = buffer;
            const filter = ctx.createBiquadFilter();
            filter.type = 'highpass';
            filter.frequency.value = 1200;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.50, ctx.currentTime); // 200% volume
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
            noise.connect(filter);
            filter.connect(gain);
            gain.connect(ctx.destination);
            noise.start();
        } catch (e) {}
    }

    function playCelebrationFanfare() {
        try {
            const ctx = getAudioCtx();
            const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51];
            notes.forEach((freq, idx) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.value = freq;
                const startTime = ctx.currentTime + idx * 0.1;
                const duration = idx === notes.length - 1 ? 0.6 : 0.25;
                gain.gain.setValueAtTime(0.40, startTime); // 200% volume
                gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(startTime);
                osc.stop(startTime + duration);
            });
        } catch (e) {}
    }

    // BROADCAST CHANNEL REAL-TIME SYNC FOR EXTERNAL/POPOUT VIEWFINDER
    const syncChannel = new BroadcastChannel('photobooth_sync');

    function broadcastSync(type, payload = {}) {
        try {
            syncChannel.postMessage({ type, ...payload });
        } catch (e) {}
    }

    // The pop-out is a separate document, so it does not receive messages sent
    // before its BroadcastChannel is ready. Send the current viewfinder state
    // whenever it announces that it has loaded.
    function syncPopoutViewfinderState() {
        broadcastSync('DEVICE_CHANGE', { deviceId: activeCameraId });
        broadcastSync('MIRROR_CHANGE', { isMirrored });
        broadcastSync('FILTER_CHANGE', { filter: selectedFilter });

        if (viewfinderWrapper && viewfinderWrapper.style.aspectRatio) {
            broadcastSync('ASPECT_RATIO_CHANGE', {
                aspectRatio: viewfinderWrapper.style.aspectRatio
            });
        }
    }

    // --- STATUS NOTICE BANNER ---
    function showStatusNotice(text) {
        if (sessionStatusBanner && sessionStatusText) {
            sessionStatusText.textContent = text;
            sessionStatusBanner.classList.remove('hidden');
            broadcastSync('STATUS_NOTICE', { text });
        }
    }

    function hideStatusNotice() {
        if (sessionStatusBanner) {
            sessionStatusBanner.classList.add('hidden');
            broadcastSync('STATUS_NOTICE', { text: null });
        }
    }

    // The pop-out has its own overlay elements, so a cancelled session needs
    // an explicit signal to clear both displays immediately.
    function clearSessionOverlays() {
        if (countdownOverlay) countdownOverlay.classList.add('hidden');
        if (sessionProgressBadge) sessionProgressBadge.classList.add('hidden');
        if (flashOverlay) flashOverlay.classList.remove('active');

        broadcastSync('COUNTDOWN_HIDE');
        broadcastSync('SESSION_END');
    }

    // --- CAMERA ENGINE & SELECTION OPTIMIZER ---
    function stopCameraStream() {
        if (currentVideoStream) {
            try {
                currentVideoStream.getTracks().forEach(track => {
                    track.stop();
                    track.enabled = false;
                });
            } catch (e) {}
            currentVideoStream = null;
        }
        if (webcamVideo) {
            webcamVideo.srcObject = null;
        }
        if (cameraStatusText) {
            cameraStatusText.textContent = "Camera Disconnected / Off";
        }
    }

    async function initCameraDevices(isRefresh = false) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            if (cameraStatusText) cameraStatusText.textContent = "Media Devices Not Supported";
            return;
        }

        if (cameraStatusText) {
            cameraStatusText.textContent = isRefresh ? "Refreshing Cameras..." : "Scanning Cameras...";
        }

        try {
            // Fast single track request to grant permissions if needed
            if (!isRefresh && !activeCameraId) {
                const initStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                initStream.getTracks().forEach(t => t.stop());
            }

            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');

            cameraSelect.innerHTML = '';

            // Add Option to turn camera OFF / Disconnect immediately
            const offOpt = document.createElement('option');
            offOpt.value = 'off';
            offOpt.textContent = '🚫 Camera Off / Disconnect';
            cameraSelect.appendChild(offOpt);

            if (videoDevices.length === 0) {
                if (cameraStatusText) cameraStatusText.textContent = "No Camera Found";
                stopCameraStream();
                return;
            }

            videoDevices.forEach((device, idx) => {
                const opt = document.createElement('option');
                opt.value = device.deviceId;
                opt.textContent = device.label || `Camera ${idx + 1}`;
                cameraSelect.appendChild(opt);
            });

            // Select active camera or first available camera
            if (activeCameraId && activeCameraId !== 'off' && videoDevices.some(d => d.deviceId === activeCameraId)) {
                cameraSelect.value = activeCameraId;
            } else {
                activeCameraId = videoDevices[0].deviceId;
                cameraSelect.value = activeCameraId;
            }

            startWebcamStream(activeCameraId);

        } catch (err) {
            console.error("Camera Init Error:", err);
            if (cameraStatusText) cameraStatusText.textContent = "Camera Permission Denied / Error";
        }
    }

    async function startWebcamStream(deviceId) {
        // 1. Immediately stop current stream and release hardware lock!
        stopCameraStream();

        if (!deviceId || deviceId === 'off') {
            stopCameraStream();
            return;
        }

        // High resolution constraints (1920x1080 Full HD for maximum sharpness)
        const constraints = {
            video: {
                deviceId: { exact: deviceId },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 30 }
            },
            audio: false
        };

        try {
            if (cameraStatusText) cameraStatusText.textContent = "Connecting Camera...";
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            currentVideoStream = stream;
            webcamVideo.srcObject = stream;
            if (cameraStatusText) cameraStatusText.textContent = "Live Stream Active";
            
            webcamVideo.onloadedmetadata = () => {
                resizeOverlayCanvas();
                drawSlotOverlays();
            };
        } catch (err) {
            console.warn("Exact constraint failed, falling back to basic stream:", err);
            try {
                const fallbackStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: deviceId }, audio: false });
                currentVideoStream = fallbackStream;
                webcamVideo.srcObject = fallbackStream;
                if (cameraStatusText) cameraStatusText.textContent = "Live Stream Active";
            } catch (fallbackErr) {
                console.error("Failed to start stream:", fallbackErr);
                if (cameraStatusText) cameraStatusText.textContent = "Error Accessing Camera";
            }
        }
    }

    async function refreshCameraDevices() {
        if (btnRefreshCameras) {
            btnRefreshCameras.disabled = true;
            btnRefreshCameras.innerHTML = '<span>🔄 Resetting...</span>';
        }

        // 1. STEP 1: STOP THE ACTIVE CAMERA FEED IMMEDIATELY
        stopCameraStream();

        if (cameraStatusText) {
            cameraStatusText.textContent = "🔄 Resetting Camera Hardware...";
        }

        // 250ms cushion to let browser hardware driver release camera locks cleanly
        await new Promise(r => setTimeout(r, 250));

        // 2. STEP 2 & 3: RESCAN CONNECTED DEVICES & RESTART FEED CLEANLY
        await initCameraDevices(true);

        if (btnRefreshCameras) {
            btnRefreshCameras.disabled = false;
            btnRefreshCameras.innerHTML = '<span>🔄 Refresh</span>';
        }
    }

    if (btnRefreshCameras) {
        btnRefreshCameras.addEventListener('click', () => {
            refreshCameraDevices();
        });
    }

    cameraSelect.addEventListener('change', (e) => {
        activeCameraId = e.target.value;
        broadcastSync('DEVICE_CHANGE', { deviceId: activeCameraId });
        if (activeCameraId === 'off') {
            stopCameraStream();
        } else {
            startWebcamStream(activeCameraId);
        }
    });

    btnToggleMirror.addEventListener('click', () => {
        isMirrored = !isMirrored;
        broadcastSync('MIRROR_CHANGE', { isMirrored });
        if (isMirrored) {
            webcamVideo.classList.remove('unmirrored');
            btnToggleMirror.innerHTML = '<span>🪞 Mirror: ON</span>';
        } else {
            webcamVideo.classList.add('unmirrored');
            btnToggleMirror.innerHTML = '<span>🪞 Mirror: OFF</span>';
        }
    });

    btnTestCamera.addEventListener('click', () => {
        triggerFlash();
        alert(`📹 Camera Diagnostic:\nResolution: ${webcamVideo.videoWidth || 1280} x ${webcamVideo.videoHeight || 720}\nStream Status: ${webcamVideo.readyState === 4 ? 'Active' : 'Initializing'}`);
    });

    // --- POPOUT & FULLSCREEN VIEWFINDER CONTROLLERS ---
    const btnPopoutViewfinder = document.getElementById('btnPopoutViewfinder');
    const btnFullscreenViewfinder = document.getElementById('btnFullscreenViewfinder');
    const btnReturnViewfinder = document.getElementById('btnReturnViewfinder');
    const viewfinderPoppedOutPlaceholder = document.getElementById('viewfinderPoppedOutPlaceholder');

    let isViewfinderPoppedOut = false;
    let popoutWindowRef = null;

    function setPopoutActive(active) {
        isViewfinderPoppedOut = active;
        if (active) {
            if (viewfinderPoppedOutPlaceholder) viewfinderPoppedOutPlaceholder.classList.remove('hidden');
            if (btnPopoutViewfinder) btnPopoutViewfinder.innerHTML = '📥 Return Viewfinder';
            // Ensure webcamVideo stays active in the background on main tab so photo captures work 100%!
            if (!currentVideoStream || !currentVideoStream.active) {
                startWebcamStream(activeCameraId);
            }
        } else {
            if (viewfinderPoppedOutPlaceholder) viewfinderPoppedOutPlaceholder.classList.add('hidden');
            if (btnPopoutViewfinder) btnPopoutViewfinder.innerHTML = '📺 Pop-out Window';
            if (!currentVideoStream || !currentVideoStream.active) {
                startWebcamStream(activeCameraId);
            }
        }
    }

    if (btnPopoutViewfinder) {
        btnPopoutViewfinder.addEventListener('click', () => {
            if (!isViewfinderPoppedOut) {
                popoutWindowRef = window.open('/viewfinder', 'PSSC_Viewfinder_Popout', 'width=1280,height=800,menubar=no,toolbar=no,location=no');
                setPopoutActive(true);
            } else {
                if (popoutWindowRef && !popoutWindowRef.closed) {
                    popoutWindowRef.close();
                }
                setPopoutActive(false);
            }
        });
    }

    if (btnReturnViewfinder) {
        btnReturnViewfinder.addEventListener('click', () => {
            if (popoutWindowRef && !popoutWindowRef.closed) {
                popoutWindowRef.close();
            }
            setPopoutActive(false);
        });
    }

    // Listen for pop-out lifecycle messages.
    syncChannel.onmessage = (event) => {
        if (!event.data) return;

        if (event.data.type === 'POPOUT_READY') {
            syncPopoutViewfinderState();
        } else if (event.data.type === 'POPOUT_CLOSED') {
            setPopoutActive(false);
        }
    };

    if (btnFullscreenViewfinder) {
        btnFullscreenViewfinder.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                if (viewfinderWrapper && viewfinderWrapper.requestFullscreen) {
                    viewfinderWrapper.requestFullscreen().catch(err => alert("Fullscreen error: " + err.message));
                }
            } else {
                document.exitFullscreen();
            }
        });
    }

    // --- TEMPLATE & OVERLAY MANAGEMENT ---
    async function loadTemplates() {
        try {
            const res = await fetch('/api/templates');
            const data = await res.json();
            if (data.success && data.templates) {
                templates = data.templates;
                renderTemplateCards();
                renderStudioTable();
                if (templates.length > 0) {
                    selectTemplate(templates[0]);
                }
            }
        } catch (err) {
            console.error("Error loading templates:", err);
        }
    }

    function renderTemplateCards() {
        templateCardsGrid.innerHTML = '';
        templateCountNum.textContent = templates.length;

        templates.forEach(t => {
            const card = document.createElement('div');
            card.className = `template-card ${activeTemplate && activeTemplate.id === t.id ? 'active' : ''}`;
            card.innerHTML = `
                <img class="template-card-thumb" src="${t.preview_url}" alt="${t.name}">
                <h4>${t.name}</h4>
                <span>${t.slots ? t.slots.length : 0} Slots • ${t.width}x${t.height}</span>
            `;
            card.addEventListener('click', () => selectTemplate(t));
            templateCardsGrid.appendChild(card);
        });
    }

    function selectTemplate(template) {
        activeTemplate = template;
        logUserAction("Selected Template", template.name);
        if (activeTemplateTitle) activeTemplateTitle.textContent = template.name;
        if (activeTemplateSpecs) activeTemplateSpecs.textContent = `${template.width} x ${template.height} px • ${template.slots.length} Slots`;
        const telemetryTemplate = document.getElementById('telemetryTemplate');
        if (telemetryTemplate) telemetryTemplate.textContent = template.name;

        if (template.slots && template.slots.length > 0 && viewfinderWrapper) {
            const slot = template.slots[0];
            viewfinderWrapper.style.aspectRatio = `${slot.w} / ${slot.h}`;
            resizeOverlayCanvas();
        }

        renderTemplateCards();
        drawSlotOverlays();
        renderLiveTicketCanvas([]);

        if (window.anime && liveTicketCanvas) {
            anime({
                targets: liveTicketCanvas,
                scale: [0.96, 1],
                opacity: [0.7, 1],
                duration: 450,
                easing: 'easeOutElastic(1, .8)'
            });
        }
    }

    function renderLiveTicketCanvas(shots = []) {
        if (!activeTemplate || !liveTicketCanvas) return;

        const ctx = liveTicketCanvas.getContext('2d');
        liveTicketCanvas.width = activeTemplate.width;
        liveTicketCanvas.height = activeTemplate.height;

        ctx.fillStyle = '#0f121d';
        ctx.fillRect(0, 0, liveTicketCanvas.width, liveTicketCanvas.height);

        const baseImg = new Image();
        baseImg.crossOrigin = 'anonymous';
        baseImg.src = activeTemplate.preview_url;

        const renderShotsAndSlots = () => {
            const validShots = shots.filter(s => s);

            if (validShots.length === 0) {
                activeTemplate.slots.forEach((slot, idx) => {
                    ctx.strokeStyle = '#00F0FF';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(slot.x, slot.y, slot.w, slot.h);
                    ctx.fillStyle = 'rgba(0, 240, 255, 0.85)';
                    ctx.font = 'bold 24px Space Grotesk, sans-serif';
                    ctx.textAlign = 'center';
                    const slotText = slot.label ? slot.label : `PIC ${idx + 1}`;
                    ctx.fillText(slotText, slot.x + slot.w / 2, slot.y + slot.h / 2 + 8);
                });
            } else {
                activeTemplate.slots.forEach((slot, idx) => {
                    if (shots[idx]) {
                        const shotImg = new Image();
                        shotImg.src = shots[idx];
                        shotImg.onload = () => {
                            const sw = shotImg.width;
                            const sh = shotImg.height;

                            const targetW = slot.w + 4;
                            const targetH = slot.h + 4;
                            const targetX = Math.max(0, slot.x - 2);
                            const targetY = Math.max(0, slot.y - 2);

                            const sAspect = sw / sh;
                            const tAspect = targetW / targetH;
                            let cropW = sw, cropH = sh, cropX = 0, cropY = 0;

                            if (sAspect > tAspect) {
                                cropW = sh * tAspect;
                                cropX = (sw - cropW) / 2;
                            } else {
                                cropH = sw / tAspect;
                                cropY = (sh - cropH) / 2;
                            }

                            const isT1 = activeTemplate && (activeTemplate.id === 3 || (activeTemplate.name && activeTemplate.name.toLowerCase().includes('template1')));
                            ctx.save();
                            ctx.beginPath();
                            if (!isT1 && ctx.roundRect) {
                                ctx.roundRect(targetX, targetY, targetW, targetH, 20);
                            } else {
                                ctx.rect(targetX, targetY, targetW, targetH);
                            }
                            ctx.clip();
                            ctx.drawImage(shotImg, cropX, cropY, cropW, cropH, targetX, targetY, targetW, targetH);
                            ctx.restore();
                        };
                    }
                });
            }
        };

        baseImg.onload = () => {
            ctx.drawImage(baseImg, 0, 0, activeTemplate.width, activeTemplate.height);
            renderShotsAndSlots();
            if (activeStickers && activeStickers.length > 0) {
                ctx.font = '32px sans-serif';
                ctx.textAlign = 'right';
                activeStickers.forEach((st, idx) => {
                    ctx.fillText(st, activeTemplate.width - 24, 50 + (idx * 40));
                });
            }
        };

        baseImg.onerror = () => {
            renderShotsAndSlots();
            if (activeStickers && activeStickers.length > 0) {
                ctx.font = '32px sans-serif';
                ctx.textAlign = 'right';
                activeStickers.forEach((st, idx) => {
                    ctx.fillText(st, activeTemplate.width - 24, 50 + (idx * 40));
                });
            }
        };
    }

    function resizeOverlayCanvas() {
        if (!liveOverlayCanvas || !viewfinderWrapper) return;
        liveOverlayCanvas.width = viewfinderWrapper.clientWidth;
        liveOverlayCanvas.height = viewfinderWrapper.clientHeight;
    }

    window.addEventListener('resize', () => {
        resizeOverlayCanvas();
        drawSlotOverlays();
    });

    function drawSlotOverlays(activeSlotIndex = -1) {
        if (!liveOverlayCanvas) return;
        const ctx = liveOverlayCanvas.getContext('2d');
        ctx.clearRect(0, 0, liveOverlayCanvas.width, liveOverlayCanvas.height);
    }

    // --- LIVE FILTERS ---
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedFilter = btn.getAttribute('data-filter');
            applyLiveCssFilter();
            broadcastSync('FILTER_CHANGE', { filter: selectedFilter });
            logUserAction("Selected Live Filter", selectedFilter);
        });
    });

    function applyLiveCssFilter() {
        switch (selectedFilter) {
            case 'bw': webcamVideo.style.filter = 'grayscale(100%)'; break;
            case 'sepia': webcamVideo.style.filter = 'sepia(80%)'; break;
            case 'vintage': webcamVideo.style.filter = 'contrast(120%) saturate(70%) sepia(30%)'; break;
            case 'cyberpunk': webcamVideo.style.filter = 'hue-rotate(180deg) saturate(140%)'; break;
            case 'vivid': webcamVideo.style.filter = 'saturate(160%) contrast(110%)'; break;
            default: webcamVideo.style.filter = 'none'; break;
        }
    }

    // --- CANCELLATION LOGIC (GLOBAL OVERRIDE) ---
    async function handleCancelSession() {
        // 1. Immediately invalidate active session token to abort sequence loops
        activeSessionToken = null;

        // 2. Stop all playing audio & clear active timers
        stopAllAudio();
        clearAllActiveTimers();
        finishActiveCountdown();

        // 3. Reset UI state to idle landing screen
        isSessionRunning = false;
        btnStartBooth.disabled = false;
        btnStartBooth.classList.add('btn-glow');
        btnStartBooth.classList.remove('hidden');
        btnCancelBooth.classList.add('hidden');
        clearSessionOverlays();

        showStatusNotice("❌ Session Cancelled");

        // 4. Play cancelled audio category
        await playAudioCategory('cancelled');

        // 5. Reset photobooth back to main idle landing screen
        hideStatusNotice();
        drawSlotOverlays(-1);
        if (activeTemplate) {
            renderLiveTicketCanvas([]);
        }
    }

    btnCancelBooth.addEventListener('click', handleCancelSession);

    // --- MANDATORY EXECUTION SEQUENCE TIMELINE ---
    btnStartBooth.addEventListener('click', async () => {
        // --- 3 CRUCIAL SETUP PRE-REQUISITE CHECKS ---
        // 1. Camera check
        if (!activeCameraId || activeCameraId === 'off' || !currentVideoStream) {
            alert("⚠️ Crucial Setup Missing: Camera Device is disconnected or off!\n\nPlease connect/select an active camera in Settings before starting a session.");
            return;
        }

        // 2. Template check
        if (!activeTemplate) {
            alert("⚠️ Crucial Setup Missing: No template selected!\n\nPlease select a photobooth template from the right panel before starting.");
            return;
        }

        // 3. Google Sheets Database Link check
        try {
            const cfgRes = await fetch('/api/config');
            const cfgData = await cfgRes.json();
            if (!cfgData.google_sheets_url || cfgData.google_sheets_url.trim() === '') {
                alert("⚠️ Crucial Setup Missing: Google Sheets Database Link is empty!\n\nPlease enter your Google Sheets Webhook URL in the Settings tab before starting photobooth sessions.");
                const navSettings = document.getElementById('navSettings');
                if (navSettings) navSettings.click();
                return;
            }
        } catch (e) {
            console.error("Config check notice:", e);
        }

        if (isSessionRunning) return;

        const sessionToken = Symbol("session_token");
        activeSessionToken = sessionToken;

        isSessionRunning = true;
        btnStartBooth.disabled = true;
        btnStartBooth.classList.remove('btn-glow');
        btnStartBooth.classList.add('hidden');
        btnCancelBooth.classList.remove('hidden');
        sessionProgressBadge.classList.remove('hidden');

        const capturedPhotos = [];
        const delaySeconds = parseInt(countdownSelect.value, 10) || 3;
        const totalShots = Math.min(3, activeTemplate.slots.length);
        totalShotNum.textContent = totalShots;

        renderLiveTicketCanvas([]);

        try {
            // --- SESSION START: Play welcome category ---
            showStatusNotice("👋 Welcome to PSSC PhotoBooth 3.0!");
            await playAudioCategory('welcome');
            if (activeSessionToken !== sessionToken) return;

            // --- PICTURE 1 SEQUENCE --- (no voice prompt for picture 1)
            currentShotNum.textContent = 1;
            broadcastSync('SHOT_UPDATE', { current: 1, total: totalShots });
            showStatusNotice("📸 Get Ready for Picture 1!");
            // No audio prompt for photo 1 — get_ready_1 was removed
            await runCountdownSequence(delaySeconds, sessionToken);
            if (activeSessionToken !== sessionToken) return;

            triggerFlash();
            const pic1 = captureWebcamFrame();
            capturedPhotos.push(pic1);
            renderLiveTicketCanvas(capturedPhotos);

            // Delay while playing switch_props category
            showStatusNotice("🎭 Switch Props for Picture 2!");
            await playAudioCategory('switch_props');
            if (activeSessionToken !== sessionToken) return;

            // --- PICTURE 2 SEQUENCE ---
            currentShotNum.textContent = 2;
            broadcastSync('SHOT_UPDATE', { current: 2, total: totalShots });
            showStatusNotice("✨ Get Ready for Picture 2!");
            await playAudioCategory('photo2');
            if (activeSessionToken !== sessionToken) return;

            await runCountdownSequence(delaySeconds, sessionToken);
            if (activeSessionToken !== sessionToken) return;

            triggerFlash();
            const pic2 = captureWebcamFrame();
            capturedPhotos.push(pic2);
            renderLiveTicketCanvas(capturedPhotos);

            // Delay while playing switch_props category
            showStatusNotice("🎭 Switch Props for Picture 3!");
            await playAudioCategory('switch_props');
            if (activeSessionToken !== sessionToken) return;

            // --- PICTURE 3 SEQUENCE ---
            currentShotNum.textContent = 3;
            broadcastSync('SHOT_UPDATE', { current: 3, total: totalShots });
            showStatusNotice("✨ Get Ready for Picture 3!");
            await playAudioCategory('photo3');
            if (activeSessionToken !== sessionToken) return;

            await runCountdownSequence(delaySeconds, sessionToken);
            if (activeSessionToken !== sessionToken) return;

            triggerFlash();
            const pic3 = captureWebcamFrame();
            capturedPhotos.push(pic3);
            renderLiveTicketCanvas(capturedPhotos);

            // --- SESSION COMPLETE ---
            showStatusNotice("🎨 Generating Final Photobooth Ticket & Verification Code...");
            sessionProgressBadge.classList.add('hidden');
            countdownOverlay.classList.add('hidden');
            broadcastSync('SESSION_END');

            const guestNameInput = document.getElementById('guestNameInput');
            const layoutSelect = document.getElementById('layoutSelect');

            const res = await fetch('/api/session/composite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    template_id: activeTemplate.id,
                    photos: capturedPhotos,
                    filter: selectedFilter,
                    guest_name: guestNameInput ? guestNameInput.value.trim() : 'Guest',
                    layout: layoutSelect ? layoutSelect.value : 'double'
                })
            });

            const data = await res.json();
            if (activeSessionToken !== sessionToken) return;

            // Play complete audio category
            showStatusNotice(`🎉 Photobooth Ticket Ready! 🎟️ Queue #${data.queue_number || data.code || ''}`);
            playCelebrationFanfare();
            await playAudioCategory('complete');
            if (activeSessionToken !== sessionToken) return;

            if (data.success) {
                showResultModal(data.output_url, data.queue_display || data.code, data.filename);
                loadGallery();
                loadSystemConfig();
            } else {
                alert("Composite Error: " + data.error);
            }

        } catch (err) {
            console.error("Session Execution Error:", err);
        } finally {
            if (activeSessionToken === sessionToken) {
                activeSessionToken = null;
                isSessionRunning = false;
                btnStartBooth.disabled = false;
                btnStartBooth.classList.add('btn-glow');
                btnStartBooth.classList.remove('hidden');
                btnCancelBooth.classList.add('hidden');
                hideStatusNotice();
            }
        }
    });

    function runCountdownSequence(seconds, token) {
        return new Promise(resolve => {
            const finishCountdown = () => {
                if (activeCountdownResolver === finishCountdown) {
                    activeCountdownResolver = null;
                }
                resolve();
            };
            activeCountdownResolver = finishCountdown;

            countdownOverlay.classList.remove('hidden');
            let count = seconds;
            countdownNumber.textContent = count;
            broadcastSync('COUNTDOWN_START', { count });

            // Play beep for any count above 3
            if (count > 3) playBeepSound(880, 0.1);

            // Fire countdown voice guide at exactly 3.5 seconds remaining:
            // If total countdown >= 4s, schedule it 0.5s after the tick that shows "4"
            // If total countdown == 3s, fire immediately (count starts at 3)
            let countdownVoiceFired = false;
            function maybeFireCountdownVoice(currentCount) {
                if (countdownVoiceFired) return;
                if (currentCount === 4) {
                    // 0.5s after the "4" tick = 3.5s remaining
                    const t = setTimeout(() => {
                        if (activeSessionToken === token && !countdownVoiceFired) {
                            countdownVoiceFired = true;
                            playAudioCategory('countdown');
                        }
                    }, 500);
                    activeTimers.push(t);
                } else if (currentCount === 3) {
                    // countdown starts at 3 — fire immediately (already at 3.0s remaining)
                    countdownVoiceFired = true;
                    playAudioCategory('countdown');
                }
            }

            maybeFireCountdownVoice(count);

            const timer = setInterval(() => {
                if (activeSessionToken !== token) {
                    clearInterval(timer);
                    countdownOverlay.classList.add('hidden');
                    broadcastSync('COUNTDOWN_HIDE');
                    finishCountdown();
                    return;
                }

                count--;
                if (count > 0) {
                    countdownNumber.textContent = count;
                    broadcastSync('COUNTDOWN_UPDATE', { count });
                    if (count > 3) playBeepSound(880, 0.1);
                    maybeFireCountdownVoice(count);
                } else {
                    clearInterval(timer);
                    countdownOverlay.classList.add('hidden');
                    broadcastSync('COUNTDOWN_HIDE');
                    finishCountdown();
                }
            }, 1000);

            activeTimers.push(timer);
        });
    }

    function triggerFlash() {
        playShutterSound();
        flashOverlay.classList.add('active');
        broadcastSync('TRIGGER_FLASH');
        setTimeout(() => flashOverlay.classList.remove('active'), 200);
    }

    function getCanvasFilterString() {
        switch (selectedFilter) {
            case 'bw':        return 'grayscale(100%)';
            case 'sepia':     return 'sepia(80%)';
            case 'vintage':   return 'contrast(120%) saturate(70%) sepia(30%)';
            case 'cyberpunk': return 'hue-rotate(180deg) saturate(140%)';
            case 'vivid':     return 'saturate(160%) contrast(110%)';
            default:          return 'none';
        }
    }

    function captureWebcamFrame() {
        const canvas = document.createElement('canvas');
        const vw = webcamVideo.videoWidth || 1280;
        const vh = webcamVideo.videoHeight || 720;
        canvas.width = vw;
        canvas.height = vh;

        const ctx = canvas.getContext('2d');

        // Bake selected filter directly into the captured frame
        const filterStr = getCanvasFilterString();
        if (filterStr && filterStr !== 'none') {
            ctx.filter = filterStr;
        }

        if (isMirrored) {
            ctx.translate(vw, 0);
            ctx.scale(-1, 1);
        }
        ctx.drawImage(webcamVideo, 0, 0, vw, vh);

        // Reset filter so it doesn't bleed into other canvas draws
        ctx.filter = 'none';

        return canvas.toDataURL('image/png');
    }

    function showResultModal(outputUrl, code = '', filename = '') {
        if (!filename && outputUrl) {
            filename = outputUrl.split('/').pop();
        }
        resultImage.src = outputUrl;
        btnDownloadResult.href = outputUrl;
        if (filename) {
            btnDownloadResult.setAttribute('download', filename);
        }

        const modalHeader = document.querySelector('#resultModal h2');
        if (modalHeader) {
            const queueLabel = code ? (String(code).startsWith('Queue') ? code : `Queue #${String(code).replace('#', '')}`) : 'Queue #1';
            modalHeader.innerHTML = `🎉 Session Complete! ${code ? `<span style="font-size: 0.85rem; color: var(--g); background: var(--gdim); border: 1px solid var(--bg1); padding: 4px 12px; border-radius: 999px; margin-left: 10px;">🎟️ ${queueLabel}</span>` : ''}`;
        }
        resultModal.classList.remove('hidden');
    }

    btnCloseModal.addEventListener('click', () => resultModal.classList.add('hidden'));
    btnCloseModalBtn.addEventListener('click', () => resultModal.classList.add('hidden'));

    btnPrintResult.addEventListener('click', () => {
        const win = window.open(resultImage.src, '_blank');
        win.onload = () => win.print();
    });

    // --- TEMPLATE STUDIO & PSD UPLOAD ---
    psdDropzone.addEventListener('click', () => psdFileInput.click());

    psdDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        psdDropzone.style.borderColor = 'var(--g)';
    });

    psdDropzone.addEventListener('dragleave', () => {
        psdDropzone.style.borderColor = 'var(--b2)';
    });

    psdDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        psdDropzone.style.borderColor = 'var(--b2)';
        if (e.dataTransfer.files.length > 0) {
            psdFileInput.files = e.dataTransfer.files;
            templateTitleInput.value = e.dataTransfer.files[0].name.replace(/\.[^/.]+$/, "");
        }
    });

    psdFileInput.addEventListener('change', () => {
        if (psdFileInput.files.length > 0) {
            templateTitleInput.value = psdFileInput.files[0].name.replace(/\.[^/.]+$/, "");
        }
    });

    btnUploadPSD.addEventListener('click', async () => {
        if (!psdFileInput.files || psdFileInput.files.length === 0) {
            alert("Please choose a PSD or image file to upload.");
            return;
        }

        const formData = new FormData();
        formData.append('file', psdFileInput.files[0]);
        formData.append('title', templateTitleInput.value);

        btnUploadPSD.disabled = true;
        btnUploadPSD.innerHTML = '<span>⏳ Parsing & Saving to Database...</span>';

        try {
            const res = await fetch('/api/templates/import', {
                method: 'POST',
                body: formData
            });

            const data = await res.json();
            if (data.success) {
                alert("✨ Template imported successfully into SQLite database!");
                if (psdFileInput) psdFileInput.value = '';
                if (templateTitleInput) templateTitleInput.value = '';
                loadTemplates();
            } else {
                alert("Import Error: " + (data.error || "Failed to parse PSD/Image template."));
            }
        } catch (err) {
            console.error("PSD Upload Error:", err);
            alert("Connection or upload error occurred: " + err.message);
        } finally {
            btnUploadPSD.disabled = false;
            btnUploadPSD.innerHTML = '<span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="12" x2="12" y2="15"/></svg> Import &amp; Save</span>';
        }
    });

    function renderStudioTable() {
        dbTemplatesTableBody.innerHTML = '';
        templates.forEach(t => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><img class="table-thumb" src="${t.preview_url}" alt="${t.name}"></td>
                <td><strong>${t.name}</strong><br><small class="text-muted">${t.filename}</small></td>
                <td>${t.width} x ${t.height} px</td>
                <td><span class="badge">${t.slots ? t.slots.length : 0} Slots</span></td>
                <td>
                    <button class="btn btn-secondary btn-sm btn-del-temp" data-id="${t.id}">🗑️ Delete</button>
                </td>
            `;
            dbTemplatesTableBody.appendChild(tr);
        });

        document.querySelectorAll('.btn-del-temp').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.target.getAttribute('data-id');
                if (confirm("Are you sure you want to delete this template from the database?")) {
                    await fetch(`/api/templates/${id}`, { method: 'DELETE' });
                    loadTemplates();
                }
            });
        });
    }

    btnRefreshTemplates.addEventListener('click', loadTemplates);

    // --- GALLERY VIEW ---
    async function loadGallery() {
        try {
            const res = await fetch('/api/gallery');
            const data = await res.json();
            if (data.success) {
                renderGallery(data.sessions);
            }
        } catch (err) {
            console.error("Gallery fetch error:", err);
        }
    }

    function renderGallery(sessions) {
        galleryGrid.innerHTML = '';
        galleryCount.textContent = sessions.length;

        if (sessions.length === 0) {
            galleryGrid.innerHTML = '<p class="text-muted" style="grid-column: 1/-1;">No saved photobooth sessions yet. Take some photos in the Photobooth tab!</p>';
            return;
        }

        sessions.forEach(s => {
            const dateStr = new Date(s.created_at * 1000).toLocaleString();
            const dlFilename = s.output_path || `photobooth_${s.id}.png`;
            const qNum = s.queue_number || s.id;
            const qDisplay = s.code && String(s.code).startsWith('Queue') ? s.code : `Queue #${qNum}`;

            const card = document.createElement('div');
            card.className = 'gallery-card';
            card.innerHTML = `
                <div class="gallery-img-wrapper" title="Click to view full resolution">
                    <img src="${s.output_url}" alt="Photobooth Session">
                </div>
                <div class="gallery-card-info">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong style="color:var(--t1); font-size:0.85rem;">${s.guest_name ? s.guest_name + ' • ' : ''}${s.template_name || 'Photobooth'}</strong>
                        <span style="font-size:0.75rem; color:var(--g); font-weight:700; background:var(--gdim); border:1px solid var(--bg1); padding:2px 8px; border-radius:999px;">🎟️ ${qDisplay}</span>
                    </div>
                    <small style="color:var(--t3);">${dateStr}</small>
                </div>
                <div class="gallery-card-actions">
                    <a href="${s.output_url}" download="${dlFilename}" class="btn-download-sess">⬇️ Download High-Res</a>
                    <button class="btn btn-secondary btn-sm btn-del-sess" data-id="${s.id}" title="Delete session">🗑️</button>
                </div>
            `;

            // Click image to open in Result Modal
            const imgWrapper = card.querySelector('.gallery-img-wrapper');
            if (imgWrapper) {
                imgWrapper.addEventListener('click', () => {
                    showResultModal(s.output_url, s.code || '', dlFilename);
                });
            }

            galleryGrid.appendChild(card);
        });

        document.querySelectorAll('.btn-del-sess').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = e.target.getAttribute('data-id');
                if (confirm("Delete this session from gallery?")) {
                    await fetch(`/api/gallery/${id}`, { method: 'DELETE' });
                    loadGallery();
                }
            });
        });
    }

    btnRefreshGallery.addEventListener('click', loadGallery);

    // --- SPOTIFY BACKGROUND MUSIC CONTROLLER ---
    const spotifyUrlInput = document.getElementById('spotifyUrlInput');
    const btnImportSpotify = document.getElementById('btnImportSpotify');
    const btnToggleBgMusic = document.getElementById('btnToggleBgMusic');
    const bgMusicVolume = document.getElementById('bgMusicVolume');

    const bgMusicAudio = new Audio('/audio/music.mp3');
    bgMusicAudio.loop = true;
    bgMusicAudio.volume = 0.35;
    let isBgMusicPlaying = false;
    let isScrubbing = false;
    let currentMusicTrack = null;

    // The visualizer runs in a separate window. Keep the audio analyser beside
    // the real music element, then expose a same-origin bridge to that window.
    let musicVisualizerContext = null;
    let musicVisualizerSource = null;
    let musicVisualizerAnalyser = null;
    let musicVisualizerAnalysisActive = false;
    const activeVisualizerClients = new Set();
    let lastVisualizerSyncAt = 0;
    const musicVisualizerChannel = typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('pssc_music_visualizer')
        : null;

    function getMusicVisualizerState() {
        return {
            type: 'PLAYER_STATE',
            title: currentMusicTrack?.title || 'PSSC Background Music',
            source: currentMusicTrack?.source || 'player',
            src: bgMusicAudio.currentSrc || bgMusicAudio.src,
            currentTime: bgMusicAudio.currentTime || 0,
            duration: Number.isFinite(bgMusicAudio.duration) ? bgMusicAudio.duration : 0,
            isPlaying: !bgMusicAudio.paused && !bgMusicAudio.ended,
            volume: bgMusicAudio.volume
        };
    }

    function publishMusicVisualizerState(force = false) {
        if (!musicVisualizerChannel) return;
        const now = Date.now();
        if (!force && now - lastVisualizerSyncAt < 450) return;
        lastVisualizerSyncAt = now;
        musicVisualizerChannel.postMessage(getMusicVisualizerState());
    }

    function ensureMusicVisualizerGraph() {
        if (!musicVisualizerContext) {
            musicVisualizerContext = new (window.AudioContext || window.webkitAudioContext)();
            musicVisualizerAnalyser = musicVisualizerContext.createAnalyser();
            musicVisualizerAnalyser.fftSize = 2048;
            musicVisualizerAnalyser.smoothingTimeConstant = 0.72;

            // Once a media element is attached to Web Audio, it must remain
            // connected to the destination for normal player output.
            musicVisualizerSource = musicVisualizerContext.createMediaElementSource(bgMusicAudio);
        }

        if (musicVisualizerContext.state === 'suspended') {
            musicVisualizerContext.resume().catch(() => {});
        }

        if (!musicVisualizerAnalysisActive) {
            // Keep the analyser out of the audio graph until a visualizer window
            // is actually using it. This avoids continuous FFT work after it closes.
            musicVisualizerSource.disconnect();
            musicVisualizerAnalyser.disconnect();
            musicVisualizerSource.connect(musicVisualizerAnalyser);
            musicVisualizerAnalyser.connect(musicVisualizerContext.destination);
            musicVisualizerAnalysisActive = true;
        }

        return {
            context: musicVisualizerContext,
            analyser: musicVisualizerAnalyser,
            getState: getMusicVisualizerState
        };
    }

    function activateMusicVisualizer(clientId) {
        if (clientId) activeVisualizerClients.add(clientId);
        return ensureMusicVisualizerGraph();
    }

    function deactivateMusicVisualizer(clientId) {
        if (clientId) activeVisualizerClients.delete(clientId);
        if (activeVisualizerClients.size || !musicVisualizerAnalysisActive) return;

        // Keep music playing, but route around the analyser when no visualizer
        // window is open so its spectrum processing is no longer active.
        musicVisualizerSource.disconnect();
        musicVisualizerAnalyser.disconnect();
        musicVisualizerSource.connect(musicVisualizerContext.destination);
        musicVisualizerAnalysisActive = false;
    }

    window.__PSSC_MUSIC_VISUALIZER__ = {
        activate: activateMusicVisualizer,
        deactivate: deactivateMusicVisualizer,
        getState: getMusicVisualizerState,
        get context() { return musicVisualizerContext; },
        get analyser() { return musicVisualizerAnalyser; }
    };

    function startBgMusic() {
        if (!isBgMusicPlaying && bgMusicAudio) {
            bgMusicAudio.play().then(() => {
                isBgMusicPlaying = true;
                publishMusicVisualizerState(true);
                if (btnToggleBgMusic) btnToggleBgMusic.innerHTML = '<span>🔊 Music: ON</span>';
                if (typeof spPlayIcon !== 'undefined' && spPlayIcon) spPlayIcon.textContent = '❚❚';
            }).catch(err => {
                console.log("Background music autoplay blocked:", err);
            });
        }
    }

    function playNewTrackSource(srcUrl) {
        if (!bgMusicAudio) return;
        bgMusicAudio.pause();
        bgMusicAudio.src = srcUrl;
        bgMusicAudio.load();
        bgMusicAudio.play().then(() => {
            isBgMusicPlaying = true;
            publishMusicVisualizerState(true);
            if (btnToggleBgMusic) btnToggleBgMusic.innerHTML = '<span>🔊 Music: ON</span>';
            if (typeof spPlayIcon !== 'undefined' && spPlayIcon) spPlayIcon.textContent = '❚❚';
        }).catch(err => console.log("Track play error:", err));
    }

    // Auto-start background music on first user interaction
    document.addEventListener('click', () => {
        if (!isBgMusicPlaying) startBgMusic();
    }, { once: true });

    if (btnToggleBgMusic) {
        btnToggleBgMusic.addEventListener('click', () => {
            if (isBgMusicPlaying) {
                bgMusicAudio.pause();
                isBgMusicPlaying = false;
                btnToggleBgMusic.innerHTML = '<span>🔇 Music: OFF</span>';
                if (typeof spPlayIcon !== 'undefined' && spPlayIcon) spPlayIcon.textContent = '▶';
            } else {
                startBgMusic();
            }
        });
    }

    if (bgMusicVolume) {
        bgMusicVolume.addEventListener('input', (e) => {
            const vol = parseFloat(e.target.value);
            if (bgMusicAudio) {
                const targetFactor = isAudioDuckingActive ? 0.20 : 1.00;
                bgMusicAudio.volume = vol * targetFactor;
            }
        });
    }

    // --- MUSIC IMPORTER TABS & HANDLERS ---
    const tabSpotifyImport = document.getElementById('tabSpotifyImport');
    const tabYoutubeImport = document.getElementById('tabYoutubeImport');
    const tabUploadMp3 = document.getElementById('tabUploadMp3');
    const spotifyImportForm = document.getElementById('spotifyImportForm');
    const youtubeImportForm = document.getElementById('youtubeImportForm');
    const uploadMp3Form = document.getElementById('uploadMp3Form');

    if (tabSpotifyImport && tabYoutubeImport && tabUploadMp3) {
        tabSpotifyImport.addEventListener('click', () => {
            tabSpotifyImport.classList.add('active');
            tabYoutubeImport.classList.remove('active');
            tabUploadMp3.classList.remove('active');
            spotifyImportForm.classList.remove('hidden');
            youtubeImportForm.classList.add('hidden');
            uploadMp3Form.classList.add('hidden');
        });
        tabYoutubeImport.addEventListener('click', () => {
            tabYoutubeImport.classList.add('active');
            tabSpotifyImport.classList.remove('active');
            tabUploadMp3.classList.remove('active');
            youtubeImportForm.classList.remove('hidden');
            spotifyImportForm.classList.add('hidden');
            uploadMp3Form.classList.add('hidden');
        });
        tabUploadMp3.addEventListener('click', () => {
            tabUploadMp3.classList.add('active');
            tabSpotifyImport.classList.remove('active');
            tabYoutubeImport.classList.remove('active');
            uploadMp3Form.classList.remove('hidden');
            spotifyImportForm.classList.add('hidden');
            youtubeImportForm.classList.add('hidden');
        });
    }

    if (btnImportSpotify) {
        btnImportSpotify.addEventListener('click', async () => {
            const url = spotifyUrlInput ? spotifyUrlInput.value.trim() : '';
            if (!url) {
                alert("Please paste a valid Spotify track URL or enter a song title!");
                return;
            }

            btnImportSpotify.disabled = true;
            btnImportSpotify.innerHTML = '<span>⏳ Downloading...</span>';
            showStatusNotice("🎧 Downloading Spotify Track in High Quality (320kbps)...");

            try {
                const res = await fetch('/api/spotify-import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: url })
                });

                const data = await res.json();
                if (data.success) {
                    showStatusNotice(`🎉 ${data.message}`);
                    setTimeout(hideStatusNotice, 4000);

                    playNewTrackSource(`/audio/music.mp3?t=${Date.now()}`);
                    if (spotifyUrlInput) spotifyUrlInput.value = '';
                    loadMusicPlaylist();
                } else {
                    alert("Import Error: " + (data.error || "Failed to download Spotify audio."));
                    hideStatusNotice();
                }
            } catch (err) {
                console.error("Spotify Import Error:", err);
                alert("Connection or download error occurred.");
                hideStatusNotice();
            } finally {
                btnImportSpotify.disabled = false;
                btnImportSpotify.innerHTML = '<span>🟢 Import Spotify</span>';
            }
        });
    }

    // --- PLAYLIST REAL-TIME IMPORT POLLING ENGINE ---
    let playlistPollInterval = null;

    function startPlaylistImportPolling() {
        if (playlistPollInterval) clearInterval(playlistPollInterval);

        playlistPollInterval = setInterval(async () => {
            try {
                const res = await fetch('/api/import-progress');
                const data = await res.json();

                if (data.in_progress) {
                    const total = data.total_tracks || 0;
                    const idx = data.current_index || 0;
                    const curTrack = data.current_track || '';
                    const plName = data.playlist_name || 'Playlist';

                    showStatusNotice(`📜 Downloading "${plName}" (${idx}/${total}): ${curTrack}`);
                    loadMusicPlaylist();
                } else if (data.completed) {
                    clearInterval(playlistPollInterval);
                    playlistPollInterval = null;
                    showStatusNotice(`🎉 Playlist "${data.playlist_name || 'Imported'}" Complete!`);
                    loadMusicPlaylist();
                    setTimeout(hideStatusNotice, 4000);
                }
            } catch (err) {
                console.error("Playlist status polling error:", err);
            }
        }, 1800);
    }

    const btnImportYoutube = document.getElementById('btnImportYoutube');
    const youtubeUrlInput = document.getElementById('youtubeUrlInput');
    if (btnImportYoutube) {
        btnImportYoutube.addEventListener('click', async () => {
            const url = youtubeUrlInput ? youtubeUrlInput.value.trim() : '';
            if (!url) {
                alert("Please paste a valid YouTube URL or song name!");
                return;
            }

            logUserAction("Imported YouTube track/playlist", url);
            btnImportYoutube.disabled = true;
            btnImportYoutube.innerHTML = '<span>⏳ Downloading...</span>';
            showStatusNotice("🔴 Processing YouTube Import...");

            try {
                const res = await fetch('/api/youtube-import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                const data = await res.json();
                if (data.success) {
                    if (data.is_playlist) {
                        showStatusNotice("📜 Started importing YouTube Playlist in real-time...");
                        if (youtubeUrlInput) youtubeUrlInput.value = '';
                        startPlaylistImportPolling();
                    } else {
                        showStatusNotice(`🎉 ${data.message}`);
                        setTimeout(hideStatusNotice, 4000);
                        playNewTrackSource(`/audio/music.mp3?t=${Date.now()}`);
                        if (youtubeUrlInput) youtubeUrlInput.value = '';
                        loadMusicPlaylist();
                    }
                } else {
                    alert("YouTube Import Error: " + (data.error || "Failed to download audio."));
                    hideStatusNotice();
                }
            } catch (err) {
                console.error("YouTube Import Error:", err);
                alert("Connection or download error occurred: " + err.message);
                hideStatusNotice();
            } finally {
                btnImportYoutube.disabled = false;
                btnImportYoutube.innerHTML = '<span>🔴 Import YouTube</span>';
            }
        });
    }

    const btnUploadLocalMp3 = document.getElementById('btnUploadLocalMp3');
    const localMp3FileInput = document.getElementById('localMp3FileInput');
    if (btnUploadLocalMp3) {
        btnUploadLocalMp3.addEventListener('click', async () => {
            if (!localMp3FileInput || !localMp3FileInput.files || localMp3FileInput.files.length === 0) {
                alert("Please select an audio file to upload!");
                return;
            }

            const file = localMp3FileInput.files[0];
            const formData = new FormData();
            formData.append('file', file);

            btnUploadLocalMp3.disabled = true;
            btnUploadLocalMp3.innerHTML = '<span>⏳ Uploading...</span>';
            showStatusNotice("📁 Uploading Custom MP3 Track...");

            try {
                const res = await fetch('/api/music/upload', {
                    method: 'POST',
                    body: formData
                });
                const data = await res.json();
                if (data.success) {
                    showStatusNotice(`🎉 ${data.message}`);
                    setTimeout(hideStatusNotice, 4000);
                    playNewTrackSource(`/audio/music.mp3?t=${Date.now()}`);
                    localMp3FileInput.value = '';
                    loadMusicPlaylist();
                } else {
                    alert("Upload Error: " + (data.error || "Failed to upload audio file."));
                    hideStatusNotice();
                }
            } catch (err) {
                console.error("Audio Upload Error:", err);
                alert("Upload error occurred.");
                hideStatusNotice();
            } finally {
                btnUploadLocalMp3.disabled = false;
                btnUploadLocalMp3.innerHTML = '<span>📁 Upload MP3</span>';
            }
        });
    }

    // --- MUSIC VIEW TABS (INDIVIDUAL SONGS VS PLAYLISTS VS IMPORTER) ---
    const viewTabSongs = document.getElementById('viewTabSongs');
    const viewTabPlaylists = document.getElementById('viewTabPlaylists');
    const viewTabImport = document.getElementById('viewTabImport');
    const musicSongsView = document.getElementById('musicSongsView');
    const musicPlaylistsView = document.getElementById('musicPlaylistsView');
    const musicImportView = document.getElementById('musicImportView');

    if (viewTabSongs && viewTabPlaylists && viewTabImport && musicSongsView && musicPlaylistsView && musicImportView) {
        viewTabSongs.addEventListener('click', () => {
            viewTabSongs.classList.add('active');
            viewTabPlaylists.classList.remove('active');
            viewTabImport.classList.remove('active');
            musicSongsView.classList.remove('hidden');
            musicPlaylistsView.classList.add('hidden');
            musicImportView.classList.add('hidden');
        });
        viewTabPlaylists.addEventListener('click', () => {
            viewTabPlaylists.classList.add('active');
            viewTabSongs.classList.remove('active');
            viewTabImport.classList.remove('active');
            musicPlaylistsView.classList.remove('hidden');
            musicSongsView.classList.add('hidden');
            musicImportView.classList.add('hidden');
            renderPlaylistsUI();
        });
        viewTabImport.addEventListener('click', () => {
            viewTabImport.classList.add('active');
            viewTabSongs.classList.remove('active');
            viewTabPlaylists.classList.remove('active');
            musicImportView.classList.remove('hidden');
            musicSongsView.classList.add('hidden');
            musicPlaylistsView.classList.add('hidden');
        });
    }

    // --- PLAYLISTS TAB & SEARCH ---
    const playlistSearchInput = document.getElementById('playlistSearchInput');
    const playlistsGridContainer = document.getElementById('playlistsGridContainer');
    const btnRefreshPlaylistsTab = document.getElementById('btnRefreshPlaylistsTab');

    let playlistSearchQuery = '';

    if (playlistSearchInput) {
        playlistSearchInput.addEventListener('input', (e) => {
            playlistSearchQuery = e.target.value.toLowerCase().trim();
            renderPlaylistsUI();
        });
    }

    if (btnRefreshPlaylistsTab) {
        btnRefreshPlaylistsTab.addEventListener('click', loadMusicPlaylist);
    }

    function renderPlaylistsUI() {
        if (!playlistsGridContainer) return;
        playlistsGridContainer.innerHTML = '';

        if (!currentMusicLibraryTracks || currentMusicLibraryTracks.length === 0) {
            playlistsGridContainer.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 16px;">No playlists available. Import songs or playlists from Spotify/YouTube!</div>`;
            return;
        }

        // Build playlist groups: standalone playlists + source defaults
        const playlistGroups = [];
        const customPlaylists = {};

        currentMusicLibraryTracks.forEach(t => {
            if (t.playlist_name) {
                if (!customPlaylists[t.playlist_name]) {
                    customPlaylists[t.playlist_name] = [];
                }
                customPlaylists[t.playlist_name].push(t);
            }
        });

        // Add custom imported playlists first
        Object.keys(customPlaylists).forEach(plName => {
            const tracks = customPlaylists[plName];
            const src = tracks[0].source || 'youtube';
            const icon = src === 'youtube' ? '🔴' : (src === 'custom' ? '📁' : '🟢');
            const color = src === 'youtube' ? '#FF0000' : (src === 'custom' ? '#00E676' : '#1DB954');
            playlistGroups.push({
                id: `pl_${plName.replace(/\s+/g, '_')}`,
                name: `📜 ${plName}`,
                raw_playlist_name: plName,
                source: src,
                icon: icon,
                color: color,
                tracks: tracks
            });
        });

        // Default source collections
        playlistGroups.push(
            { id: 'spotify_all', name: '🟢 Spotify All Collection', source: 'spotify', icon: '🟢', color: '#1DB954', tracks: currentMusicLibraryTracks.filter(t => (t.source || 'spotify') === 'spotify') },
            { id: 'youtube_all', name: '🔴 YouTube All Mix', source: 'youtube', icon: '🔴', color: '#FF0000', tracks: currentMusicLibraryTracks.filter(t => t.source === 'youtube') },
            { id: 'custom_all', name: '📁 Local MP3 Collection', source: 'custom', icon: '📁', color: '#00E676', tracks: currentMusicLibraryTracks.filter(t => t.source === 'custom') }
        );

        let filteredGroups = playlistGroups.filter(g => g.tracks.length > 0);
        if (playlistSearchQuery) {
            filteredGroups = filteredGroups.filter(g => g.name.toLowerCase().includes(playlistSearchQuery));
        }

        if (filteredGroups.length === 0) {
            playlistsGridContainer.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 16px;">No playlists match "${playlistSearchQuery}".</div>`;
            return;
        }

        filteredGroups.forEach(pl => {
            const hasActive = pl.tracks.some(t => t.is_active);
            const card = document.createElement('div');
            card.className = `glass-card ${hasActive ? 'active-track' : ''}`;
            card.style.padding = '12px 14px';
            card.style.display = 'flex';
            card.style.flexDirection = 'column';
            card.style.justifyContent = 'space-between';
            card.style.gap = '8px';
            card.style.cursor = 'pointer';
            card.style.border = `1px solid ${hasActive ? pl.color : 'rgba(255,255,255,0.1)'}`;

            card.innerHTML = `
                <div>
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 1.2rem;">${pl.icon}</span>
                        <span class="badge" style="background: rgba(255,255,255,0.1); color: var(--text-main); font-size: 0.72rem;">${pl.tracks.length} Songs</span>
                    </div>
                    <h4 style="margin: 8px 0 4px 0; font-size: 0.92rem; color: #fff;">${pl.name}</h4>
                    <p style="margin: 0; font-size: 0.75rem; color: var(--text-muted);">${pl.tracks.slice(0, 2).map(t => t.title).join(', ')}${pl.tracks.length > 2 ? '...' : ''}</p>
                    <span style="font-size: 0.7rem; color: ${pl.color}; text-decoration: underline; margin-top: 4px; display: inline-block;">👁️ Click card to view songs</span>
                </div>
                <div style="display: flex; gap: 6px; margin-top: 6px;">
                    <button class="btn btn-secondary btn-sm btn-play-playlist" data-id="${pl.tracks[0].id}" style="flex: 1; border-color: ${pl.color}; color: ${pl.color}; font-size: 0.75rem; padding: 4px;">
                        ▶️ Play Playlist
                    </button>
                    ${pl.raw_playlist_name ? `<button class="btn btn-secondary btn-sm btn-del-playlist" data-name="${pl.raw_playlist_name}" style="border-color: #ff4444; color: #ff4444; font-size: 0.75rem; padding: 4px 8px;" title="Delete Playlist & All Songs">🗑️ Delete</button>` : ''}
                </div>
            `;

            card.addEventListener('click', (e) => {
                if (e.target.closest('.btn-play-playlist') || e.target.closest('.btn-del-playlist')) return;
                openPlaylistModal(pl);
            });

            card.querySelector('.btn-play-playlist').addEventListener('click', (e) => {
                e.stopPropagation();
                selectTrackById(pl.tracks[0].id);
            });

            card.querySelector('.btn-del-playlist')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                const plName = pl.raw_playlist_name;
                if (confirm(`🗑️ Delete playlist "${plName}" and permanently purge all ${pl.tracks.length} songs in it?`)) {
                    logUserAction("Deleted Playlist & All Songs", plName);
                    showStatusNotice(`🗑️ Deleting playlist "${plName}"...`);
                    try {
                        const res = await fetch(`/api/music/playlist/${encodeURIComponent(plName)}`, { method: 'DELETE' });
                        const data = await res.json();
                        if (data.success) {
                            showStatusNotice(`🎉 Playlist "${plName}" and ${data.deleted_count} songs deleted!`);
                            setTimeout(hideStatusNotice, 3000);
                            loadMusicPlaylist();
                        } else {
                            alert("Delete Error: " + (data.error || "Failed to delete playlist."));
                            hideStatusNotice();
                        }
                    } catch (err) {
                        alert("Error deleting playlist: " + err.message);
                        hideStatusNotice();
                    }
                }
            });

            playlistsGridContainer.appendChild(card);
        });
    }

    // --- PLAYLIST DETAIL MODAL CONTROLLER ---
    const playlistDetailModal = document.getElementById('playlistDetailModal');
    const btnClosePlaylistModal = document.getElementById('btnClosePlaylistModal');
    const btnClosePlaylistModalBtn = document.getElementById('btnClosePlaylistModalBtn');
    const plModalIcon = document.getElementById('plModalIcon');
    const plModalTitle = document.getElementById('plModalTitle');
    const plModalSub = document.getElementById('plModalSub');
    const playlistModalSearch = document.getElementById('playlistModalSearch');
    const playlistModalTracksContainer = document.getElementById('playlistModalTracksContainer');
    const btnPlayAllInPlaylist = document.getElementById('btnPlayAllInPlaylist');
    const btnDeleteEntirePlaylist = document.getElementById('btnDeleteEntirePlaylist');

    let activePlaylistGroup = null;
    let playlistModalSearchQuery = '';

    function openPlaylistModal(plGroup) {
        if (!playlistDetailModal) return;
        activePlaylistGroup = plGroup;
        playlistModalSearchQuery = '';
        if (playlistModalSearch) playlistModalSearch.value = '';

        if (plModalIcon) plModalIcon.textContent = plGroup.icon || '📜';
        if (plModalTitle) plModalTitle.textContent = plGroup.name;
        if (plModalSub) plModalSub.textContent = `${plGroup.tracks.length} Songs in Playlist • Click any track to play`;

        if (btnDeleteEntirePlaylist) {
            if (plGroup.raw_playlist_name) {
                btnDeleteEntirePlaylist.classList.remove('hidden');
            } else {
                btnDeleteEntirePlaylist.classList.add('hidden');
            }
        }

        renderPlaylistModalTracks();
        playlistDetailModal.classList.remove('hidden');
    }

    function closePlaylistModal() {
        if (playlistDetailModal) playlistDetailModal.classList.add('hidden');
    }

    if (btnClosePlaylistModal) btnClosePlaylistModal.addEventListener('click', closePlaylistModal);
    if (btnClosePlaylistModalBtn) btnClosePlaylistModalBtn.addEventListener('click', closePlaylistModal);
    if (playlistDetailModal) {
        playlistDetailModal.addEventListener('click', (e) => {
            if (e.target === playlistDetailModal) closePlaylistModal();
        });
    }

    if (playlistModalSearch) {
        playlistModalSearch.addEventListener('input', (e) => {
            playlistModalSearchQuery = e.target.value.toLowerCase().trim();
            renderPlaylistModalTracks();
        });
    }

    if (btnPlayAllInPlaylist) {
        btnPlayAllInPlaylist.addEventListener('click', () => {
            if (activePlaylistGroup && activePlaylistGroup.tracks.length > 0) {
                selectTrackById(activePlaylistGroup.tracks[0].id);
                closePlaylistModal();
            }
        });
    }

    if (btnDeleteEntirePlaylist) {
        btnDeleteEntirePlaylist.addEventListener('click', async () => {
            if (!activePlaylistGroup || !activePlaylistGroup.raw_playlist_name) return;
            const plName = activePlaylistGroup.raw_playlist_name;
            const count = activePlaylistGroup.tracks ? activePlaylistGroup.tracks.length : 0;
            if (confirm(`🗑️ Delete playlist "${plName}" and permanently purge all ${count} songs in it?`)) {
                logUserAction("Deleted Playlist & All Songs", plName);
                closePlaylistModal();
                showStatusNotice(`🗑️ Deleting playlist "${plName}"...`);
                try {
                    const res = await fetch(`/api/music/playlist/${encodeURIComponent(plName)}`, { method: 'DELETE' });
                    const data = await res.json();
                    if (data.success) {
                        showStatusNotice(`🎉 Playlist "${plName}" and ${data.deleted_count} songs deleted!`);
                        setTimeout(hideStatusNotice, 3000);
                        loadMusicPlaylist();
                    } else {
                        alert("Delete Error: " + (data.error || "Failed to delete playlist."));
                        hideStatusNotice();
                    }
                } catch (err) {
                    alert("Error deleting playlist: " + err.message);
                    hideStatusNotice();
                }
            }
        });
    }

    function renderPlaylistModalTracks() {
        if (!playlistModalTracksContainer || !activePlaylistGroup) return;
        playlistModalTracksContainer.innerHTML = '';

        let tracks = activePlaylistGroup.tracks;
        if (playlistModalSearchQuery) {
            tracks = tracks.filter(t => (t.title || '').toLowerCase().includes(playlistModalSearchQuery));
        }

        if (!tracks || tracks.length === 0) {
            playlistModalTracksContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 12px;">No matching songs found in this playlist.</div>`;
            return;
        }

        tracks.forEach(track => {
            const sourceBadge = track.source === 'youtube'
                ? '<span style="font-size:0.72rem; color:#FF0000; font-weight:600; background:rgba(255,0,0,0.15); padding:2px 6px; border-radius:4px;">🔴 YouTube</span>'
                : (track.source === 'custom'
                    ? '<span style="font-size:0.72rem; color:#00E676; font-weight:600; background:rgba(0,230,118,0.15); padding:2px 6px; border-radius:4px;">📁 MP3</span>'
                    : '<span style="font-size:0.72rem; color:#1DB954; font-weight:600; background:rgba(29,185,84,0.15); padding:2px 6px; border-radius:4px;">🟢 Spotify</span>');

            const item = document.createElement('div');
            item.className = `playlist-item ${track.is_active ? 'active-track' : ''}`;
            item.style.cursor = 'pointer';
            item.innerHTML = `
                <div class="playlist-item-info" style="display:flex; align-items:center; gap:8px; flex:1; overflow:hidden;">
                    ${sourceBadge}
                    <span class="playlist-item-title" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600;">${track.title}</span>
                    ${track.is_active ? '<span class="playlist-active-tag">▶️ Playing</span>' : ''}
                </div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    ${!track.is_active ? `<button class="btn btn-secondary btn-sm btn-select-modal-track" data-id="${track.id}" style="font-size:0.75rem; padding: 2px 8px;">▶️ Select</button>` : '<span style="font-size:0.75rem; color:#1DB954; font-weight:700;">Active</span>'}
                    <button class="btn btn-secondary btn-sm btn-del-modal-track" data-id="${track.id}" style="font-size:0.75rem; padding: 2px 6px;">🗑️</button>
                </div>
            `;

            item.querySelector('.btn-select-modal-track')?.addEventListener('click', (e) => {
                e.stopPropagation();
                selectTrackById(track.id);
            });

            item.addEventListener('click', () => {
                selectTrackById(track.id);
            });

            item.querySelector('.btn-del-modal-track').addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm("Delete this track from playlist?")) {
                    await fetch(`/api/music/library/${track.id}`, { method: 'DELETE' });
                    loadMusicPlaylist();
                    closePlaylistModal();
                }
            });

            playlistModalTracksContainer.appendChild(item);
        });
    }

    // --- MUSIC SEARCH & CATEGORY FILTERS ---
    let currentMusicLibraryTracks = [];
    let activeSourceFilter = 'all';
    let searchQuery = '';

    const musicSearchInput = document.getElementById('musicSearchInput');
    if (musicSearchInput) {
        musicSearchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.toLowerCase().trim();
            applyMusicFilters();
        });
    }

    document.querySelectorAll('.filter-pill-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-pill-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeSourceFilter = btn.getAttribute('data-source');
            applyMusicFilters();
        });
    });

    function applyMusicFilters() {
        let filtered = currentMusicLibraryTracks;
        if (activeSourceFilter !== 'all') {
            filtered = filtered.filter(t => (t.source || 'spotify') === activeSourceFilter);
        }
        if (searchQuery) {
            filtered = filtered.filter(t => (t.title || '').toLowerCase().includes(searchQuery));
        }
        renderMusicPlaylistUI(filtered);
    }

    // --- MUSIC PLAYLIST & LIBRARY CONTROLLER ---
    const musicPlaylistContainer = document.getElementById('musicPlaylistContainer');
    const btnRefreshPlaylist = document.getElementById('btnRefreshPlaylist');

    // SPOTIFY-STYLE PLAYER BAR CONTROLLERS
    const playerBtnPlayPause = document.getElementById('playerBtnPlayPause');
    const playerBtnShuffle = document.getElementById('playerBtnShuffle');
    const playerBtnRepeat = document.getElementById('playerBtnRepeat');
    const playerBtnPrev = document.getElementById('playerBtnPrev');
    const playerBtnNext = document.getElementById('playerBtnNext');
    const playerCurrentTime = document.getElementById('playerCurrentTime');
    const playerTotalDuration = document.getElementById('playerTotalDuration');
    const playerScrubber = document.getElementById('playerScrubber');
    const spScrubberFill = document.getElementById('spScrubberFill');
    const playerTrackTitle = document.getElementById('playerTrackTitle');
    const playerTrackArtist = document.getElementById('playerTrackArtist');
    const playerSourceTag = document.getElementById('playerSourceTag');
    const spPlayIcon = document.getElementById('spPlayIcon');

    let isShuffleOn = false;
    let isRepeatOn = false;

    function updateSpotifyPlayerUI(track) {
        if (track) {
            currentMusicTrack = track;
            if (playerTrackTitle) playerTrackTitle.textContent = track.title;
            if (playerTrackArtist) playerTrackArtist.textContent = `${track.source_url || 'Music Library Track'}`;
            if (playerSourceTag) {
                const src = track.source || 'spotify';
                playerSourceTag.textContent = src === 'youtube' ? '🔴 YouTube' : (src === 'custom' ? '📁 MP3 File' : '🟢 Spotify');
                playerSourceTag.style.color = src === 'youtube' ? '#FF0000' : (src === 'custom' ? '#00E676' : '#1DB954');
            }
            publishMusicVisualizerState(true);
        }
    }

    if (playerBtnPlayPause) {
        playerBtnPlayPause.addEventListener('click', () => {
            if (isBgMusicPlaying) {
                bgMusicAudio.pause();
                isBgMusicPlaying = false;
                if (spPlayIcon) spPlayIcon.textContent = '▶';
            } else {
                startBgMusic();
                isBgMusicPlaying = true;
                if (spPlayIcon) spPlayIcon.textContent = '❚❚';
            }
        });
    }

    const playerModeStatusBadge = document.getElementById('playerModeStatusBadge');

    function updatePlayerModeBadge() {
        if (!playerModeStatusBadge) return;
        if (isShuffleOn && isRepeatOn) {
            playerModeStatusBadge.textContent = '🔀 Shuffle + 🔁 Repeat ON';
            playerModeStatusBadge.className = 'player-mode-badge mode-both';
        } else if (isShuffleOn) {
            playerModeStatusBadge.textContent = '🔀 Shuffle ON';
            playerModeStatusBadge.className = 'player-mode-badge mode-shuffle';
        } else if (isRepeatOn) {
            playerModeStatusBadge.textContent = '🔁 Repeat ON';
            playerModeStatusBadge.className = 'player-mode-badge mode-repeat';
        } else {
            playerModeStatusBadge.textContent = '';
            playerModeStatusBadge.className = 'player-mode-badge';
        }
    }

    if (playerBtnShuffle) {
        playerBtnShuffle.addEventListener('click', () => {
            isShuffleOn = !isShuffleOn;
            playerBtnShuffle.classList.toggle('active-control', isShuffleOn);
            updatePlayerModeBadge();
        });
    }

    if (playerBtnRepeat) {
        playerBtnRepeat.addEventListener('click', () => {
            isRepeatOn = !isRepeatOn;
            playerBtnRepeat.classList.toggle('active-control', isRepeatOn);
            updatePlayerModeBadge();
        });
    }

    if (playerBtnPrev) {
        playerBtnPrev.addEventListener('click', () => playNeighborTrack(-1));
    }

    if (playerBtnNext) {
        playerBtnNext.addEventListener('click', () => playNeighborTrack(1));
    }

    function playNeighborTrack(offset) {
        if (!currentMusicLibraryTracks || currentMusicLibraryTracks.length === 0) return;
        const activeIdx = currentMusicLibraryTracks.findIndex(t => t.is_active);
        let nextIdx = activeIdx >= 0 ? activeIdx + offset : 0;
        if (isShuffleOn) {
            nextIdx = Math.floor(Math.random() * currentMusicLibraryTracks.length);
        } else {
            if (nextIdx < 0) nextIdx = currentMusicLibraryTracks.length - 1;
            if (nextIdx >= currentMusicLibraryTracks.length) nextIdx = 0;
        }
        const targetTrack = currentMusicLibraryTracks[nextIdx];
        if (targetTrack) selectTrackById(targetTrack.id);
    }

    function formatTime(sec) {
        if (isNaN(sec) || sec <= 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    if (bgMusicAudio) {
        bgMusicAudio.addEventListener('play', () => publishMusicVisualizerState(true));
        bgMusicAudio.addEventListener('pause', () => publishMusicVisualizerState(true));
        bgMusicAudio.addEventListener('seeked', () => publishMusicVisualizerState(true));
        bgMusicAudio.addEventListener('loadedmetadata', () => publishMusicVisualizerState(true));
        bgMusicAudio.addEventListener('volumechange', () => publishMusicVisualizerState(true));
        bgMusicAudio.addEventListener('timeupdate', () => {
            if (!bgMusicAudio.duration) return;
            const cur = bgMusicAudio.currentTime;
            const dur = bgMusicAudio.duration;
            const pct = (cur / dur) * 100;

            if (playerCurrentTime) playerCurrentTime.textContent = formatTime(cur);
            if (playerTotalDuration) playerTotalDuration.textContent = formatTime(dur);
            if (spScrubberFill) spScrubberFill.style.width = `${pct}%`;
            if (playerScrubber) playerScrubber.value = pct;
            publishMusicVisualizerState();
        });

        bgMusicAudio.addEventListener('ended', () => {
            if (isRepeatOn) {
                bgMusicAudio.currentTime = 0;
                bgMusicAudio.play();
            } else {
                playNeighborTrack(1);
            }
        });
    }

    if (playerScrubber) {
        playerScrubber.addEventListener('mousedown', () => { isScrubbing = true; });
        playerScrubber.addEventListener('mouseup', () => { isScrubbing = false; });
        playerScrubber.addEventListener('touchstart', () => { isScrubbing = true; });
        playerScrubber.addEventListener('touchend', () => { isScrubbing = false; });
        playerScrubber.addEventListener('input', (e) => {
            if (bgMusicAudio && bgMusicAudio.duration) {
                const pct = parseFloat(e.target.value);
                const targetTime = (pct / 100) * bgMusicAudio.duration;
                bgMusicAudio.currentTime = targetTime;
                if (spScrubberFill) spScrubberFill.style.width = `${pct}%`;
                if (playerCurrentTime) playerCurrentTime.textContent = formatTime(targetTime);
            }
        });
    }

    async function loadMusicPlaylist() {
        if (!musicPlaylistContainer) return;
        try {
            const res = await fetch('/api/music/library');
            const data = await res.json();
            if (data.success && data.tracks) {
                currentMusicLibraryTracks = data.tracks;
                const activeTrack = currentMusicLibraryTracks.find(t => t.is_active);
                if (activeTrack) updateSpotifyPlayerUI(activeTrack);
                const telemetryMusicCount = document.getElementById('telemetryMusicCount');
                if (telemetryMusicCount) telemetryMusicCount.textContent = `${data.tracks.length} Songs`;
                applyMusicFilters();
            }
        } catch (err) {
            console.error("Failed to load music playlist:", err);
        }
    }

    function renderMusicPlaylistUI(tracks) {
        if (!musicPlaylistContainer) return;
        musicPlaylistContainer.innerHTML = '';

        if (!tracks || tracks.length === 0) {
            musicPlaylistContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 12px;">No matching tracks found. Try adjusting your search query or import a track!</div>`;
            return;
        }

        // Sort alphabetically A→Z (active track stays at top)
        const activeTrack = tracks.find(t => t.is_active);
        const otherTracks = tracks.filter(t => !t.is_active).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        const sortedTracks = activeTrack ? [activeTrack, ...otherTracks] : otherTracks;
        tracks = sortedTracks;

        tracks.forEach(track => {
            const sourceBadge = track.source === 'youtube'
                ? '<span style="font-size:0.72rem; color:#FF0000; font-weight:600; background:rgba(255,0,0,0.15); padding:2px 6px; border-radius:4px;">🔴 YouTube</span>'
                : (track.source === 'custom'
                    ? '<span style="font-size:0.72rem; color:#00E676; font-weight:600; background:rgba(0,230,118,0.15); padding:2px 6px; border-radius:4px;">📁 MP3</span>'
                    : '<span style="font-size:0.72rem; color:#1DB954; font-weight:600; background:rgba(29,185,84,0.15); padding:2px 6px; border-radius:4px;">🟢 Spotify</span>');

            const item = document.createElement('div');
            item.className = `playlist-item ${track.is_active ? 'active-track' : ''}`;
            item.innerHTML = `
                <div class="playlist-item-info" style="display:flex; align-items:center; gap:8px; flex:1; overflow:hidden;">
                    ${sourceBadge}
                    <span class="playlist-item-title" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600;">${track.title}</span>
                    ${track.is_active ? '<span class="playlist-active-tag">▶️ Playing</span>' : ''}
                </div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    ${!track.is_active ? `<button class="btn btn-secondary btn-sm btn-select-track" data-id="${track.id}" style="font-size:0.75rem; padding: 2px 8px;">▶️ Select</button>` : ''}
                    <button class="btn btn-secondary btn-sm btn-del-track" data-id="${track.id}" style="font-size:0.75rem; padding: 2px 6px;">🗑️</button>
                </div>
            `;
            musicPlaylistContainer.appendChild(item);
        });

        // Event listeners for select and delete
        musicPlaylistContainer.querySelectorAll('.btn-select-track').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.target.getAttribute('data-id');
                selectTrackById(id);
            });
        });

        musicPlaylistContainer.querySelectorAll('.btn-del-track').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.target.getAttribute('data-id');
                if (confirm("Delete this track from playlist library?")) {
                    await fetch(`/api/music/library/${id}`, { method: 'DELETE' });
                    loadMusicPlaylist();
                }
            });
        });
    }

    async function selectTrackById(id) {
        const res = await fetch(`/api/music/select-track/${id}`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showStatusNotice(`🎉 ${data.message}`);
            setTimeout(hideStatusNotice, 3000);

            playNewTrackSource(`/audio/music.mp3?t=${Date.now()}`);
            loadMusicPlaylist();
        }
    }

    if (btnRefreshPlaylist) {
        btnRefreshPlaylist.addEventListener('click', loadMusicPlaylist);
    }

    // --- BKLIT UI LIVE TELEMETRY CHART ENGINE ---
    const bklitLiveChart = document.getElementById('bklitLiveChart');
    let chartDataPoints = [22, 24, 25, 28, 30, 27, 26, 29, 31, 28, 25, 27, 29, 30, 32, 29, 27, 28, 30, 31, 29, 28, 30, 32, 31, 29, 30, 32, 31, 30];

    function renderBklitTelemetryChart() {
        const settingsTab = document.getElementById('tab-settings');
        if (!settingsTab || !settingsTab.classList.contains('active') || !bklitLiveChart) return;
        const ctx = bklitLiveChart.getContext('2d');
        const w = bklitLiveChart.clientWidth || 300;
        const h = bklitLiveChart.clientHeight || 48;
        if (bklitLiveChart.width !== w) bklitLiveChart.width = w;
        if (bklitLiveChart.height !== h) bklitLiveChart.height = h;

        chartDataPoints.shift();
        const nextVal = isAudioDuckingActive ? Math.floor(Math.random() * 8 + 12) : Math.floor(Math.random() * 10 + 24);
        chartDataPoints.push(nextVal);

        ctx.clearRect(0, 0, w, h);

        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, 'rgba(0, 240, 255, 0.45)');
        grad.addColorStop(1, 'rgba(0, 230, 118, 0.05)');

        ctx.beginPath();
        ctx.moveTo(0, h);
        const step = w / (chartDataPoints.length - 1);
        chartDataPoints.forEach((val, idx) => {
            const x = idx * step;
            const y = h - (val / 40) * h;
            ctx.lineTo(x, y);
        });
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        chartDataPoints.forEach((val, idx) => {
            const x = idx * step;
            const y = h - (val / 40) * h;
            if (idx === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = '#00F0FF';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    setInterval(renderBklitTelemetryChart, 2000);

    // --- CLOUD & DATABASE CONFIGURATION HANDLERS ---
    const googleSheetsUrlInput = document.getElementById('googleSheetsUrlInput');
    const googleDriveUrlInput = document.getElementById('googleDriveUrlInput');
    const btnSaveCloudConfig = document.getElementById('btnSaveCloudConfig');
    const btnTestQueueSync = document.getElementById('btnTestQueueSync');
    const topbarQueueText = document.getElementById('topbarQueueText');

    async function loadSystemConfig() {
        try {
            const res = await fetch('/api/config');
            const data = await res.json();
            if (data.success) {
                if (googleSheetsUrlInput) googleSheetsUrlInput.value = data.google_sheets_url || '';
                if (googleDriveUrlInput) googleDriveUrlInput.value = data.google_drive_url || '';
                if (topbarQueueText) topbarQueueText.textContent = data.queue_display || 'Queue #1';
            }
        } catch (err) {
            console.error("Config fetch error:", err);
        }
    }

    if (btnSaveCloudConfig) {
        btnSaveCloudConfig.addEventListener('click', async () => {
            const sheetsUrl = googleSheetsUrlInput ? googleSheetsUrlInput.value.trim() : '';
            const driveUrl = googleDriveUrlInput ? googleDriveUrlInput.value.trim() : '';

            btnSaveCloudConfig.disabled = true;
            btnSaveCloudConfig.innerHTML = '<span>⏳ Saving...</span>';

            try {
                const res = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        google_sheets_url: sheetsUrl,
                        google_drive_url: driveUrl
                    })
                });
                const data = await res.json();
                if (data.success) {
                    alert("✅ Google Sheets & Drive database settings saved successfully!");
                    logUserAction("Saved Cloud Database Settings", `Sheets: ${sheetsUrl}, Drive: ${driveUrl}`);
                } else {
                    alert("Error saving settings: " + (data.error || "Failed to save"));
                }
            } catch (err) {
                alert("Failed to save cloud config: " + err.message);
            } finally {
                btnSaveCloudConfig.disabled = false;
                btnSaveCloudConfig.innerHTML = '<span>💾 Save Settings</span>';
            }
        });
    }

    if (btnTestQueueSync) {
        btnTestQueueSync.addEventListener('click', async () => {
            const sheetsUrl = googleSheetsUrlInput ? googleSheetsUrlInput.value.trim() : '';
            if (!sheetsUrl) {
                alert("Please enter a Google Sheets Webhook URL first!");
                return;
            }

            btnTestQueueSync.disabled = true;
            btnTestQueueSync.innerHTML = '<span>⚡ Testing...</span>';

            try {
                const res = await fetch('/api/queue/status');
                const qData = await res.json();
                const nextQ = qData.next_queue_number || 1;

                showStatusNotice(`⚡ Testing Live Queue Sync to Google Sheets (Queue #${nextQ})...`);
                
                const testPayload = {
                    date: new Date().toLocaleString(),
                    name: 'Test Queue Sync',
                    queue_number: nextQ,
                    queue_display: `Queue #${nextQ}`,
                    code: `Queue #${nextQ}`,
                    photos: 3,
                    filename: 'TEST_QUEUE_SYNC.png',
                    paid: 'TEST_PAID'
                };

                await fetch(sheetsUrl, {
                    method: 'POST',
                    mode: 'no-cors',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(testPayload)
                });

                alert(`✅ Test Live Queue ping sent to Google Sheets for Queue #${nextQ}! Check your Google Sheet.`);
                hideStatusNotice();
            } catch (err) {
                alert("Queue sync test notice: " + err.message);
                hideStatusNotice();
            } finally {
                btnTestQueueSync.disabled = false;
                btnTestQueueSync.innerHTML = '<span>⚡ Test Queue Sync</span>';
            }
        });
    }

    // --- INIT ---
    loadSystemConfig();
    initCameraDevices();
    loadTemplates();
    loadMusicPlaylist();
});
