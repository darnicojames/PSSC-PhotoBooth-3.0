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
    let currentAudioStream = null;
    let isMirrored = true;
    let selectedFilter = 'normal';
    let isSessionRunning = false;
    let activeCameraId = null;
    let activeMicId = localStorage.getItem('pssc_active_mic') || 'auto';

    // CAPTURED MEDIA STATE
    let capturedPhotos = [];
    let capturedRawPhotos = [];
    let liveSessionRecorder = null;
    let liveSessionChunks = [];

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
    const micSelect = document.getElementById('micSelect');
    const btnRequestMic = document.getElementById('btnRequestMic');
    const micStatusBadge = document.getElementById('micStatusBadge');
    const btnRefreshCameras = document.getElementById('btnRefreshCameras');
    const btnToggleMirror = document.getElementById('btnToggleMirror');
    const btnTestCamera = document.getElementById('btnTestCamera');
    const webcamVideo = document.getElementById('webcamVideo');
    const liveOverlayCanvas = document.getElementById('liveOverlayCanvas');
    const viewfinderWrapper = document.getElementById('viewfinderWrapper');
    const cameraStatusText = document.getElementById('cameraStatusText');
    const cameraStatusPill = document.getElementById('cameraStatusPill');
    const filterSelect = document.getElementById('filterSelect');
    
    const templateCardsGrid = document.getElementById('templateCardsGrid');
    const activeTemplateTitle = document.getElementById('activeTemplateTitle');
    const activeTemplateSpecs = document.getElementById('activeTemplateSpecs');
    const templateCountNum = document.getElementById('templateCountNum');
    const liveTicketCanvas = document.getElementById('liveTicketCanvas');

    const btnStartBooth = document.getElementById('btnStartBooth');
    const btnCancelBooth = document.getElementById('btnCancelBooth');
    const countdownSelect = document.getElementById('countdownSelect');
    const guestNameInput = document.getElementById('guestNameInput');
    const layoutSelect = document.getElementById('layoutSelect');
    const cornersSelect = document.getElementById('cornersSelect');
    const paidSelect = document.getElementById('paidSelect');
    const givenSelect = document.getElementById('givenSelect');
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
    const btnCopiesDec = document.getElementById('btnCopiesDec');
    const btnCopiesInc = document.getElementById('btnCopiesInc');
    const printCopiesVal = document.getElementById('printCopiesVal');
    const resultQrCodeImg = document.getElementById('resultQrCodeImg');
    const btnFinishAndNewSession = document.getElementById('btnFinishAndNewSession');
    let currentPrintCopies = 1;

    // --- TAB SWITCHING ---
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
            btn.classList.add('active');
            const tabId = btn.getAttribute('data-tab');
            document.getElementById(tabId).classList.add('active');
            logUserAction("Navigated Tab", tabId);

            if (tabId === 'tab-gallery') {
                loadGallery();
                if (typeof syncFromGoogleSheets === 'function') syncFromGoogleSheets(true);
            }
            if (tabId === 'tab-studio') {
                if (!templates || templates.length === 0) {
                    loadTemplates();
                } else {
                    renderTemplateCards();
                    if (activeTemplate) {
                        drawSlotOverlays();
                        renderLiveTicketCanvas([]);
                    }
                }
            }
            if (tabId === 'tab-settings') loadMusicPlaylist();
        });
    });

    // --- GLOBAL AUDIO VOLUMES (VOICE: 200% BOOSTED, MUSIC: 0%, SFX: 200% BOOSTED) ---
    let currentVoiceVolume = 2.0;
    let currentMusicVolume = 0.0;
    let currentSfxVolume = 2.0;

    if (localStorage.getItem('pssc_vol_voice') !== null) {
        currentVoiceVolume = Math.max(0, Math.min(2.0, parseFloat(localStorage.getItem('pssc_vol_voice')) || 2.0));
    }
    if (localStorage.getItem('pssc_vol_music') !== null) {
        currentMusicVolume = Math.max(0, Math.min(1, parseFloat(localStorage.getItem('pssc_vol_music')) || 0));
    }
    if (localStorage.getItem('pssc_vol_sfx') !== null) {
        const storedSfx = parseFloat(localStorage.getItem('pssc_vol_sfx'));
        if (!isNaN(storedSfx)) {
            currentSfxVolume = Math.max(0, Math.min(2.0, storedSfx));
        }
    }

    // --- AUDIO DUCKING ENGINE ---
    let isAudioDuckingActive = false;
    let duckingTimer = null;
    let duckingInterval = null;
    let activeVoiceCount = 0;

    // Lazy getter: bgMusicAudio is declared later in the file, so we resolve it at call time
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

        const userVol = typeof currentMusicVolume !== 'undefined' ? currentMusicVolume : 0.0;
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
    let activeVoiceInstance = null;
    let currentVoiceSource = null;
    let currentVoiceGainNode = null;

    // Stops only the current playing clip without touching voice count or ducking state.
    // Used internally when chaining voice guides so ducking stays held continuously.
    function stopCurrentAudio() {
        if (activeVoiceInstance) {
            const inst = activeVoiceInstance;
            activeVoiceInstance = null;
            inst.cancel();
        }
        if (currentAudio) {
            try {
                currentAudio.pause();
                currentAudio.currentTime = 0;
            } catch (e) {}
            currentAudio = null;
        }
        if (currentVoiceSource) {
            try {
                currentVoiceSource.disconnect();
            } catch (e) {}
            currentVoiceSource = null;
        }
        currentVoiceGainNode = null;
    }

    // Full reset: stops audio and releases ducking. Called on cancel or explicit stop.
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
        'welcome': [
            { file: 'welcome_wtm_superstars.mp3', title: "World Teachers' Month: Superstars Edition!" },
            { file: 'welcome_wtm_vips.mp3', title: "Make Way for Our VIP Teachers!" }
        ],
        // photo1 intentionally removed: no voice prompt for picture 1 (welcome serves as cue)
        'photo2': [
            { file: 'get_ready_2_wtm_highfashion.mp3', title: "Picture 2: High-Fashion Teacher Energy!" },
            { file: 'get_ready_2_wtm_incoming.mp3', title: "Picture 2 Incoming: Don't Hold Back!" },
            { file: 'switch_props_wtm_energy.mp3', title: "Main Character Energy! Swap Your Props!" }
        ],
        'photo3': [
            { file: 'get_ready_3_wtm_grandfinale.mp3', title: "Grand Finale: Ultimate Superstar Pose!" },
            { file: 'get_ready_3_wtm_bawalmahiyain.mp3', title: "Last Shot Alert: Bawal Mahiyain!" }
        ],
        'countdown': [
            { file: 'countdown.mp3', title: "3, 2, 1..." }
        ],
        'complete': [
            { file: 'complete_wtm_sensational.mp3', title: "Sensational! 100 Out of 10!" },
            { file: 'complete_wtm_perfection.mp3', title: "Perfection on Camera! Happy Teachers' Month!" }
        ],
        'cancelled': [
            { file: 'cancelled_wtm_nacut.mp3', title: "Ay, Na-Cut ang Show? Click Start Again!" },
            { file: 'cancelled_wtm_standard.mp3', title: "Session Cancelled" }
        ]
    };

    // Randomized Shuffle Decks per category (Fisher-Yates bag shuffle):
    // Guarantees thorough random distribution, ensures every clip in the category is heard
    // before any repeat, and avoids back-to-back duplicate playback between consecutive decks.
    const audioShuffleDecks = {};
    const lastPlayedAudioCategory = {};

    function shuffleAudioList(list) {
        const arr = [...list];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    function getNextAudioForCategory(categoryName) {
        const list = AUDIO_CATEGORIES[categoryName];
        if (!list || list.length === 0) return { file: categoryName, title: '' };

        // Refill and shuffle deck when empty
        if (!audioShuffleDecks[categoryName] || audioShuffleDecks[categoryName].length === 0) {
            let shuffled = shuffleAudioList(list);
            const last = lastPlayedAudioCategory[categoryName];
            if (last && shuffled.length > 1) {
                const lastFile = typeof last === 'string' ? last : last.file;
                const nextFile = typeof shuffled[shuffled.length - 1] === 'string' ? shuffled[shuffled.length - 1] : shuffled[shuffled.length - 1].file;
                if (nextFile === lastFile) {
                    const swapIdx = Math.floor(Math.random() * (shuffled.length - 1));
                    [shuffled[shuffled.length - 1], shuffled[swapIdx]] = [shuffled[swapIdx], shuffled[shuffled.length - 1]];
                }
            }
            audioShuffleDecks[categoryName] = shuffled;
        }

        const chosen = audioShuffleDecks[categoryName].pop();
        lastPlayedAudioCategory[categoryName] = chosen;

        if (typeof chosen === 'string') {
            return { file: chosen, title: '' };
        }
        return chosen;
    }

    function playAudioCategory(categoryName, forcePlay = false) {
        const item = getNextAudioForCategory(categoryName);
        if (item.title && categoryName !== 'countdown' && typeof showStatusNotice === 'function') {
            showStatusNotice(item.title);
        }
        return playAudio(item.file);
    }

    /**
     * Central audio utility function.
     * Manages HTML5 Audio clip playback from /audio/ directory.
     * Dynamic delay: Waits for the audio track 'ended' event so delay equals exact duration of the track.
     */
    function playAudio(filename) {
        // Stop previous clip without releasing the duck (keeps music at 20% between chained guides)
        stopCurrentAudio();

        const audioUrl = `/audio/${filename}?t=${Date.now()}`;

        return new Promise(resolve => {
            let isResolved = false;
            let safetyTimeoutId = null;
            let endedTimeoutId = null;
            let source = null;
            let gainNode = null;
            let audio = null;

            activeVoiceCount++;
            setBgMusicDucking(true);

            const cleanupAndResolve = (cancelled = false) => {
                if (isResolved) return;
                isResolved = true;

                if (safetyTimeoutId) {
                    clearTimeout(safetyTimeoutId);
                    safetyTimeoutId = null;
                }
                if (endedTimeoutId) {
                    clearTimeout(endedTimeoutId);
                    endedTimeoutId = null;
                }

                // Disconnect strictly THIS clip's Web Audio nodes
                const localAudio = audio;
                const localSource = source;
                const localGain = gainNode;

                if (source) {
                    try {
                        source.disconnect();
                    } catch (e) {}
                    source = null;
                }
                gainNode = null;

                if (audio) {
                    audio.onended = null;
                    audio.onerror = null;
                    audio.onloadedmetadata = null;
                    try {
                        audio.pause();
                        audio.currentTime = 0;
                    } catch (e) {}
                    audio = null;
                }

                if (activeVoiceInstance && activeVoiceInstance.name === filename) {
                    activeVoiceInstance = null;
                }
                if (currentAudio === localAudio) {
                    currentAudio = null;
                }
                if (currentVoiceSource === localSource) {
                    currentVoiceSource = null;
                }
                if (currentVoiceGainNode === localGain) {
                    currentVoiceGainNode = null;
                }

                activeVoiceCount = Math.max(0, activeVoiceCount - 1);
                if (activeVoiceCount === 0) {
                    setBgMusicDucking(false);
                }
                resolve();
            };

            try {
                audio = new Audio();
                audio.src = audioUrl;
                currentAudio = audio;

                // Routing through Web Audio API to support volume and boost up to 200%
                try {
                    const ctx = getAudioCtx();
                    if (ctx.state === 'suspended') {
                        ctx.resume().catch(() => {});
                    }
                    source = ctx.createMediaElementSource(audio);
                    gainNode = ctx.createGain();
                    gainNode.gain.value = currentVoiceVolume;
                    source.connect(gainNode);
                    gainNode.connect(getMasterOutputNode(ctx));
                    currentVoiceSource = source;
                    currentVoiceGainNode = gainNode;
                    audio.volume = 1.0;
                } catch (webaudioErr) {
                    audio.volume = Math.max(0, Math.min(1.0, currentVoiceVolume / 2.0));
                }

                activeVoiceInstance = {
                    name: filename,
                    audio,
                    source,
                    gainNode,
                    cancel: () => cleanupAndResolve(true)
                };

                // 1. Primary Completion Trigger: Wait for full 'ended' event from HTML5 audio
                audio.addEventListener('ended', () => {
                    // 200ms tail cushion so final reverb of the clip plays completely
                    endedTimeoutId = setTimeout(() => cleanupAndResolve(false), 200);
                    if (endedTimeoutId) activeTimers.push(endedTimeoutId);
                }, { once: true });

                audio.addEventListener('error', (err) => {
                    console.warn(`Audio ${filename} missing or unplayable:`, err);
                    cleanupAndResolve(false);
                }, { once: true });

                // 2. Safety Timeout: Only fires if audio hangs or fails to emit ended (duration + 1.5s)
                audio.addEventListener('loadedmetadata', () => {
                    const audioDuration = audio.duration && !isNaN(audio.duration) && Number.isFinite(audio.duration) ? audio.duration : 3.0;
                    safetyTimeoutId = setTimeout(() => cleanupAndResolve(false), (audioDuration + 1.5) * 1000);
                    if (safetyTimeoutId) activeTimers.push(safetyTimeoutId);
                }, { once: true });

                audio.play().catch(err => {
                    console.warn(`Audio auto-play note for ${filename}:`, err);
                    cleanupAndResolve(false);
                });

            } catch (err) {
                console.error(`Failed to play ${filename}:`, err);
                cleanupAndResolve(false);
            }
        });
    }

    // --- WEB AUDIO SYNTHESIZERS (FALLBACK / EFFECTS) ---
    let audioCtx = null;
    let audioMasterLimiter = null;
    function getAudioCtx() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        return audioCtx;
    }

    function getMasterOutputNode(ctx) {
        if (!audioMasterLimiter || audioMasterLimiter.context !== ctx) {
            try {
                const comp = ctx.createDynamicsCompressor();
                comp.threshold.setValueAtTime(-1.0, ctx.currentTime);
                comp.knee.setValueAtTime(4, ctx.currentTime);
                comp.ratio.setValueAtTime(14, ctx.currentTime);
                comp.attack.setValueAtTime(0.002, ctx.currentTime);
                comp.release.setValueAtTime(0.20, ctx.currentTime);
                comp.connect(ctx.destination);
                audioMasterLimiter = comp;
            } catch (e) {
                return ctx.destination;
            }
        }
        return audioMasterLimiter || ctx.destination;
    }

    function playBeepSound(freq = 880, duration = 0.12) {
        if (currentSfxVolume <= 0) return;
        try {
            const ctx = getAudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.30 * currentSfxVolume, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(getMasterOutputNode(ctx));
            osc.start();
            osc.stop(ctx.currentTime + duration);
        } catch (e) {}
    }

    function playShutterSound() {
        const vol = typeof currentSfxVolume !== 'undefined' ? currentSfxVolume : 2.0;
        if (vol <= 0) return;
        try {
            const ctx = getAudioCtx();
            if (ctx.state === 'suspended') ctx.resume();

            // Shutter Stage 1: Mirror flip / shutter open
            const buffer1 = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
            const data1 = buffer1.getChannelData(0);
            for (let i = 0; i < data1.length; i++) data1[i] = Math.random() * 2 - 1;
            const noise1 = ctx.createBufferSource();
            noise1.buffer = buffer1;
            const filter1 = ctx.createBiquadFilter();
            filter1.type = 'bandpass';
            filter1.frequency.value = 1600;
            const gain1 = ctx.createGain();
            gain1.gain.setValueAtTime(0.55 * vol, ctx.currentTime);
            gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.045);
            noise1.connect(filter1);
            filter1.connect(gain1);
            gain1.connect(getMasterOutputNode(ctx));
            noise1.start(ctx.currentTime);

            // Shutter Stage 2: Curtain snap close at +60ms
            const buffer2 = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.08), ctx.sampleRate);
            const data2 = buffer2.getChannelData(0);
            for (let i = 0; i < data2.length; i++) data2[i] = Math.random() * 2 - 1;
            const noise2 = ctx.createBufferSource();
            noise2.buffer = buffer2;
            const filter2 = ctx.createBiquadFilter();
            filter2.type = 'highpass';
            filter2.frequency.value = 1200;
            const gain2 = ctx.createGain();
            gain2.gain.setValueAtTime(0.65 * vol, ctx.currentTime + 0.06);
            gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.13);
            noise2.connect(filter2);
            filter2.connect(gain2);
            gain2.connect(getMasterOutputNode(ctx));
            noise2.start(ctx.currentTime + 0.06);
        } catch (e) {
            console.warn("Shutter sound error:", e);
        }
    }

    function playCelebrationFanfare() {
        if (currentSfxVolume <= 0) return;
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
                gain.gain.setValueAtTime(0.40 * currentSfxVolume, startTime);
                gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
                osc.connect(gain);
                gain.connect(getMasterOutputNode(ctx));
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
        const layoutText = layoutSelect ? (layoutSelect.value === 'double' ? '2 Strips (Double)' : '1 Strip (Single)') : '2 Strips (Double)';
        const delayText = countdownSelect ? `${countdownSelect.value}s Delay` : '3s Delay';
        const guestText = guestNameInput && guestNameInput.value.trim() ? guestNameInput.value.trim() : 'Guest';

        broadcastSync('STATE_SYNC', {
            deviceId: activeCameraId,
            isMirrored,
            filter: selectedFilter || 'normal',
            templateName: activeTemplate ? activeTemplate.name : 'Classic 3-Cut Strip',
            layout: layoutText,
            delay: delayText,
            guest: guestText,
            corners: cornersSelect ? cornersSelect.value : 'sharp',
            aspectRatio: (viewfinderWrapper && viewfinderWrapper.style.aspectRatio) ? viewfinderWrapper.style.aspectRatio : null,
            template: activeTemplate ? {
                id: activeTemplate.id,
                name: activeTemplate.name,
                width: activeTemplate.width,
                height: activeTemplate.height,
                slots: activeTemplate.slots,
                preview_url: activeTemplate.preview_url
            } : null
        });

        if (viewfinderWrapper && viewfinderWrapper.style.aspectRatio) {
            broadcastSync('ASPECT_RATIO_CHANGE', {
                aspectRatio: viewfinderWrapper.style.aspectRatio
            });
        }

        if (liveTicketCanvas && liveTicketCanvas.width > 0) {
            try {
                broadcastSync('TICKET_RENDER', {
                    dataUrl: liveTicketCanvas.toDataURL('image/jpeg', 0.85),
                    templateName: activeTemplate ? activeTemplate.name : '',
                    specs: activeTemplate ? `${activeTemplate.width} × ${activeTemplate.height} · ${activeTemplate.slots ? activeTemplate.slots.length : 0} Slots` : ''
                });
            } catch (e) {}
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

    // --- CAMERA ENGINE & HARDWARE OPTIMIZER ---
    let isCameraConnecting = false;

    function updateCameraStatusUI(state, message) {
        const emptyState = document.getElementById('cameraEmptyState');
        if (emptyState) {
            emptyState.classList.toggle('hidden', state === 'active');
            document.getElementById('cameraEmptyTitle').textContent = message;
            document.getElementById('cameraEmptyDescription').textContent = state === 'loading'
                ? 'Allow camera access when prompted. You can choose a device in settings.'
                : 'Check the camera connection and browser permission, then refresh devices in settings.';
        }
        if (cameraStatusText) {
            cameraStatusText.textContent = message;
        }
        if (cameraStatusPill) {
            const dot = cameraStatusPill.querySelector('.dot');
            if (dot) {
                dot.className = 'dot';
                if (state === 'active') {
                    dot.classList.add('pulse');
                    dot.style.background = 'var(--g, #00e676)';
                    dot.style.boxShadow = '0 0 8px rgba(0,230,118,0.7)';
                } else if (state === 'loading') {
                    dot.style.background = '#ffb300';
                    dot.style.boxShadow = '0 0 8px rgba(255,179,0,0.7)';
                } else {
                    dot.style.background = '#ff4d4d';
                    dot.style.boxShadow = '0 0 8px rgba(255,77,77,0.7)';
                }
            }
        }
    }

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
        window.currentVideoStream = null;
        if (webcamVideo) {
            webcamVideo.srcObject = null;
        }
        updateCameraStatusUI('off', "Camera Disconnected / Off");
    }

    async function initCameraDevices(isRefresh = false) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            const isSecure = window.isSecureContext !== false;
            updateCameraStatusUI('error', isSecure 
                ? "Media Devices Not Supported" 
                : "Camera blocked: HTTPS or localhost required");
            return;
        }

        updateCameraStatusUI('loading', isRefresh ? "Refreshing Cameras..." : "Scanning Cameras...");

        try {
            const savedCameraId = localStorage.getItem('pssc_active_camera');
            const targetDeviceId = (savedCameraId && savedCameraId !== 'off') ? savedCameraId : null;

            let activeInitialStream = null;

            // If no stream is currently running, request access once to get permissions & initial feed.
            // Pass targetDeviceId as ideal so browser connects directly to user's camera without device-churn!
            if (!currentVideoStream || !currentVideoStream.active) {
                const initialConstraints = targetDeviceId 
                    ? { video: { deviceId: { ideal: targetDeviceId }, width: { ideal: 1920, min: 1280 }, height: { ideal: 1080, min: 720 }, frameRate: { ideal: 30, max: 30 } }, audio: false }
                    : { video: { width: { ideal: 1920, min: 1280 }, height: { ideal: 1080, min: 720 }, frameRate: { ideal: 30, max: 30 } }, audio: false };

                try {
                    activeInitialStream = await navigator.mediaDevices.getUserMedia(initialConstraints);
                } catch (permErr) {
                    console.warn("Initial camera request with ideal constraints failed, falling back to basic video:", permErr);
                    try {
                        activeInitialStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    } catch (permErr2) {
                        console.error("Camera permission denied or unavailable:", permErr2);
                        const msg = permErr2.name === 'NotAllowedError' 
                            ? "Permission Denied (Allow camera in browser)" 
                            : (permErr2.name === 'NotReadableError' 
                                ? "Camera In Use by another app (Close Zoom/OBS)" 
                                : "No Camera Available");
                        updateCameraStatusUI('error', msg);
                        return;
                    }
                }
            }

            // Enumerate devices now that permission is definitely granted
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');

            if (cameraSelect) {
                cameraSelect.innerHTML = '';

                // Option to turn camera OFF / Disconnect immediately
                const offOpt = document.createElement('option');
                offOpt.value = 'off';
                offOpt.textContent = 'Camera Off / Disconnected';
                cameraSelect.appendChild(offOpt);

                if (videoDevices.length === 0) {
                    updateCameraStatusUI('error', "No Camera Found");
                    stopCameraStream();
                    return;
                }

                videoDevices.forEach((device, idx) => {
                    const opt = document.createElement('option');
                    opt.value = device.deviceId;
                    opt.textContent = device.label || `Camera ${idx + 1}`;
                    cameraSelect.appendChild(opt);
                });
            }

            // If activeInitialStream was acquired, identify which device it matches
            if (activeInitialStream && activeInitialStream.active) {
                const initialTrack = activeInitialStream.getVideoTracks()[0];
                const trackSettings = initialTrack ? (initialTrack.getSettings ? initialTrack.getSettings() : {}) : {};
                
                // Find matching device by deviceId or label
                const matchedDevice = videoDevices.find(d => 
                    (trackSettings.deviceId && d.deviceId === trackSettings.deviceId) ||
                    (initialTrack && initialTrack.label && d.label && d.label === initialTrack.label)
                );

                const detectedDeviceId = matchedDevice ? matchedDevice.deviceId : (videoDevices[0] ? videoDevices[0].deviceId : null);

                // If stream matches target preference, or no specific target was requested, or only 1 camera exists:
                // USE THIS STREAM DIRECTLY without stopping and restarting hardware!
                if (!targetDeviceId || targetDeviceId === detectedDeviceId || videoDevices.length <= 1) {
                    currentVideoStream = activeInitialStream;
                    window.currentVideoStream = currentVideoStream;
                    activeCameraId = detectedDeviceId || (videoDevices[0] ? videoDevices[0].deviceId : null);
                    if (activeCameraId) {
                        localStorage.setItem('pssc_active_camera', activeCameraId);
                        if (cameraSelect) cameraSelect.value = activeCameraId;
                    }

                    webcamVideo.srcObject = activeInitialStream;
                    webcamVideo.muted = true;
                    webcamVideo.playsInline = true;
                    webcamVideo.setAttribute('playsinline', '');
                    webcamVideo.setAttribute('muted', '');

                    const onVideoReady = () => {
                        resizeOverlayCanvas();
                        drawSlotOverlays();
                        const w = webcamVideo.videoWidth;
                        const h = webcamVideo.videoHeight;
                        const res = (w && h) ? `${w}x${h}` : 'Live';
                        updateCameraStatusUI('active', `Live (${res})`);
                    };

                    webcamVideo.onloadedmetadata = onVideoReady;
                    webcamVideo.onplaying = onVideoReady;
                    if (webcamVideo.readyState >= 1) {
                        onVideoReady();
                    }

                    try { await webcamVideo.play(); } catch (e) {}

                    if (initialTrack) {
                        initialTrack.onended = () => {
                            console.warn("Active camera track disconnected.");
                            updateCameraStatusUI('error', "Camera Disconnected");
                        };
                    }

                    updateCameraStatusUI('active', "Live Stream Active");
                    broadcastSync('STREAM_UPDATED', { deviceId: activeCameraId });
                    broadcastSync('DEVICE_CHANGE', { deviceId: activeCameraId });
                    broadcastStreamToPeer();
                    return;
                } else {
                    // Different camera requested by user, stop initial stream with a driver release cushion
                    activeInitialStream.getTracks().forEach(t => t.stop());
                    await new Promise(r => setTimeout(r, 350));
                }
            }

            // Target camera explicitly
            const finalDeviceId = targetDeviceId || (videoDevices[0] ? videoDevices[0].deviceId : null);
            if (finalDeviceId && finalDeviceId !== 'off') {
                activeCameraId = finalDeviceId;
                localStorage.setItem('pssc_active_camera', activeCameraId);
                if (cameraSelect) cameraSelect.value = activeCameraId;
                await startWebcamStream(activeCameraId);
            }

        } catch (err) {
            console.error("Camera Init Error:", err);
            updateCameraStatusUI('error', "Camera Error: " + (err.message || "Failed to initialize"));
        }
    }

    async function startWebcamStream(deviceId) {
        if (isCameraConnecting) return;
        isCameraConnecting = true;

        try {
            stopCameraStream();

            if (!deviceId || deviceId === 'off') {
                return;
            }

            updateCameraStatusUI('loading', "Connecting Camera...");

            // 350ms driver cushion to guarantee Windows DirectShow / MediaFoundation releases handle cleanly
            await new Promise(r => setTimeout(r, 350));

            const constraintTiers = [
                // Tier 1: Crisp Full HD (1080p @ 30fps) - Hardware accelerated, sharp, crystal clear, near-zero CPU
                {
                    video: {
                        deviceId: { exact: deviceId },
                        width: { ideal: 1920, min: 1280 },
                        height: { ideal: 1080, min: 720 },
                        frameRate: { ideal: 30, max: 30 }
                    },
                    audio: false
                },
                // Tier 2: HD (720p @ 30fps) - Ultra-smooth fallback
                {
                    video: {
                        deviceId: { exact: deviceId },
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        frameRate: { ideal: 30, max: 30 }
                    },
                    audio: false
                },
                // Tier 3: Target camera exact unconstrained with 30fps cap
                {
                    video: {
                        deviceId: { exact: deviceId },
                        frameRate: { ideal: 30, max: 30 }
                    },
                    audio: false
                },
                // Tier 4: Target camera ideal fallback (if exact ID hash shifted on Windows reconnect)
                {
                    video: {
                        deviceId: { ideal: deviceId },
                        width: { ideal: 1920 },
                        height: { ideal: 1080 },
                        frameRate: { ideal: 30, max: 30 }
                    },
                    audio: false
                },
                // Tier 5: Universal default video fallback
                {
                    video: {
                        frameRate: { ideal: 30, max: 30 }
                    },
                    audio: false
                }
            ];

            let stream = null;
            let lastError = null;

            for (let i = 0; i < constraintTiers.length; i++) {
                try {
                    stream = await navigator.mediaDevices.getUserMedia(constraintTiers[i]);
                    if (stream && stream.active) {
                        break;
                    }
                } catch (err) {
                    lastError = err;
                    console.warn(`Camera Tier ${i + 1} failed:`, err.name, err.message);
                    // If driver is releasing on Windows COM, wait 350ms before trying next tier
                    const waitTime = err.name === 'NotReadableError' ? 350 : 100;
                    await new Promise(r => setTimeout(r, waitTime));
                }
            }

            if (stream && stream.active) {
                currentVideoStream = stream;
                window.currentVideoStream = currentVideoStream;
                activeCameraId = deviceId;
                localStorage.setItem('pssc_active_camera', activeCameraId);
                if (cameraSelect) cameraSelect.value = activeCameraId;

                webcamVideo.srcObject = stream;
                webcamVideo.muted = true;
                webcamVideo.playsInline = true;
                webcamVideo.setAttribute('playsinline', '');
                webcamVideo.setAttribute('muted', '');

                const onVideoReady = () => {
                    resizeOverlayCanvas();
                    drawSlotOverlays();
                    const w = webcamVideo.videoWidth;
                    const h = webcamVideo.videoHeight;
                    const res = (w && h) ? `${w}x${h}` : 'Live';
                    updateCameraStatusUI('active', `Live (${res})`);
                    webcamVideo.style.visibility = '';
                    if (liveOverlayCanvas) liveOverlayCanvas.style.visibility = '';
                    if (cameraEmptyState) cameraEmptyState.classList.add('hidden');
                };

                webcamVideo.onloadedmetadata = onVideoReady;
                webcamVideo.onplaying = onVideoReady;
                if (webcamVideo.readyState >= 1) {
                    onVideoReady();
                }

                try { await webcamVideo.play(); } catch (e) {}

                const track = stream.getVideoTracks()[0];
                if (track) {
                    track.onended = () => {
                        console.warn("Camera track disconnected.");
                        updateCameraStatusUI('error', "Camera Disconnected");
                    };
                }

                updateCameraStatusUI('active', "Live Stream Active");
                broadcastSync('STREAM_UPDATED', { deviceId: activeCameraId });
                broadcastSync('DEVICE_CHANGE', { deviceId: activeCameraId });
                broadcastStreamToPeer();
            } else {
                console.error("All camera stream attempts failed:", lastError);
                const errName = lastError ? lastError.name : 'Unknown';
                const userMsg = errName === 'NotAllowedError'
                    ? "Permission Denied (Allow camera in browser)"
                    : (errName === 'NotReadableError'
                        ? "Camera In Use (Close Zoom/OBS/Teams)"
                        : "Error Accessing Camera");
                updateCameraStatusUI('error', userMsg);
            }
        } catch (unexpected) {
            console.error("Unexpected camera connection error:", unexpected);
            updateCameraStatusUI('error', "Camera Error: " + (unexpected.message || "Failed"));
        } finally {
            isCameraConnecting = false;
        }
    }

    async function refreshCameraDevices() {
        if (btnRefreshCameras) {
            btnRefreshCameras.disabled = true;
            btnRefreshCameras.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right:4px;" class="spin-icon"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> <span>Resetting...</span>';
        }

        stopCameraStream();
        updateCameraStatusUI('loading', "Resetting Hardware...");

        // 350ms driver cushion to guarantee complete release
        await new Promise(r => setTimeout(r, 350));

        await initCameraDevices(true);

        if (btnRefreshCameras) {
            btnRefreshCameras.disabled = false;
            btnRefreshCameras.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right:4px;"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> <span>Refresh</span>';
        }
    }

    // Auto-detect plugged / unplugged USB camera hardware
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', () => {
            console.log("Hardware devicechange detected, updating camera list...");
            initCameraDevices(true);
        });
    }

    if (btnRefreshCameras) {
        btnRefreshCameras.addEventListener('click', () => {
            refreshCameraDevices();
        });
    }

    cameraSelect.addEventListener('change', (e) => {
        activeCameraId = e.target.value;
        localStorage.setItem('pssc_active_camera', activeCameraId);
        broadcastSync('DEVICE_CHANGE', { deviceId: activeCameraId });
        if (activeCameraId === 'off') {
            stopCameraStream();
        } else {
            startWebcamStream(activeCameraId);
        }
    });

    // --- MICROPHONE CAPTURE & AUDIO STREAM MANAGEMENT ---
    function updateMicStatusUI(status, text) {
        if (!micStatusBadge) return;
        micStatusBadge.textContent = text;
        if (status === 'active') {
            micStatusBadge.style.background = 'rgba(34,197,94,0.15)';
            micStatusBadge.style.color = '#4ade80';
            micStatusBadge.style.borderColor = 'rgba(34,197,94,0.3)';
        } else if (status === 'muted') {
            micStatusBadge.textContent = 'Muted';
            micStatusBadge.style.background = 'rgba(148,163,184,0.15)';
            micStatusBadge.style.color = '#94a3b8';
            micStatusBadge.style.borderColor = 'rgba(148,163,184,0.3)';
        } else if (status === 'error') {
            micStatusBadge.style.background = 'rgba(239,68,68,0.15)';
            micStatusBadge.style.color = '#f87171';
            micStatusBadge.style.borderColor = 'rgba(239,68,68,0.3)';
        } else {
            micStatusBadge.style.background = 'rgba(234,179,8,0.15)';
            micStatusBadge.style.color = '#facc15';
            micStatusBadge.style.borderColor = 'rgba(234,179,8,0.3)';
        }
    }

    async function populateMicrophoneList() {
        if (!micSelect || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioDevices = devices.filter(d => d.kind === 'audioinput');

            const currentVal = micSelect.value || localStorage.getItem('pssc_active_mic') || 'auto';
            micSelect.innerHTML = '';

            const autoOpt = document.createElement('option');
            autoOpt.value = 'auto';
            autoOpt.textContent = 'Auto / Camera Mic (Default)';
            micSelect.appendChild(autoOpt);

            audioDevices.forEach((dev, idx) => {
                const opt = document.createElement('option');
                opt.value = dev.deviceId;
                opt.textContent = dev.label || `Microphone ${idx + 1}`;
                micSelect.appendChild(opt);
            });

            const noneOpt = document.createElement('option');
            noneOpt.value = 'none';
            noneOpt.textContent = 'Mute / No Audio';
            micSelect.appendChild(noneOpt);

            if (Array.from(micSelect.options).some(o => o.value === currentVal)) {
                micSelect.value = currentVal;
            } else {
                micSelect.value = 'auto';
            }
        } catch (err) {
            console.warn("Could not enumerate audio devices:", err);
        }
    }

    async function initMicrophoneStream(preferredDeviceId = null) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            updateMicStatusUI('error', 'Not Supported');
            return null;
        }

        const targetId = preferredDeviceId !== null ? preferredDeviceId : (micSelect ? micSelect.value : 'auto');

        if (targetId === 'none') {
            if (currentAudioStream) {
                currentAudioStream.getTracks().forEach(t => t.stop());
                currentAudioStream = null;
            }
            updateMicStatusUI('muted', 'Muted');
            localStorage.setItem('pssc_active_mic', 'none');
            return null;
        }

        try {
            if (currentAudioStream) {
                currentAudioStream.getTracks().forEach(t => t.stop());
                currentAudioStream = null;
            }

            const audioConstraints = {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                googEchoCancellation: false,
                googAutoGainControl: false,
                googNoiseSuppression: false,
                googHighpassFilter: false
            };

            if (targetId && targetId !== 'auto') {
                audioConstraints.deviceId = { exact: targetId };
            }

            currentAudioStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

            // Re-enumerate devices now that permission is granted so device labels appear
            await populateMicrophoneList();
            if (targetId && micSelect && Array.from(micSelect.options).some(o => o.value === targetId)) {
                micSelect.value = targetId;
            }

            const liveTrack = currentAudioStream.getAudioTracks()[0];
            const trackName = (liveTrack && liveTrack.label) ? liveTrack.label : 'Active';
            console.log("Microphone stream initialized successfully:", trackName);
            updateMicStatusUI('active', 'Mic Ready');
            localStorage.setItem('pssc_active_mic', targetId);
            return currentAudioStream;
        } catch (err) {
            console.warn("Microphone stream initialization notice:", err);
            if (err.name === 'NotAllowedError') {
                updateMicStatusUI('error', 'Mic Blocked');
            } else if (err.name === 'NotFoundError') {
                updateMicStatusUI('error', 'No Mic Found');
            } else {
                updateMicStatusUI('error', 'Mic Unavailable');
            }
            currentAudioStream = null;
            return null;
        }
    }

    if (btnRequestMic) {
        btnRequestMic.addEventListener('click', async () => {
            updateMicStatusUI('loading', 'Requesting...');
            btnRequestMic.disabled = true;
            try {
                const stream = await initMicrophoneStream();
                if (stream) {
                    btnRequestMic.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Enabled';
                }
            } finally {
                btnRequestMic.disabled = false;
            }
        });
    }

    if (micSelect) {
        micSelect.addEventListener('change', async (e) => {
            const selectedVal = e.target.value;
            localStorage.setItem('pssc_active_mic', selectedVal);
            if (selectedVal === 'none') {
                if (currentAudioStream) {
                    currentAudioStream.getTracks().forEach(t => t.stop());
                    currentAudioStream = null;
                }
                updateMicStatusUI('muted', 'Muted');
            } else {
                await initMicrophoneStream(selectedVal);
            }
        });
    }

    async function initMicrophonePermissionCheck() {
        await populateMicrophoneList();
        if (navigator.permissions && navigator.permissions.query) {
            try {
                const permStatus = await navigator.permissions.query({ name: 'microphone' });
                const handlePerm = (state) => {
                    if (state === 'granted') {
                        const saved = localStorage.getItem('pssc_active_mic') || 'auto';
                        if (saved !== 'none') {
                            initMicrophoneStream(saved);
                        } else {
                            updateMicStatusUI('muted', 'Muted');
                        }
                    } else if (state === 'denied') {
                        updateMicStatusUI('error', 'Mic Blocked');
                    } else {
                        updateMicStatusUI('prompt', 'Click Enable');
                    }
                };
                handlePerm(permStatus.state);
                permStatus.onchange = () => handlePerm(permStatus.state);
            } catch (_) {
                populateMicrophoneList();
            }
        }
    }

    const SVG_MIRROR = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><polyline points="8 3 4 7 8 11"/><polyline points="4 7 20 7 20 11"/><polyline points="16 21 20 17 16 13"/><polyline points="20 17 4 17 4 13"/></svg>';

    btnToggleMirror.addEventListener('click', () => {
        isMirrored = !isMirrored;
        broadcastSync('MIRROR_CHANGE', { isMirrored });
        if (isMirrored) {
            webcamVideo.classList.remove('unmirrored');
            btnToggleMirror.innerHTML = `${SVG_MIRROR} <span>Mirror: ON</span>`;
        } else {
            webcamVideo.classList.add('unmirrored');
            btnToggleMirror.innerHTML = `${SVG_MIRROR} <span>Mirror: OFF</span>`;
        }
    });

    btnTestCamera.addEventListener('click', () => {
        triggerFlash();
        const vTrack = currentVideoStream ? currentVideoStream.getVideoTracks()[0] : null;
        const trackSettings = vTrack ? (vTrack.getSettings ? vTrack.getSettings() : {}) : {};
        const diagMsg = `Camera Diagnostic:
• Stream Active: ${currentVideoStream && currentVideoStream.active ? 'Yes' : 'No'}
• Track Label: ${vTrack ? vTrack.label : 'None'}
• Resolution: ${webcamVideo.videoWidth || trackSettings.width || 0} x ${webcamVideo.videoHeight || trackSettings.height || 0}
• Ready State: ${webcamVideo.readyState} (4=HAVE_ENOUGH_DATA)
• Frame Rate: ${trackSettings.frameRate || 'Auto'} fps`;
        alert(diagMsg);
    });

    // --- POPOUT & FULLSCREEN VIEWFINDER CONTROLLERS ---
    const btnPopoutViewfinder = document.getElementById('btnPopoutViewfinder');
    const btnFullscreenViewfinder = document.getElementById('btnFullscreenViewfinder');
    const btnReturnViewfinder = document.getElementById('btnReturnViewfinder');
    const viewfinderPoppedOutPlaceholder = document.getElementById('viewfinderPoppedOutPlaceholder');

    let isViewfinderPoppedOut = false;
    let popoutWindowRef = null;
    let guestHeartbeatTimeout = null;

    const SVG_EXTERNAL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right:4px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

    function resetGuestHeartbeatTimeout() {
        if (guestHeartbeatTimeout) clearTimeout(guestHeartbeatTimeout);
        guestHeartbeatTimeout = setTimeout(() => {
            // Heartbeat stopped (guest screen was closed or navigated away)
            if (!popoutWindowRef || popoutWindowRef.closed) {
                setPopoutActive(false);
            }
        }, 3200);
    }

    function setPopoutActive(active) {
        const nextState = !!active;
        if (isViewfinderPoppedOut === nextState) {
            if (nextState) resetGuestHeartbeatTimeout();
            return;
        }
        isViewfinderPoppedOut = nextState;

        if (isViewfinderPoppedOut) {
            // Keep main camera preview video running smoothly alongside guest display
            if (webcamVideo) {
                webcamVideo.style.visibility = '';
                if (webcamVideo.paused && currentVideoStream && currentVideoStream.active) {
                    webcamVideo.play().catch(() => {});
                }
            }
            if (liveOverlayCanvas) {
                liveOverlayCanvas.style.visibility = '';
            }
            if (viewfinderPoppedOutPlaceholder) {
                viewfinderPoppedOutPlaceholder.classList.add('hidden');
            }
            if (cameraEmptyState) {
                cameraEmptyState.classList.add('hidden');
            }

            // Highlight Guest Screen header button
            if (btnPopoutViewfinder) {
                btnPopoutViewfinder.innerHTML = `${SVG_EXTERNAL} <span>Guest Screen: Open</span>`;
                btnPopoutViewfinder.title = "Guest Screen is active (Click to bring to front)";
                btnPopoutViewfinder.classList.add('active-popout-btn');
            }

            // Ensure underlying stream is active so guest screen & captures receive feed
            if (!currentVideoStream || !currentVideoStream.active) {
                startWebcamStream(activeCameraId);
            }
            resetGuestHeartbeatTimeout();
            logUserAction("Guest Screen Active", "Dual-screen live mirroring active");
        } else {
            // Hide placeholder if any
            if (viewfinderPoppedOutPlaceholder) {
                viewfinderPoppedOutPlaceholder.classList.add('hidden');
            }
            // Bring back main camera preview video and overlay
            if (webcamVideo) {
                webcamVideo.style.visibility = '';
                if (webcamVideo.paused && currentVideoStream && currentVideoStream.active) {
                    webcamVideo.play().catch(() => {});
                }
            }
            if (liveOverlayCanvas) {
                liveOverlayCanvas.style.visibility = '';
            }
            if (cameraEmptyState && (!currentVideoStream || !currentVideoStream.active)) {
                cameraEmptyState.classList.remove('hidden');
            }
            document.querySelectorAll('.vf-corner').forEach(el => el.classList.remove('hidden'));

            // Reset button
            if (btnPopoutViewfinder) {
                btnPopoutViewfinder.innerHTML = `${SVG_EXTERNAL} <span>Guest Screen</span>`;
                btnPopoutViewfinder.title = "Open Guest Screen (/guest)";
                btnPopoutViewfinder.classList.remove('active-popout-btn');
            }

            if (guestHeartbeatTimeout) {
                clearTimeout(guestHeartbeatTimeout);
                guestHeartbeatTimeout = null;
            }

            if (!currentVideoStream || !currentVideoStream.active) {
                startWebcamStream(activeCameraId);
            }
            logUserAction("Guest Screen Closed", "Restored main camera preview on main page");
        }
    }

    if (btnPopoutViewfinder) {
        btnPopoutViewfinder.addEventListener('click', () => {
            if (!isViewfinderPoppedOut || !popoutWindowRef || popoutWindowRef.closed) {
                popoutWindowRef = window.open('/guest', 'PSSC_Guest_Viewfinder', 'width=1280,height=800,menubar=no,toolbar=no,location=no');
                setPopoutActive(true);
            } else {
                popoutWindowRef.focus();
            }
        });
    }

    if (btnReturnViewfinder) {
        btnReturnViewfinder.addEventListener('click', () => {
            if (popoutWindowRef && !popoutWindowRef.closed) {
                try { popoutWindowRef.close(); } catch (e) {}
            }
            broadcastSync('CLOSE_GUEST_SCREEN');
            setPopoutActive(false);
        });
    }

    // Window closed polling fallback
    setInterval(() => {
        if (isViewfinderPoppedOut && popoutWindowRef && popoutWindowRef.closed) {
            if (!guestHeartbeatTimeout) {
                setPopoutActive(false);
            }
        }
    }, 400);

    // Broadcast option adjustments live to guest HUD
    if (guestNameInput) {
        guestNameInput.addEventListener('input', () => {
            const guest = guestNameInput.value.trim() || 'Guest';
            broadcastSync('GUEST_CHANGE', { guest });
        });
    }

    if (layoutSelect) {
        layoutSelect.addEventListener('change', () => {
            const layout = layoutSelect.value === 'double' ? '2 Strips (Double)' : '1 Strip (Single)';
            broadcastSync('LAYOUT_CHANGE', { layout, raw: layoutSelect.value });
        });
    }

    if (countdownSelect) {
        countdownSelect.addEventListener('change', () => {
            const delay = `${countdownSelect.value}s Delay`;
            broadcastSync('DELAY_CHANGE', { delay, seconds: countdownSelect.value });
        });
    }

    if (cornersSelect) {
        const savedCorners = localStorage.getItem('pssc_corners_style');
        if (savedCorners) cornersSelect.value = savedCorners;
        cornersSelect.addEventListener('change', () => {
            localStorage.setItem('pssc_corners_style', cornersSelect.value);
            broadcastSync('CORNERS_CHANGE', { corners: cornersSelect.value });
            renderLiveTicket();
        });
    }

    // --- LOCAL WEBRTC STREAM BROADCASTER (FOR DUAL-TAB / DUAL-MONITOR GUEST VIEWFINDER) ---
    let rtcBroadcasterPc = null;
    let isBroadcasterNegotiating = false;
    let lastOfferTimestamp = 0;

    async function broadcastStreamToPeer() {
        if (!currentVideoStream || !currentVideoStream.active) return;
        // If guest popout is open in the same browser, it accesses the stream directly via window.opener with 0% CPU!
        if (popoutWindowRef && !popoutWindowRef.closed) {
            return;
        }
        const now = Date.now();
        if (now - lastOfferTimestamp < 1200 || isBroadcasterNegotiating) return;
        lastOfferTimestamp = now;
        isBroadcasterNegotiating = true;
        try {
            if (rtcBroadcasterPc) {
                try { rtcBroadcasterPc.close(); } catch (e) {}
                rtcBroadcasterPc = null;
            }

            const pc = new RTCPeerConnection({ iceServers: [] });
            rtcBroadcasterPc = pc;

            currentVideoStream.getTracks().forEach(track => {
                try {
                    const sender = pc.addTrack(track, currentVideoStream);
                    if (track.kind === 'video' && sender) {
                        try {
                            const params = sender.getParameters();
                            if (!params.encodings || params.encodings.length === 0) {
                                params.encodings = [{}];
                            }
                            params.encodings[0].maxBitrate = 4000000; // 4 Mbps high definition 1080p stream
                            params.encodings[0].scaleResolutionDownBy = 1.0;
                            if (sender.setParameters) {
                                sender.setParameters(params).catch(() => {});
                            }
                            if ('degradationPreference' in sender) {
                                sender.degradationPreference = 'maintain-resolution';
                            }
                        } catch (pErr) {}
                    }
                } catch (e) {}
            });

            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    const cand = event.candidate.toJSON ? event.candidate.toJSON() : {
                        candidate: event.candidate.candidate,
                        sdpMid: event.candidate.sdpMid,
                        sdpMLineIndex: event.candidate.sdpMLineIndex
                    };
                    broadcastSync('RTC_ICE', { candidate: cand });
                }
            };

            const offer = await pc.createOffer();
            let sdpStr = offer.sdp;
            if (sdpStr && !sdpStr.includes('b=AS:')) {
                sdpStr = sdpStr.replace(/(m=video [^\r\n]+[\r\n]+)/, '$1b=AS:4000\r\nb=TIAS:4000000\r\n');
            }
            await pc.setLocalDescription({ type: offer.type, sdp: sdpStr });
            broadcastSync('RTC_OFFER', { sdp: { type: offer.type, sdp: sdpStr } });
        } catch (err) {
            console.warn("[StreamBroadcaster] Failed to create WebRTC offer:", err);
        } finally {
            isBroadcasterNegotiating = false;
        }
    }

    // Listen for pop-out lifecycle and WebRTC messages.
    syncChannel.onmessage = async (event) => {
        if (!event.data) return;

        if (event.data.type === 'POPOUT_READY' || event.data.type === 'REQUEST_STATE_SYNC') {
            setPopoutActive(true);
            syncPopoutViewfinderState();
            if (currentVideoStream && currentVideoStream.active) {
                broadcastStreamToPeer();
            }
        } else if (event.data.type === 'GUEST_HEARTBEAT') {
            setPopoutActive(true);
            resetGuestHeartbeatTimeout();
        } else if (event.data.type === 'REQUEST_STREAM') {
            if (currentVideoStream && currentVideoStream.active) {
                broadcastStreamToPeer();
            }
        } else if (event.data.type === 'RTC_ANSWER' && rtcBroadcasterPc && event.data.sdp) {
            try {
                await rtcBroadcasterPc.setRemoteDescription(new RTCSessionDescription(event.data.sdp));
            } catch (e) {
                console.warn("[StreamBroadcaster] Error setting remote description:", e);
            }
        } else if (event.data.type === 'RTC_ICE' && rtcBroadcasterPc && event.data.candidate) {
            try {
                await rtcBroadcasterPc.addIceCandidate(new RTCIceCandidate(event.data.candidate));
            } catch (e) {}
        } else if (event.data.type === 'MIRROR_CHANGE' && typeof event.data.isMirrored === 'boolean') {
            isMirrored = event.data.isMirrored;
            if (webcamVideo) {
                if (isMirrored) webcamVideo.classList.remove('unmirrored');
                else webcamVideo.classList.add('unmirrored');
            }
        } else if (event.data.type === 'SESSION_RESET') {
            if (resultModal && !resultModal.classList.contains('hidden')) {
                closeResultModalAndSync();
            }
        } else if (event.data.type === 'POPOUT_CLOSED') {
            if (guestHeartbeatTimeout) {
                clearTimeout(guestHeartbeatTimeout);
                guestHeartbeatTimeout = null;
            }
            setPopoutActive(false);
            if (rtcBroadcasterPc) {
                try { rtcBroadcasterPc.close(); } catch (e) {}
                rtcBroadcasterPc = null;
            }
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

    let saveSelectedTemplateTimer = null;
    function saveSelectedTemplateToServer(templateId) {
        if (!templateId) return;
        if (saveSelectedTemplateTimer) clearTimeout(saveSelectedTemplateTimer);
        saveSelectedTemplateTimer = setTimeout(async () => {
            try {
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selected_template_id: templateId })
                });
            } catch (err) {
                console.warn("[App] Could not save selected_template_id to server:", err);
            }
        }, 300);
    }

    // --- TEMPLATE & OVERLAY MANAGEMENT ---
    async function loadTemplates(preferredId = null) {
        try {
            const res = await fetch('/api/templates?t=' + Date.now());
            const data = await res.json();
            if (data.success && data.templates) {
                templates = data.templates;
                renderStudioTable();
                if (templates.length > 0) {
                    let target = null;
                    if (preferredId) {
                        target = templates.find(t => String(t.id) === String(preferredId));
                    }
                    if (!target && activeTemplate) {
                        target = templates.find(t => t.id === activeTemplate.id);
                    }
                    if (!target) {
                        const savedId = localStorage.getItem('pssc_selected_template_id');
                        if (savedId) {
                            target = templates.find(t => String(t.id) === String(savedId));
                        }
                    }
                    if (!target) {
                        target = templates[0];
                    }
                    selectTemplate(target);
                } else {
                    renderTemplateCards();
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
            card.setAttribute('role', 'button');
            card.tabIndex = 0;
            card.dataset.templateId = t.id;
            card.setAttribute('aria-label', `Select ${t.name}`);
            card.setAttribute('aria-pressed', String(activeTemplate?.id === t.id));
            card.innerHTML = `
                <img class="template-card-thumb" src="${t.preview_url}" alt="${t.name}">
                <h4>${t.name}</h4>
                <span>${t.slots ? t.slots.length : 0} Slots • ${t.width}x${t.height}</span>
            `;
            card.addEventListener('click', () => {
                const hadFocus = document.activeElement === card;
                selectTemplate(t);
                if (hadFocus) {
                    Array.from(templateCardsGrid.children).find(item => item.dataset.templateId === String(t.id))?.focus();
                }
            });
            card.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    card.click();
                }
            });
            templateCardsGrid.appendChild(card);
        });
    }

    function selectTemplate(template) {
        if (!template) return;
        activeTemplate = template;
        try {
            localStorage.setItem('pssc_selected_template_id', String(template.id));
        } catch (e) {}
        saveSelectedTemplateToServer(template.id);

        logUserAction("Selected Template", template.name);
        if (activeTemplateTitle) activeTemplateTitle.textContent = template.name;
        if (activeTemplateSpecs) activeTemplateSpecs.textContent = `${template.width} x ${template.height} px • ${template.slots.length} Slots`;

        if (template.slots && template.slots.length > 0 && viewfinderWrapper) {
            const slot = template.slots[0];
            const ratio = (slot.w && slot.h) ? (slot.w / slot.h) : 1.5;
            if (ratio < 0.6) {
                // Fallback to standard photobooth 3:2 landscape if an uncalibrated strip is loaded
                viewfinderWrapper.style.aspectRatio = '340 / 238';
            } else {
                viewfinderWrapper.style.aspectRatio = `${slot.w} / ${slot.h}`;
            }
            resizeOverlayCanvas();
        }

        renderTemplateCards();
        drawSlotOverlays();
        renderLiveTicketCanvas([]);

        broadcastSync('TEMPLATE_CHANGE', {
            name: template.name,
            slotsCount: template.slots ? template.slots.length : 0,
            specs: `${template.width} × ${template.height} · ${template.slots ? template.slots.length : 0} Slots`,
            aspectRatio: (template.slots && template.slots.length > 0) ? `${template.slots[0].w} / ${template.slots[0].h}` : null,
            template: {
                id: template.id,
                name: template.name,
                width: template.width,
                height: template.height,
                slots: template.slots,
                preview_url: template.preview_url
            }
        });

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

        const broadcastTicketRender = () => {
            try {
                if (liveTicketCanvas && liveTicketCanvas.width > 0) {
                    const dataUrl = liveTicketCanvas.toDataURL('image/jpeg', 0.85);
                    broadcastSync('TICKET_RENDER', {
                        dataUrl,
                        templateName: activeTemplate ? activeTemplate.name : '',
                        specs: activeTemplate ? `${activeTemplate.width} × ${activeTemplate.height} · ${activeTemplate.slots ? activeTemplate.slots.length : 0} Slots` : ''
                    });
                }
            } catch (e) {}
        };

        const drawStickers = () => {
            if (typeof activeStickers !== 'undefined' && activeStickers.length > 0) {
                ctx.font = '32px sans-serif';
                ctx.textAlign = 'right';
                activeStickers.forEach((st, idx) => {
                    ctx.fillText(st, activeTemplate.width - 24, 50 + (idx * 40));
                });
            }
        };

        const finalizeRender = () => {
            if (activeTemplate.overlay_url) {
                const overlayImg = new Image();
                overlayImg.crossOrigin = 'anonymous';
                overlayImg.src = activeTemplate.overlay_url;
                overlayImg.onload = () => {
                    ctx.drawImage(overlayImg, 0, 0, activeTemplate.width, activeTemplate.height);
                    drawStickers();
                    broadcastTicketRender();
                };
                overlayImg.onerror = () => {
                    drawStickers();
                    broadcastTicketRender();
                };
            } else {
                drawStickers();
                broadcastTicketRender();
            }
        };

        const renderShotsAndSlots = () => {
            const validShots = shots.filter(s => s);

            if (validShots.length === 0) {
                // If template has no graphic preview, draw guide slot boxes
                if (!activeTemplate.preview_url) {
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
                }
                drawStickers();
                broadcastTicketRender();
            } else {
                let shotsLoaded = 0;
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

                            const useCurves = cornersSelect ? cornersSelect.value === 'curved' : false;
                            ctx.save();
                            ctx.beginPath();
                            if (useCurves && ctx.roundRect) {
                                ctx.roundRect(targetX, targetY, targetW, targetH, 20);
                            } else {
                                ctx.rect(targetX, targetY, targetW, targetH);
                            }
                            ctx.clip();
                            ctx.drawImage(shotImg, cropX, cropY, cropW, cropH, targetX, targetY, targetW, targetH);
                            ctx.restore();

                            shotsLoaded++;
                            if (shotsLoaded === validShots.length) {
                                finalizeRender();
                            }
                        };
                        shotImg.onerror = () => {
                            shotsLoaded++;
                            if (shotsLoaded === validShots.length) {
                                finalizeRender();
                            }
                        };
                    }
                });
            }
        };

        baseImg.onload = () => {
            ctx.drawImage(baseImg, 0, 0, activeTemplate.width, activeTemplate.height);
            renderShotsAndSlots();
        };

        baseImg.onerror = () => {
            renderShotsAndSlots();
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

    // --- LIVE FILTERS (DROPDOWN OPTION) ---
    if (filterSelect) {
        filterSelect.addEventListener('change', () => {
            selectedFilter = filterSelect.value;
            applyLiveCssFilter();
            broadcastSync('FILTER_CHANGE', { filter: selectedFilter });
            logUserAction("Selected Live Filter", selectedFilter);
        });
    }

    function getCssFilterString(filterKey) {
        switch (filterKey) {
            case 'k_glow':
                return 'brightness(108%) contrast(104%) saturate(106%)';
            case 'haru_blue':
                return 'contrast(106%) brightness(105%) saturate(95%) sepia(12%) hue-rotate(160deg)';
            case 'portra':
                return 'sepia(18%) saturate(115%) contrast(108%) brightness(102%) hue-rotate(-6deg)';
            case 'fuji_provia':
                return 'contrast(115%) saturate(125%) brightness(102%) hue-rotate(5deg)';
            case 'bw':
                return 'grayscale(100%) contrast(125%) brightness(102%)';
            case 'golden':
                return 'sepia(35%) saturate(135%) brightness(104%) contrast(108%) hue-rotate(-12deg)';
            case 'vintage':
                return 'contrast(112%) saturate(85%) sepia(35%) brightness(102%)';
            case 'cinematic':
                return 'contrast(120%) saturate(110%) sepia(15%) hue-rotate(150deg) brightness(98%)';
            case 'indie':
                return 'contrast(90%) brightness(110%) saturate(88%) sepia(12%)';
            case 'cyberpunk':
                return 'hue-rotate(180deg) saturate(145%) contrast(115%)';
            case 'vivid':
                return 'saturate(165%) contrast(115%) brightness(103%)';
            case 'sepia':
                return 'sepia(90%) contrast(110%) brightness(95%)';
            case 'normal':
            default:
                return 'none';
        }
    }

    function applyLiveCssFilter() {
        if (filterSelect && filterSelect.value !== selectedFilter) {
            filterSelect.value = selectedFilter;
        }
        webcamVideo.style.filter = getCssFilterString(selectedFilter);
    }

    function updateStripSlotThumbnail(slotIndex, dataUrl) {}
    function resetStripSlotThumbnails() {}

    // --- CANCELLATION LOGIC (GLOBAL OVERRIDE) ---
    async function handleCancelSession() {
        // 1. Immediately invalidate active session token to abort sequence loops
        activeSessionToken = null;

        // 2. Stop all playing audio & clear active timers
        stopAllAudio();
        clearAllActiveTimers();
        finishActiveCountdown();

        discardLiveSessionRecording();

        // 3. Reset UI state to idle landing screen
        isSessionRunning = false;
        btnStartBooth.disabled = false;
        btnStartBooth.classList.add('btn-glow');
        btnStartBooth.classList.remove('hidden');
        btnCancelBooth.classList.add('hidden');
        clearSessionOverlays();
        resetStripSlotThumbnails();

        showStatusNotice("Session Cancelled");

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
            alert("Crucial Setup Missing: Camera Device is disconnected or off.\n\nPlease connect or select an active camera in Settings before starting a session.");
            return;
        }

        // 2. Template check
        if (!activeTemplate) {
            alert("Crucial Setup Missing: No template selected.\n\nPlease select a photobooth template from the right panel before starting.");
            return;
        }

        // 3. Google Sheets Database Link check
        try {
            const cfgRes = await fetch('/api/config');
            const cfgData = await cfgRes.json();
            if (!cfgData.google_sheets_url || cfgData.google_sheets_url.trim() === '') {
                alert("Crucial Setup Missing: Google Sheets Database Link is empty.\n\nPlease enter your Google Sheets Webhook URL in the Settings tab before starting photobooth sessions.");
                const navSettings = document.getElementById('navSettings');
                if (navSettings) navSettings.click();
                return;
            }
        } catch(e) {
            console.warn("Config check error before session start:", e);
        }

        if (isSessionRunning) return;
        isSessionRunning = true;
        const sessionToken = ++activeSessionToken;

        // Clean up any lingering audio from previous session or preview
        stopAllAudio();
        clearAllActiveTimers();

        // UI Transition to in-session state
        btnStartBooth.disabled = true;
        btnStartBooth.classList.remove('btn-glow');
        btnStartBooth.classList.add('hidden');
        btnCancelBooth.classList.remove('hidden');

        capturedPhotos = [];
        capturedRawPhotos = [];
        if (micSelect && micSelect.value !== 'none' && (!currentAudioStream || !currentAudioStream.active)) {
            try {
                await initMicrophoneStream(micSelect.value);
            } catch (_) {}
        }
        startLiveSessionRecording();
        resetStripSlotThumbnails();
        const totalShots = 3;
        const delaySeconds = parseInt(countdownSelect ? countdownSelect.value : 3, 10);
        broadcastSync('SESSION_START', { total: totalShots });

        totalShotNum.textContent = totalShots;
        sessionProgressBadge.classList.remove('hidden');

        renderLiveTicketCanvas([]);

        try {
            // --- SESSION START: Play welcome category (Talking Point 1) ---
            showStatusNotice("Welcome to PSSC PhotoBooth 3.0");
            await playAudioCategory('welcome');
            if (activeSessionToken !== sessionToken) return;

            // --- PICTURE 1 SEQUENCE --- (welcome serves as cue for picture 1)
            currentShotNum.textContent = 1;
            broadcastSync('SHOT_UPDATE', { current: 1, total: totalShots });
            showStatusNotice("Get Ready for Picture 1");
            await runCountdownSequence(delaySeconds, sessionToken);
            if (activeSessionToken !== sessionToken) return;

            // 1. Capture pristine camera frame at countdown zero
            const frames1 = captureWebcamFrame();
            // 2. Trigger snappy visual strobe & shutter
            triggerFlash();
            capturedPhotos.push(frames1.filtered);
            capturedRawPhotos.push(frames1.raw);
            updateStripSlotThumbnail(0, frames1.filtered);
            broadcastSync('SHOT_UPDATE', { current: 1, total: totalShots, photoUrl: frames1.filtered });
            renderLiveTicketCanvas(capturedPhotos);

            // --- PICTURE 2 SEQUENCE ---
            currentShotNum.textContent = 2;
            broadcastSync('SHOT_UPDATE', { current: 2, total: totalShots });
            // Exactly ONE voiceover played for Talking Point 2 (Photo 1 taken / Picture 2 cue)
            await playAudioCategory('photo2');
            if (activeSessionToken !== sessionToken) return;

            await runCountdownSequence(delaySeconds, sessionToken);
            if (activeSessionToken !== sessionToken) return;

            // 1. Capture pristine camera frame at countdown zero
            const frames2 = captureWebcamFrame();
            // 2. Trigger snappy visual strobe & shutter
            triggerFlash();
            capturedPhotos.push(frames2.filtered);
            capturedRawPhotos.push(frames2.raw);
            updateStripSlotThumbnail(1, frames2.filtered);
            broadcastSync('SHOT_UPDATE', { current: 2, total: totalShots, photoUrl: frames2.filtered });
            renderLiveTicketCanvas(capturedPhotos);

            // --- PICTURE 3 SEQUENCE ---
            currentShotNum.textContent = 3;
            broadcastSync('SHOT_UPDATE', { current: 3, total: totalShots });
            // Exactly ONE voiceover played for Talking Point 3 (Photo 2 taken / Picture 3 cue)
            await playAudioCategory('photo3');
            if (activeSessionToken !== sessionToken) return;

            await runCountdownSequence(delaySeconds, sessionToken);
            if (activeSessionToken !== sessionToken) return;

            // 1. Capture pristine camera frame at countdown zero
            const frames3 = captureWebcamFrame();
            // 2. Trigger snappy visual strobe & shutter
            triggerFlash();
            capturedPhotos.push(frames3.filtered);
            capturedRawPhotos.push(frames3.raw);
            updateStripSlotThumbnail(2, frames3.filtered);
            broadcastSync('SHOT_UPDATE', { current: 3, total: totalShots, photoUrl: frames3.filtered });
            renderLiveTicketCanvas(capturedPhotos);

            // --- STOP LIVE SESSION RECORDING ---
            const videoBlobPromise = stopAndGetLiveSessionVideo();

            // --- SESSION COMPLETE ---
            showStatusNotice("Generating Final Photobooth Ticket & Verification Code...");
            sessionProgressBadge.classList.add('hidden');
            countdownOverlay.classList.add('hidden');
            broadcastSync('SESSION_END');

            const res = await fetch('/api/session/composite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    template_id: activeTemplate.id,
                    photos: capturedPhotos,
                    raw_photos: capturedRawPhotos,
                    filter: selectedFilter,
                    guest_name: guestNameInput ? guestNameInput.value.trim() : 'Guest',
                    paid: paidSelect ? paidSelect.value : 'Paid',
                    given: givenSelect ? givenSelect.value : 'Not Given',
                    layout: layoutSelect ? layoutSelect.value : 'double',
                    corners: cornersSelect ? cornersSelect.value : 'sharp'
                })
            });

            if (!res.ok) {
                let errText = "Failed to generate photobooth ticket";
                try {
                    const errJson = await res.json();
                    if (errJson && errJson.error) errText = errJson.error;
                } catch (_) {
                    errText = await res.text();
                }
                throw new Error(errText);
            }

            const data = await res.json();
            if (activeSessionToken !== sessionToken) return;

            if (data.success) {
                const queueNum = data.queue_number || (data.code ? String(data.code).replace(/[^0-9]/g, '') : '1');
                const guestName = guestNameInput ? guestNameInput.value.trim() : 'Guest';

                // Asynchronously save raw video recording into RAW CLIPS AND PICTURES folder and Google Drive
                videoBlobPromise.then(vBlob => {
                    if (vBlob && vBlob.size > 0) {
                        const vData = new FormData();
                        vData.append('video', vBlob, `queue_${queueNum}_live.webm`);
                        vData.append('queue_number', queueNum);
                        vData.append('guest_name', guestName);
                        vData.append('session_id', data.session_id || '');
                        vData.append('session_folder_name', data.session_folder_name || '');
                        vData.append('raw_folder', data.raw_folder || '');
                        fetch('/api/session/save-raw-video', {
                            method: 'POST',
                            body: vData
                        }).then(r => r.json()).then(vRes => {
                            console.log("Raw session video saved to RAW CLIPS AND PICTURES and Google Drive:", vRes);
                        }).catch(vErr => {
                            console.error("Notice saving raw video:", vErr);
                        });
                    }
                });

                showResultModal(
                    data.output_url,
                    data.queue_display || data.code,
                    data.filename,
                    data.session_id,
                    data.paid_status,
                    data.given_status
                );
                loadGallery();
                loadSystemConfig();
                showStatusNotice(`Photobooth Ticket Ready · ${data.queue_display || data.code || ''}`);
                playCelebrationFanfare();
                playAudioCategory('complete');
                broadcastSync('STATUS_NOTICE', { text: `Ticket Ready · ${data.queue_display || data.code || ''}` });
            } else {
                alert("Composite Error: " + (data.error || "Unknown error"));
            }

        } catch (err) {
            console.error("Session Execution Error:", err);
            alert("Error during session: " + (err.message || err));
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
                    // countdown starts at 3: fire immediately (already at 3.0s remaining)
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
        setTimeout(() => flashOverlay.classList.remove('active'), 80);
    }

    function getCanvasFilterString() {
        return getCssFilterString(selectedFilter);
    }

    function captureWebcamFrame() {
        const vw = webcamVideo.videoWidth || 1280;
        const vh = webcamVideo.videoHeight || 720;

        // 1. Pristine RAW camera frame (No filter, maximum sharpness & clarity)
        const rawCanvas = document.createElement('canvas');
        rawCanvas.width = vw;
        rawCanvas.height = vh;
        const rawCtx = rawCanvas.getContext('2d', { alpha: false });
        if (rawCtx) {
            rawCtx.imageSmoothingEnabled = true;
            rawCtx.imageSmoothingQuality = 'high';
            if (isMirrored) {
                rawCtx.translate(vw, 0);
                rawCtx.scale(-1, 1);
            }
            rawCtx.drawImage(webcamVideo, 0, 0, vw, vh);
        }

        // 2. Filtered frame (bakes guest's aesthetic choice)
        const filteredCanvas = document.createElement('canvas');
        filteredCanvas.width = vw;
        filteredCanvas.height = vh;
        const filteredCtx = filteredCanvas.getContext('2d', { alpha: false });
        if (filteredCtx) {
            filteredCtx.imageSmoothingEnabled = true;
            filteredCtx.imageSmoothingQuality = 'high';
            const filterStr = getCanvasFilterString();
            if (filterStr && filterStr !== 'none') {
                filteredCtx.filter = filterStr;
            }
            if (isMirrored) {
                filteredCtx.translate(vw, 0);
                filteredCtx.scale(-1, 1);
            }
            filteredCtx.drawImage(webcamVideo, 0, 0, vw, vh);
            filteredCtx.filter = 'none';
        }

        const rawData = rawCanvas.toDataURL('image/png');
        const filteredData = filteredCanvas.toDataURL('image/png');

        return {
            raw: rawData,
            filtered: filteredData,
            toString() { return filteredData; }
        };
    }

    function startLiveSessionRecording() {
        liveSessionChunks = [];
        if (!currentVideoStream || !currentVideoStream.active) {
            console.warn("No active video stream to record");
            return;
        }

        try {
            const tracks = [...currentVideoStream.getVideoTracks()];
            if (currentAudioStream && currentAudioStream.active) {
                const liveAudioTracks = currentAudioStream.getAudioTracks().filter(t => t.readyState === 'live');
                if (liveAudioTracks.length > 0) {
                    tracks.push(liveAudioTracks[0]);
                    console.log("Adding live microphone track to session recording:", liveAudioTracks[0].label);
                }
            }

            const recordStream = new MediaStream(tracks);

            const candidateCodecs = [
                'video/webm;codecs=h264,opus',
                'video/webm;codecs=h264',
                'video/mp4;codecs=avc1,mp4a',
                'video/webm;codecs=vp8,opus',
                'video/webm;codecs=vp8',
                'video/webm'
            ];
            let mimeType = '';
            for (const c of candidateCodecs) {
                if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) {
                    mimeType = c;
                    break;
                }
            }
            if (!mimeType) mimeType = 'video/webm';

            const options = { mimeType };
            try {
                liveSessionRecorder = new MediaRecorder(recordStream, { ...options, videoBitsPerSecond: 2500000 });
            } catch (_) {
                liveSessionRecorder = new MediaRecorder(recordStream, options);
            }

            liveSessionRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    liveSessionChunks.push(e.data);
                }
            };

            liveSessionRecorder.onerror = (e) => {
                console.error("LiveSessionRecorder error:", e);
            };

            liveSessionRecorder.start(400);
            console.log("Live session recording started with mimeType:", mimeType, "hasAudio:", tracks.length > 1);
        } catch (err) {
            console.error("Failed to initialize MediaRecorder for live session:", err);
        }
    }

    function stopAndGetLiveSessionVideo() {
        return new Promise((resolve) => {
            if (!liveSessionRecorder || liveSessionRecorder.state === 'inactive') {
                if (liveSessionChunks && liveSessionChunks.length > 0) {
                    const blob = new Blob(liveSessionChunks, { type: liveSessionChunks[0].type || 'video/webm' });
                    resolve(blob);
                } else {
                    resolve(null);
                }
                return;
            }

            liveSessionRecorder.onstop = () => {
                try {
                    const mime = (liveSessionChunks.length > 0 && liveSessionChunks[0].type) ? liveSessionChunks[0].type : (liveSessionRecorder.mimeType || 'video/webm');
                    const blob = new Blob(liveSessionChunks, { type: mime });
                    console.log("Live session video captured successfully. Size:", blob.size, "bytes");
                    resolve(blob);
                } catch (err) {
                    console.error("Error creating video blob:", err);
                    resolve(null);
                }
            };

            try {
                liveSessionRecorder.stop();
            } catch (e) {
                console.error("Error stopping liveSessionRecorder:", e);
                resolve(null);
            }
        });
    }

    function discardLiveSessionRecording() {
        try {
            if (liveSessionRecorder && liveSessionRecorder.state !== 'inactive') {
                liveSessionRecorder.stop();
            }
        } catch (_) {}
        liveSessionChunks = [];
        liveSessionRecorder = null;
    }

    function updateCopiesUI() {
        if (printCopiesVal) printCopiesVal.textContent = currentPrintCopies;
        if (btnPrintResult) {
            const copyWord = currentPrintCopies === 1 ? 'Copy' : 'Copies';
            btnPrintResult.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:8px;"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> <span>Print (${currentPrintCopies} ${copyWord})</span>`;
        }
    }

    if (btnCopiesDec) {
        btnCopiesDec.addEventListener('click', () => {
            if (currentPrintCopies > 1) {
                currentPrintCopies--;
                updateCopiesUI();
            }
        });
    }

    if (btnCopiesInc) {
        btnCopiesInc.addEventListener('click', () => {
            if (currentPrintCopies < 10) {
                currentPrintCopies++;
                updateCopiesUI();
            }
        });
    }

    function closeResultModalAndSync() {
        if (resultModal) resultModal.classList.add('hidden');
        resetStripSlotThumbnails();
        if (activeTemplate) {
            renderLiveTicketCanvas([]);
        }
        broadcastSync('SESSION_RESET');
        showStatusNotice("Ready for Next Guest!");
        setTimeout(hideStatusNotice, 2500);
    }

    if (btnFinishAndNewSession) {
        btnFinishAndNewSession.addEventListener('click', closeResultModalAndSync);
    }

    let currentResultSessionId = null;
    let currentResultPaid = 'Paid';
    let currentResultGiven = 'Not Given';
    let currentResultCode = '';

    function updateResultTrackerUI() {
        const modalQueueBadge = document.getElementById('modalQueueBadge');
        const btnModalPaid = document.getElementById('btnModalPaid');
        const btnModalUnpaid = document.getElementById('btnModalUnpaid');
        const btnModalGiven = document.getElementById('btnModalGiven');
        const btnModalNotGiven = document.getElementById('btnModalNotGiven');

        if (modalQueueBadge && currentResultCode) {
            modalQueueBadge.textContent = currentResultCode;
        }
        if (btnModalPaid && btnModalUnpaid) {
            const isPaid = (currentResultPaid === 'Paid');
            btnModalPaid.style.background = isPaid ? 'rgba(34,197,94,0.2)' : 'var(--s2)';
            btnModalPaid.style.borderColor = isPaid ? '#22c55e' : 'var(--b2)';
            btnModalPaid.style.color = isPaid ? '#86efac' : 'var(--t3)';
            btnModalPaid.style.fontWeight = isPaid ? '700' : '500';

            btnModalUnpaid.style.background = !isPaid ? 'rgba(239,68,68,0.2)' : 'var(--s2)';
            btnModalUnpaid.style.borderColor = !isPaid ? 'rgba(239,68,68,0.5)' : 'var(--b2)';
            btnModalUnpaid.style.color = !isPaid ? '#fca5a5' : 'var(--t3)';
            btnModalUnpaid.style.fontWeight = !isPaid ? '700' : '500';
        }
        if (btnModalGiven && btnModalNotGiven) {
            const isGiven = (currentResultGiven === 'Given');
            btnModalGiven.style.background = isGiven ? 'rgba(34,197,94,0.2)' : 'var(--s2)';
            btnModalGiven.style.borderColor = isGiven ? '#22c55e' : 'var(--b2)';
            btnModalGiven.style.color = isGiven ? '#86efac' : 'var(--t3)';
            btnModalGiven.style.fontWeight = isGiven ? '700' : '500';

            btnModalNotGiven.style.background = !isGiven ? 'rgba(239,68,68,0.15)' : 'var(--s2)';
            btnModalNotGiven.style.borderColor = !isGiven ? 'rgba(239,68,68,0.4)' : 'var(--b2)';
            btnModalNotGiven.style.color = !isGiven ? '#fca5a5' : 'var(--t3)';
            btnModalNotGiven.style.fontWeight = !isGiven ? '700' : '500';
        }
    }

    async function updateCurrentSessionStatus(newPaid, newGiven) {
        if (!currentResultSessionId) return;
        if (newPaid !== undefined) currentResultPaid = newPaid;
        if (newGiven !== undefined) currentResultGiven = newGiven;
        updateResultTrackerUI();

        try {
            await fetch(`/api/session/${currentResultSessionId}/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paid: currentResultPaid, given: currentResultGiven })
            });
            const tabGallery = document.getElementById('tab-gallery');
            if (tabGallery && tabGallery.classList.contains('active')) {
                loadGallery();
            }
        } catch (e) {
            console.error("Status update error:", e);
        }
    }

    const btnModalPaid = document.getElementById('btnModalPaid');
    const btnModalUnpaid = document.getElementById('btnModalUnpaid');
    const btnModalGiven = document.getElementById('btnModalGiven');
    const btnModalNotGiven = document.getElementById('btnModalNotGiven');
    if (btnModalPaid) btnModalPaid.addEventListener('click', () => updateCurrentSessionStatus('Paid', undefined));
    if (btnModalUnpaid) btnModalUnpaid.addEventListener('click', () => updateCurrentSessionStatus('Not Paid', undefined));
    if (btnModalGiven) btnModalGiven.addEventListener('click', () => updateCurrentSessionStatus(undefined, 'Given'));
    if (btnModalNotGiven) btnModalNotGiven.addEventListener('click', () => updateCurrentSessionStatus(undefined, 'Not Given'));

    function showResultModal(outputUrl, code = '', filename = '', sessionId = null, paidStatus = 'Paid', givenStatus = 'Not Given') {
        if (!filename && outputUrl) {
            filename = outputUrl.split('/').pop();
        }
        resultImage.src = outputUrl;
        btnDownloadResult.href = outputUrl;
        if (filename) {
            btnDownloadResult.setAttribute('download', filename);
        }

        currentPrintCopies = 1;
        updateCopiesUI();

        const modalHeading = document.getElementById('resultModalHeading');
        const queueLabel = code ? (String(code).startsWith('Queue') ? code : `Queue #${String(code).replace('#', '')}`) : 'Queue #1';
        if (modalHeading) {
            modalHeading.innerHTML = `Session Complete! <span style="font-size: 0.82rem; color: var(--g); background: var(--gdim); border: 1px solid var(--bg1); padding: 4px 10px; border-radius: 6px; margin-left: 10px; font-weight: 600;">${queueLabel}</span>`;
        }

        currentResultSessionId = sessionId;
        currentResultPaid = paidStatus || 'Paid';
        currentResultGiven = givenStatus || 'Not Given';
        currentResultCode = queueLabel;
        currentResultQueueNumber = code ? String(code).replace(/[^0-9]/g, '') : '';
        updateResultTrackerUI();

        // Fetch dynamic QR code linking to direct download
        const fullDownloadUrl = window.location.origin + outputUrl;
        if (resultQrCodeImg) {
            fetch(`/api/qrcode?data=${encodeURIComponent(fullDownloadUrl)}`)
                .then(r => r.json())
                .then(qrData => {
                    if (qrData.success && qrData.qr_data_url) {
                        resultQrCodeImg.src = qrData.qr_data_url;
                    }
                })
                .catch(() => {
                    resultQrCodeImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(fullDownloadUrl)}`;
                });
        }

        const driveUrl = (googleDriveUrlInput && googleDriveUrlInput.value.trim()) || '';
        broadcastSync('SESSION_COMPLETE', {
            outputUrl,
            filename,
            queueDisplay: queueLabel,
            googleDriveUrl: driveUrl
        });

        resultModal.classList.remove('hidden');
    }

    if (btnCloseModal) {
        btnCloseModal.addEventListener('click', closeResultModalAndSync);
    }
    if (btnCloseModalBtn) {
        btnCloseModalBtn.addEventListener('click', closeResultModalAndSync);
    }

    // ==========================================
    // RAW CLIPS & PHOTOS VIEWER MODAL
    // ==========================================
    let currentRawViewerQueueNumber = null;
    const rawViewerModal = document.getElementById('rawViewerModal');
    const rawModalQueueBadge = document.getElementById('rawModalQueueBadge');
    const rawModalPath = document.getElementById('rawModalPath');
    const rawModalContent = document.getElementById('rawModalContent');
    const btnRawModalOpenExplorer = document.getElementById('btnRawModalOpenExplorer');
    const btnCloseRawModal = document.getElementById('btnCloseRawModal');
    const btnCloseRawModalBtn = document.getElementById('btnCloseRawModalBtn');

    function closeRawViewerModal() {
        if (rawViewerModal) {
            rawViewerModal.classList.add('hidden');
            if (rawModalContent) {
                rawModalContent.querySelectorAll('video').forEach(v => v.pause());
            }
        }
    }

    if (btnCloseRawModal) btnCloseRawModal.addEventListener('click', closeRawViewerModal);
    if (btnCloseRawModalBtn) btnCloseRawModalBtn.addEventListener('click', closeRawViewerModal);
    if (rawViewerModal) {
        rawViewerModal.addEventListener('click', (e) => {
            if (e.target === rawViewerModal) closeRawViewerModal();
        });
    }

    window.triggerExplorerFolderOpen = async function(qNum) {
        const targetQ = qNum || currentRawViewerQueueNumber;
        try {
            const resp = await fetch('/api/open-raw-folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ queue_number: targetQ })
            });
            const d = await resp.json();
            if (d.success) {
                showAppToast("Folder opened in Windows File Explorer!", "success");
            }
        } catch (e) {
            console.error("Error opening explorer:", e);
        }
    };

    if (btnRawModalOpenExplorer) {
        btnRawModalOpenExplorer.addEventListener('click', () => {
            window.triggerExplorerFolderOpen(currentRawViewerQueueNumber);
        });
    }

    window.openRawViewerModal = async function(queueNumber) {
        const qNum = parseInt(String(queueNumber).replace(/[^0-9]/g, ''), 10) || 1;
        currentRawViewerQueueNumber = qNum;

        if (rawModalQueueBadge) rawModalQueueBadge.textContent = `Queue #${qNum}`;
        if (rawModalContent) {
            rawModalContent.innerHTML = `<div style="text-align:center;padding:40px;color:var(--t3);"><div class="spinner" style="margin:0 auto 12px auto;width:24px;height:24px;border:3px solid var(--b2);border-top-color:#3b82f6;border-radius:50%;animation:spin 0.8s linear infinite;"></div><div>Loading raw clips and photos...</div></div>`;
        }
        if (rawViewerModal) rawViewerModal.classList.remove('hidden');

        // Automatically trigger launching File Explorer on the Windows desktop
        window.triggerExplorerFolderOpen(qNum);

        try {
            const resp = await fetch(`/api/raw-files/${qNum}`);
            const data = await resp.json();
            if (rawModalPath && data.folder_path) {
                rawModalPath.textContent = data.folder_path;
                rawModalPath.title = data.folder_path;
            }

            if (!data.files || data.files.length === 0) {
                rawModalContent.innerHTML = `
                    <div style="text-align:center;padding:50px 20px;background:var(--bg3);border-radius:12px;border:1px dashed var(--b2);">
                        <div style="font-size:36px;margin-bottom:12px;">📂</div>
                        <h3 style="margin:0 0 6px 0;color:var(--t1);">No RAW files found for Queue #${qNum}</h3>
                        <p style="margin:0 0 16px 0;font-size:0.85rem;color:var(--t3);">Session clips and camera shots will be saved here automatically when a photobooth session completes.</p>
                        <button class="btn btn-secondary btn-sm" onclick="window.triggerExplorerFolderOpen(${qNum})" style="display:inline-flex;align-items:center;gap:6px;">
                            <span>🗁</span> Open Main RAW Directory
                        </button>
                    </div>
                `;
                return;
            }

            const videoFiles = data.files.filter(f => f.type === 'video');
            const imageFiles = data.files.filter(f => f.type === 'image');

            let html = '';

            // Video Section
            if (videoFiles.length > 0) {
                const mainVid = videoFiles.find(v => v.name.endsWith('.mp4')) || videoFiles[0];
                html += `
                    <div style="background:var(--bg3);border:1px solid var(--b2);border-radius:12px;padding:16px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px;">
                            <div style="display:flex;align-items:center;gap:10px;">
                                <div style="width:34px;height:34px;border-radius:8px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);display:flex;align-items:center;justify-content:center;font-size:18px;">🎬</div>
                                <div>
                                    <div style="font-size:0.95rem;font-weight:700;color:var(--t1);">Live Session Video Recording</div>
                                    <div style="font-size:0.75rem;color:var(--t3);">${mainVid.name} • <span style="color:#60a5fa;font-weight:600;">${mainVid.size}</span></div>
                                </div>
                            </div>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <a href="${mainVid.url}" download="${mainVid.name}" class="btn btn-primary btn-sm" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:6px 14px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;">
                                    <span>⬇️</span> Download Video (${mainVid.size})
                                </a>
                            </div>
                        </div>
                        <div style="position:relative;border-radius:8px;overflow:hidden;background:#000;box-shadow:0 8px 24px rgba(0,0,0,0.5);">
                            <video src="${mainVid.url}" controls style="width:100%;max-height:360px;display:block;" playsinline preload="metadata"></video>
                        </div>
                    </div>
                `;
            }

            // RAW Photos Section
            if (imageFiles.length > 0) {
                html += `
                    <div style="background:var(--bg3);border:1px solid var(--b2);border-radius:12px;padding:16px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
                            <div style="display:flex;align-items:center;gap:10px;">
                                <div style="width:34px;height:34px;border-radius:8px;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);display:flex;align-items:center;justify-content:center;font-size:18px;">📸</div>
                                <div>
                                    <div style="font-size:0.95rem;font-weight:700;color:var(--t1);">High-Resolution RAW Photos (${imageFiles.length})</div>
                                    <div style="font-size:0.75rem;color:var(--t3);">Original camera captures &amp; final print strip output</div>
                                </div>
                            </div>
                        </div>
                        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(210px, 1fr));gap:14px;">
                            ${imageFiles.map(img => `
                                <div style="background:var(--bg2);border:1px solid var(--b1);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 4px 12px rgba(0,0,0,0.2);">
                                    <div style="height:160px;background:#0b0f19;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;">
                                        <img src="${img.url}" alt="${img.name}" style="width:100%;height:100%;object-fit:cover;cursor:pointer;transition:transform 0.2s;" onmouseover="this.style.transform='scale(1.04)'" onmouseout="this.style.transform='scale(1)'" onclick="window.open('${img.url}', '_blank')">
                                    </div>
                                    <div style="padding:10px 12px;display:flex;flex-direction:column;gap:8px;flex:1;justify-content:space-between;">
                                        <div>
                                            <div style="font-size:0.8rem;font-weight:600;color:var(--t1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${img.name}">${img.name}</div>
                                            <div style="font-size:0.72rem;color:var(--t3);">${img.size}</div>
                                        </div>
                                        <a href="${img.url}" download="${img.name}" class="btn btn-secondary btn-sm" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;font-size:11px;padding:6px 10px;width:100%;border-radius:6px;text-decoration:none;">
                                            <span>⬇️</span> Download Photo
                                        </a>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            }

            rawModalContent.innerHTML = html;

        } catch (err) {
            console.error("Error loading raw files:", err);
            rawModalContent.innerHTML = `<div style="text-align:center;padding:30px;color:#ef4444;">Error loading files: ${err.message}</div>`;
        }
    };

    const btnOpenRawFolderResult = document.getElementById('btnOpenRawFolderResult');
    if (btnOpenRawFolderResult) {
        btnOpenRawFolderResult.addEventListener('click', () => {
            window.openRawViewerModal(currentResultQueueNumber);
        });
    }

    const btnOpenRawFolderSettings = document.getElementById('btnOpenRawFolderSettings');
    if (btnOpenRawFolderSettings) {
        btnOpenRawFolderSettings.addEventListener('click', () => {
            window.triggerExplorerFolderOpen(null);
        });
    }

    btnPrintResult.addEventListener('click', () => {
        updateCurrentSessionStatus(undefined, 'Given');
        const copies = currentPrintCopies || 1;
        const win = window.open('', '_blank');
        let pagesHtml = '';
        for (let i = 0; i < copies; i++) {
            pagesHtml += `<div style="page-break-after:always;display:flex;justify-content:center;align-items:center;height:100vh;width:100vw;margin:0;padding:0;"><img src="${resultImage.src}" style="max-height:98vh;max-width:98vw;object-fit:contain;display:block;"></div>`;
        }
        win.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Print Photobooth Strips (${copies} Copies)</title>
                <style>
                    @page { margin: 0; size: auto; }
                    body { margin: 0; padding: 0; background: #fff; }
                </style>
            </head>
            <body>${pagesHtml}</body>
            </html>
        `);
        win.document.close();
        win.focus();
        setTimeout(() => {
            win.print();
        }, 500);
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
        btnUploadPSD.innerHTML = '<span>Parsing &amp; Saving to Database...</span>';

        try {
            const res = await fetch('/api/templates/import', {
                method: 'POST',
                body: formData
            });

            const data = await res.json();
            if (data.success) {
                alert("Template imported successfully into SQLite database.");
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
            btnUploadPSD.innerHTML = '<span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Import &amp; Save</span>';
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
                    <button class="btn btn-secondary btn-sm btn-del-temp" data-id="${t.id}" style="display:inline-flex; align-items:center; gap:4px;">
                        ${SVG_ICONS.trash} Delete
                    </button>
                </td>
            `;
            dbTemplatesTableBody.appendChild(tr);
        });

        document.querySelectorAll('.btn-del-temp').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                if (confirm("Are you sure you want to delete this template from the database?")) {
                    await fetch(`/api/templates/${id}`, { method: 'DELETE' });
                    loadTemplates();
                }
            });
        });
    }

    btnRefreshTemplates.addEventListener('click', loadTemplates);

    // --- GALLERY VIEW & QUEUE ORDER TRACKER ---
    let cachedGallerySessions = [];
    let activeGalleryFilter = 'all';

    document.querySelectorAll('.gallery-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.gallery-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeGalleryFilter = btn.dataset.filter || 'all';
            renderGallery(cachedGallerySessions);
        });
    });

    function showAppToast(message, type = 'info', duration = 3200) {
        let container = document.getElementById('appToastContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'appToastContainer';
            container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
            document.body.appendChild(container);
        }
        const toast = document.createElement('div');
        const isSuccess = type === 'success';
        const isError = type === 'error';
        const bg = isSuccess ? 'rgba(22, 101, 52, 0.95)' : (isError ? 'rgba(153, 27, 27, 0.95)' : 'rgba(15, 23, 42, 0.95)');
        const border = isSuccess ? 'rgba(34, 197, 94, 0.5)' : (isError ? 'rgba(239, 68, 68, 0.5)' : 'rgba(255, 255, 255, 0.2)');
        toast.style.cssText = `background:${bg};border:1px solid ${border};color:#f8fafc;padding:11px 18px;border-radius:12px;font-size:12.5px;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,0.5);backdrop-filter:blur(12px);transition:all 0.3s cubic-bezier(0.16, 1, 0.3, 1);transform:translateY(12px);opacity:0;display:flex;align-items:center;gap:8px;pointer-events:auto;max-width:380px;line-height:1.4;`;
        toast.innerHTML = message;
        container.appendChild(toast);
        requestAnimationFrame(() => {
            toast.style.transform = 'translateY(0)';
            toast.style.opacity = '1';
        });
        setTimeout(() => {
            toast.style.transform = 'translateY(10px)';
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 350);
        }, duration);
    }

    async function loadGallery() {
        try {
            const res = await fetch('/api/gallery');
            const data = await res.json();
            if (data.success) {
                cachedGallerySessions = data.sessions || [];
                renderGallery(cachedGallerySessions);
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

        let filtered = sessions;
        if (activeGalleryFilter === 'unpaid') {
            filtered = sessions.filter(s => (s.paid_status || 'Paid') !== 'Paid');
        } else if (activeGalleryFilter === 'not_given') {
            filtered = sessions.filter(s => (s.given_status || 'Not Given') !== 'Given');
        }

        if (filtered.length === 0) {
            galleryGrid.innerHTML = `<p class="text-muted" style="grid-column: 1/-1;">No sessions found matching filter "${activeGalleryFilter}".</p>`;
            return;
        }

        filtered.forEach(s => {
            const dateStr = new Date(s.created_at * 1000).toLocaleString();
            const dlFilename = s.output_path || `photobooth_${s.id}.png`;
            const qNum = s.queue_number || s.id;
            const qDisplay = s.code && String(s.code).startsWith('Queue') ? s.code : `Queue #${qNum}`;
            const isPaid = (s.paid_status || 'Paid') === 'Paid';
            const isGiven = (s.given_status || 'Not Given') === 'Given';

            const card = document.createElement('div');
            card.className = 'gallery-card';
            card.innerHTML = `
                <button type="button" class="gallery-img-wrapper" title="View full resolution" aria-label="View session ${qDisplay}">
                    <img src="${s.output_url}" alt="Photobooth Session">
                </button>
                <div class="gallery-card-info">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong style="color:var(--t1); font-size:0.85rem;">${s.guest_name ? s.guest_name + ' • ' : ''}${s.template_name || 'Photobooth'}</strong>
                        <span style="font-size:0.75rem; color:var(--g); font-weight:700; background:var(--gdim); border:1px solid var(--bg1); padding:2px 8px; border-radius:6px;">${qDisplay}</span>
                    </div>
                    <small style="color:var(--t3);">${dateStr}</small>
                    <div class="gallery-status-bar" style="display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap;">
                        <button type="button" class="badge-status-toggle badge-paid ${isPaid ? 'is-paid' : 'is-unpaid'}" data-id="${s.id}" data-type="paid" title="Click to toggle Payment status and sync to Google Sheets">
                            ${isPaid ? '✓ Paid' : '⚠ Not Paid'}
                        </button>
                        <button type="button" class="badge-status-toggle badge-given ${isGiven ? 'is-given' : 'is-not-given'}" data-id="${s.id}" data-type="given" title="Click to toggle Print handover status and sync to Google Sheets">
                            ${isGiven ? '✓ Given' : '○ Not Given'}
                        </button>
                        <div style="margin-left:auto;display:flex;align-items:center;gap:6px;">
                            <button type="button" class="badge-raw-link" data-queue="${qNum}" style="border:none;background:none;cursor:pointer;font-size:10.5px;color:#a78bfa;display:inline-flex;align-items:center;gap:3px;padding:0;" title="Open RAW Clips &amp; Photos in File Explorer">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> RAW
                            </button>
                            ${s.drive_url && s.drive_url !== '-' ? `<a href="${s.drive_url}" target="_blank" rel="noopener noreferrer" class="badge-drive-link" style="font-size:10.5px;color:#60a5fa;display:inline-flex;align-items:center;gap:3px;text-decoration:none;" title="Open in Google Drive"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> Drive</a>` : ''}
                        </div>
                    </div>
                </div>
                <div class="gallery-card-actions">
                    <a href="${s.output_url}" download="${dlFilename}" class="btn-download-sess" style="display:inline-flex; align-items:center; gap:4px;">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download High-Res
                    </a>
                    <button class="btn btn-secondary btn-sm btn-del-sess" data-id="${s.id}" title="Delete session" style="display:inline-flex; align-items:center; justify-content:center; padding:4px 8px;">
                        ${SVG_ICONS.trash}
                    </button>
                </div>
            `;

            // Click image to open in Result Modal
            const imgWrapper = card.querySelector('.gallery-img-wrapper');
            if (imgWrapper) {
                imgWrapper.addEventListener('click', () => {
                    showResultModal(s.output_url, s.code || '', dlFilename, s.id, s.paid_status, s.given_status);
                });
            }

            // Click RAW link to open file explorer & in-app viewer
            const rawBtn = card.querySelector('.badge-raw-link');
            if (rawBtn) {
                rawBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (window.openRawViewerModal) {
                        window.openRawViewerModal(qNum);
                    } else if (window.triggerExplorerFolderOpen) {
                        window.triggerExplorerFolderOpen(qNum);
                    }
                });
            }

            // Click badges to toggle status and auto-sync Google Sheets
            card.querySelectorAll('.badge-status-toggle').forEach(badge => {
                badge.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const id = badge.dataset.id;
                    const type = badge.dataset.type;
                    const newPaid = (type === 'paid') ? (isPaid ? 'Not Paid' : 'Paid') : undefined;
                    const newGiven = (type === 'given') ? (isGiven ? 'Not Given' : 'Given') : undefined;
                    const origContent = badge.innerHTML;
                    badge.style.opacity = '0.6';
                    badge.innerHTML = `<span style="font-size:10px;">Updating...</span>`;
                    try {
                        const res = await fetch(`/api/session/${id}/status`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ paid: newPaid, given: newGiven })
                        });
                        const rData = await res.json();
                        if (rData.success) {
                            showAppToast(`✓ ${qDisplay} status updated &amp; synced to Google Sheets!`, 'success');
                            loadGallery();
                        } else {
                            showAppToast(`⚠ Could not update status: ${rData.error || 'Failed'}`, 'error');
                            badge.innerHTML = origContent;
                            badge.style.opacity = '1';
                        }
                    } catch (err) {
                        console.error("Status update error:", err);
                        showAppToast("⚠ Network error updating status", 'error');
                        badge.innerHTML = origContent;
                        badge.style.opacity = '1';
                    }
                });
            });

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

    const btnSyncSheets = document.getElementById('btnSyncSheets');
    async function syncFromGoogleSheets(silent = false) {
        if (btnSyncSheets) {
            btnSyncSheets.style.opacity = '0.65';
            btnSyncSheets.disabled = true;
        }
        try {
            const res = await fetch('/api/cloud/sync-from-sheets');
            const data = await res.json();
            if (data.success) {
                if (!silent || data.updated_count > 0) {
                    showAppToast(`✓ ${data.message}`, 'success');
                }
                const gRes = await fetch('/api/gallery');
                const gData = await gRes.json();
                if (gData.success) {
                    cachedGallerySessions = gData.sessions || [];
                    renderGallery(cachedGallerySessions);
                }
            } else {
                if (!silent) {
                    showAppToast(`⚠ Sync note: ${data.error || 'Check Google Sheets URL in Settings'}`, 'error');
                }
            }
        } catch (err) {
            console.error("Error syncing with Google Sheets:", err);
            if (!silent) {
                showAppToast("⚠ Could not reach Google Sheets Web App. Check internet or Settings.", 'error');
            }
        } finally {
            if (btnSyncSheets) {
                btnSyncSheets.style.opacity = '1';
                btnSyncSheets.disabled = false;
            }
        }
    }

    if (btnSyncSheets) {
        btnSyncSheets.addEventListener('click', () => syncFromGoogleSheets(false));
    }

    btnRefreshGallery.addEventListener('click', () => {
        loadGallery();
        syncFromGoogleSheets(false);
    });

    // --- SPOTIFY BACKGROUND MUSIC CONTROLLER ---
    const spotifyUrlInput = document.getElementById('spotifyUrlInput');
    const btnImportSpotify = document.getElementById('btnImportSpotify');
    const btnToggleBgMusic = document.getElementById('btnToggleBgMusic');
    const bgMusicVolume = document.getElementById('bgMusicVolume');

    const SVG_ICONS = {
        play: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
        pause: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>',
        prev: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>',
        next: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
        shuffle: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
        repeat: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
        repeatOne: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="10" y="14" font-size="8" font-weight="900" fill="currentColor" stroke="none">1</text></svg>',
        volume2: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
        volumeX: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
        check: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#00e676" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
        trash: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
        folder: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/></svg>',
        disc: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>',
        music: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
        externalLink: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
        save: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
        zap: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
        rotateCcw: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
        spinner: '<svg class="spin-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>'
    };

    const bgMusicAudio = new Audio('/audio/music.mp3');
    bgMusicAudio.loop = false;
    bgMusicAudio.volume = currentMusicVolume;
    let isBgMusicPlaying = false;
    let isScrubbing = false;
    let currentMusicTrack = null;

    function updatePlayPauseBtn(isPlaying) {
        if (typeof spPlayIcon !== 'undefined' && spPlayIcon) {
            spPlayIcon.innerHTML = isPlaying ? SVG_ICONS.pause : SVG_ICONS.play;
        }
    }

    function updateVolumeMuteUI() {
        if (!btnToggleBgMusic) return;
        const isMuted = bgMusicAudio.muted || bgMusicAudio.volume === 0 || currentMusicVolume === 0;
        btnToggleBgMusic.innerHTML = isMuted ? SVG_ICONS.volumeX : SVG_ICONS.volume2;
        btnToggleBgMusic.title = isMuted ? "Unmute" : "Mute";
    }

    function startBgMusic() {
        if (!isBgMusicPlaying && bgMusicAudio) {
            bgMusicAudio.play().then(() => {
                isBgMusicPlaying = true;
                updateVolumeMuteUI();
                updatePlayPauseBtn(true);
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
            updateVolumeMuteUI();
            updatePlayPauseBtn(true);
        }).catch(err => console.log("Track play error:", err));
    }

    // Auto-start background music on first user interaction
    document.addEventListener('click', () => {
        if (!isBgMusicPlaying) startBgMusic();
    }, { once: true });

    if (btnToggleBgMusic) {
        btnToggleBgMusic.addEventListener('click', () => {
            if (currentMusicVolume === 0) {
                updateMusicVolume(0.35);
                if (!isBgMusicPlaying) startBgMusic();
            } else {
                bgMusicAudio.muted = !bgMusicAudio.muted;
                updateVolumeMuteUI();
            }
        });
    }

    if (bgMusicVolume) {
        bgMusicVolume.value = currentMusicVolume;
        bgMusicVolume.addEventListener('input', (e) => {
            const vol = parseFloat(e.target.value);
            updateMusicVolume(vol);
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
                alert("Please paste a valid Spotify track URL or enter a song title.");
                return;
            }

            btnImportSpotify.disabled = true;
            btnImportSpotify.innerHTML = '<span>Downloading...</span>';
            showStatusNotice("Downloading Spotify Track in High Quality (320kbps)...");

            try {
                const res = await fetch('/api/spotify-import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: url })
                });

                const data = await res.json();
                if (data.success) {
                    showStatusNotice(data.message || "Spotify track imported successfully.");
                    setTimeout(hideStatusNotice, 3000);

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
                btnImportSpotify.innerHTML = '<span>Import Spotify</span>';
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

                    showStatusNotice(`Downloading "${plName}" (${idx}/${total}): ${curTrack}`);
                    loadMusicPlaylist();
                } else if (data.completed) {
                    clearInterval(playlistPollInterval);
                    playlistPollInterval = null;
                    showStatusNotice(`Playlist "${data.playlist_name || 'Imported'}" Complete`);
                    loadMusicPlaylist();
                    setTimeout(hideStatusNotice, 3000);
                } else if (data.error) {
                    clearInterval(playlistPollInterval);
                    playlistPollInterval = null;
                    showStatusNotice(`Playlist Error: ${data.error}`);
                    alert("Playlist Import Error: " + data.error);
                    setTimeout(hideStatusNotice, 3000);
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
                alert("Please paste a valid YouTube URL or song name.");
                return;
            }

            logUserAction("Imported YouTube track/playlist", url);
            btnImportYoutube.disabled = true;
            btnImportYoutube.innerHTML = '<span>Downloading...</span>';
            showStatusNotice("Processing YouTube Import...");

            try {
                const res = await fetch('/api/youtube-import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                const data = await res.json();
                if (data.success) {
                    if (data.is_playlist) {
                        showStatusNotice("Started importing YouTube Playlist...");
                        if (youtubeUrlInput) youtubeUrlInput.value = '';
                        startPlaylistImportPolling();
                    } else {
                        showStatusNotice(data.message || "YouTube track imported.");
                        setTimeout(hideStatusNotice, 3000);
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
                btnImportYoutube.innerHTML = '<span>Import YouTube</span>';
            }
        });
    }

    const btnUploadLocalMp3 = document.getElementById('btnUploadLocalMp3');
    const localMp3FileInput = document.getElementById('localMp3FileInput');
    if (btnUploadLocalMp3) {
        btnUploadLocalMp3.addEventListener('click', async () => {
            if (!localMp3FileInput || !localMp3FileInput.files || localMp3FileInput.files.length === 0) {
                alert("Please select an audio file to upload.");
                return;
            }

            const file = localMp3FileInput.files[0];
            const formData = new FormData();
            formData.append('file', file);

            btnUploadLocalMp3.disabled = true;
            btnUploadLocalMp3.innerHTML = '<span>Uploading...</span>';
            showStatusNotice("Uploading Custom MP3 Track...");

            try {
                const res = await fetch('/api/music/upload', {
                    method: 'POST',
                    body: formData
                });
                const data = await res.json();
                if (data.success) {
                    showStatusNotice(data.message || "Audio file uploaded.");
                    setTimeout(hideStatusNotice, 3000);
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
                btnUploadLocalMp3.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${SVG_ICONS.folder} Upload MP3</span>`;
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
            const color = src === 'youtube' ? '#ff4d4d' : (src === 'custom' ? '#00e676' : '#1db954');
            const sourceLabel = src === 'youtube' ? 'YouTube' : (src === 'custom' ? 'Local MP3' : 'Spotify');
            playlistGroups.push({
                id: `pl_${plName.replace(/\s+/g, '_')}`,
                name: plName,
                raw_playlist_name: plName,
                source: src,
                sourceLabel: sourceLabel,
                color: color,
                tracks: tracks
            });
        });

        // Default source collections
        playlistGroups.push(
            { id: 'spotify_all', name: 'Spotify Collection', source: 'spotify', sourceLabel: 'Spotify', color: '#1db954', tracks: currentMusicLibraryTracks.filter(t => (t.source || 'spotify') === 'spotify') },
            { id: 'youtube_all', name: 'YouTube Mix', source: 'youtube', sourceLabel: 'YouTube', color: '#ff4d4d', tracks: currentMusicLibraryTracks.filter(t => t.source === 'youtube') },
            { id: 'custom_all', name: 'Local MP3 Collection', source: 'custom', sourceLabel: 'Local MP3', color: '#00e676', tracks: currentMusicLibraryTracks.filter(t => t.source === 'custom') }
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
            card.style.border = `1px solid ${hasActive ? pl.color : 'rgba(255,255,255,0.08)'}`;

            card.innerHTML = `
                <div>
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 0.72rem; letter-spacing: 0.04em; text-transform: uppercase; font-weight: 700; color: ${pl.color}; background: rgba(255,255,255,0.05); padding: 2px 7px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.08);">${pl.sourceLabel}</span>
                        <span class="badge" style="background: rgba(255,255,255,0.08); color: var(--text-main); font-size: 0.72rem; font-family: var(--font-mono, monospace);">${pl.tracks.length} Tracks</span>
                    </div>
                    <h4 style="margin: 10px 0 4px 0; font-size: 0.92rem; font-weight: 600; color: #fff;">${pl.name}</h4>
                    <p style="margin: 0; font-size: 0.75rem; color: var(--text-muted); line-height: 1.4;">${pl.tracks.slice(0, 2).map(t => t.title).join(', ')}${pl.tracks.length > 2 ? '...' : ''}</p>
                    <button type="button" class="playlist-open" aria-label="View ${pl.name} tracklist">${SVG_ICONS.externalLink} View tracklist</button>
                </div>
                <div style="display: flex; gap: 6px; margin-top: 6px;">
                    <button class="btn btn-secondary btn-sm btn-play-playlist" data-id="${pl.tracks[0].id}" style="flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-color: ${pl.color}; color: ${pl.color}; font-size: 0.75rem; padding: 5px 8px;">
                        ${SVG_ICONS.play} Play
                    </button>
                    ${pl.raw_playlist_name ? `<button class="btn btn-secondary btn-sm btn-del-playlist" data-name="${pl.raw_playlist_name}" style="display: inline-flex; align-items: center; justify-content: center; gap: 4px; border-color: rgba(255,77,77,0.4); color: #ff6b6b; font-size: 0.75rem; padding: 5px 8px;" title="Delete Playlist & All Songs">${SVG_ICONS.trash}</button>` : ''}
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
                if (confirm(`Delete playlist "${plName}" and permanently remove all ${pl.tracks.length} songs in it?`)) {
                    logUserAction("Deleted Playlist & All Songs", plName);
                    showStatusNotice(`Deleting playlist "${plName}"...`);
                    try {
                        const res = await fetch(`/api/music/playlist/${encodeURIComponent(plName)}`, { method: 'DELETE' });
                        const data = await res.json();
                        if (data.success) {
                            showStatusNotice(`Playlist "${plName}" and ${data.deleted_count} songs deleted.`);
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

        if (plModalIcon) plModalIcon.innerHTML = SVG_ICONS.disc;
        if (plModalTitle) plModalTitle.textContent = plGroup.name;
        if (plModalSub) plModalSub.textContent = `${plGroup.tracks.length} Tracks in Playlist • Click any track to play`;

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
            if (confirm(`Delete playlist "${plName}" and permanently remove all ${count} tracks in it?`)) {
                logUserAction("Deleted Playlist & All Songs", plName);
                closePlaylistModal();
                showStatusNotice(`Deleting playlist "${plName}"...`);
                try {
                    const res = await fetch(`/api/music/playlist/${encodeURIComponent(plName)}`, { method: 'DELETE' });
                    const data = await res.json();
                    if (data.success) {
                        showStatusNotice(`Playlist "${plName}" and ${data.deleted_count} tracks deleted.`);
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
            playlistModalTracksContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 12px;">No matching tracks found in this playlist.</div>`;
            return;
        }

        tracks.forEach(track => {
            const sourceBadge = track.source === 'youtube'
                ? '<span style="font-size:0.68rem; letter-spacing:0.04em; text-transform:uppercase; color:#ff5252; font-weight:700; background:rgba(255,82,82,0.12); border:1px solid rgba(255,82,82,0.25); padding:2px 6px; border-radius:4px;">YouTube</span>'
                : (track.source === 'custom'
                    ? '<span style="font-size:0.68rem; letter-spacing:0.04em; text-transform:uppercase; color:#00e676; font-weight:700; background:rgba(0,230,118,0.12); border:1px solid rgba(0,230,118,0.25); padding:2px 6px; border-radius:4px;">Local MP3</span>'
                    : '<span style="font-size:0.68rem; letter-spacing:0.04em; text-transform:uppercase; color:#1db954; font-weight:700; background:rgba(29,185,84,0.12); border:1px solid rgba(29,185,84,0.25); padding:2px 6px; border-radius:4px;">Spotify</span>');

            const item = document.createElement('div');
            item.className = `playlist-item ${track.is_active ? 'active-track' : ''}`;
            item.style.cursor = 'pointer';
            item.innerHTML = `
                <div class="playlist-item-info" style="display:flex; align-items:center; gap:8px; flex:1; overflow:hidden;">
                    ${sourceBadge}
                    <span class="playlist-item-title" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600;">${track.title}</span>
                    ${track.is_active ? '<span class="playlist-active-tag" style="display:inline-flex; align-items:center; gap:4px; font-size:0.7rem; font-weight:700; color:#00e676;"><span class="active-dot"></span> Active</span>' : ''}
                </div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    ${!track.is_active ? `<button class="btn btn-secondary btn-sm btn-select-modal-track" data-id="${track.id}" style="display:inline-flex; align-items:center; gap:4px; font-size:0.72rem; padding: 3px 8px;">${SVG_ICONS.play} Select</button>` : '<span style="font-size:0.72rem; color:#00e676; font-weight:700;">Playing</span>'}
                    <button class="btn btn-secondary btn-sm btn-del-modal-track" data-id="${track.id}" style="display:inline-flex; align-items:center; justify-content:center; font-size:0.75rem; padding: 4px 6px;" title="Delete Track">${SVG_ICONS.trash}</button>
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
    let repeatMode = 'all'; // 'off' | 'all' | 'one'
    let shuffleHistory = [];
    let currentTrackIndex = -1;

    function updateSpotifyPlayerUI(track) {
        if (!track) return;
        currentMusicTrack = track;
        if (playerTrackTitle) playerTrackTitle.textContent = track.title || 'Unknown Title';
        if (playerTrackArtist) playerTrackArtist.textContent = track.source_url || (track.source === 'youtube' ? 'YouTube Audio' : track.source === 'custom' ? 'Local Audio File' : 'Spotify Music');
        if (playerSourceTag) {
            const src = track.source || 'spotify';
            const label = src === 'youtube' ? 'YouTube' : (src === 'custom' ? 'Local MP3' : 'Spotify');
            const dotColor = src === 'youtube' ? '#ef4444' : (src === 'custom' ? '#00e676' : '#1db954');
            playerSourceTag.innerHTML = `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${dotColor};margin-right:5px;vertical-align:middle;"></span>${label}`;
        }
    }

    if (playerBtnPlayPause) {
        playerBtnPlayPause.addEventListener('click', () => {
            if (isBgMusicPlaying) {
                bgMusicAudio.pause();
                isBgMusicPlaying = false;
                updatePlayPauseBtn(false);
            } else {
                startBgMusic();
            }
        });
    }

    const playerModeStatusBadge = document.getElementById('playerModeStatusBadge');

    function updatePlayerModeBadge() {
        if (!playerModeStatusBadge) return;
        let badgeText = '';
        let badgeClass = 'player-mode-badge';

        if (isShuffleOn && repeatMode !== 'off') {
            badgeText = `Shuffle + Repeat ${repeatMode === 'one' ? '1' : 'All'}`;
            badgeClass += ' mode-both';
        } else if (isShuffleOn) {
            badgeText = 'Shuffle ON';
            badgeClass += ' mode-shuffle';
        } else if (repeatMode === 'one') {
            badgeText = 'Repeat 1 Track';
            badgeClass += ' mode-repeat';
        } else if (repeatMode === 'all') {
            badgeText = 'Repeat Queue';
            badgeClass += ' mode-repeat';
        }

        playerModeStatusBadge.textContent = badgeText;
        playerModeStatusBadge.className = badgeClass;
    }

    if (playerBtnShuffle) {
        playerBtnShuffle.addEventListener('click', () => {
            isShuffleOn = !isShuffleOn;
            playerBtnShuffle.classList.toggle('active-control', isShuffleOn);
            shuffleHistory = [];
            updatePlayerModeBadge();
        });
    }

    if (playerBtnRepeat) {
        playerBtnRepeat.addEventListener('click', () => {
            if (repeatMode === 'all') {
                repeatMode = 'one';
                playerBtnRepeat.classList.add('active-control');
                playerBtnRepeat.innerHTML = SVG_ICONS.repeatOne;
                playerBtnRepeat.title = 'Repeat: One Track';
                bgMusicAudio.loop = true;
            } else if (repeatMode === 'one') {
                repeatMode = 'off';
                playerBtnRepeat.classList.remove('active-control');
                playerBtnRepeat.innerHTML = SVG_ICONS.repeat;
                playerBtnRepeat.title = 'Repeat: OFF';
                bgMusicAudio.loop = false;
            } else {
                repeatMode = 'all';
                playerBtnRepeat.classList.add('active-control');
                playerBtnRepeat.innerHTML = SVG_ICONS.repeat;
                playerBtnRepeat.title = 'Repeat: Entire Queue';
                bgMusicAudio.loop = false;
            }
            updatePlayerModeBadge();
        });
    }

    if (playerBtnPrev) {
        playerBtnPrev.addEventListener('click', () => {
            if (bgMusicAudio && bgMusicAudio.currentTime > 3.0) {
                bgMusicAudio.currentTime = 0;
                if (!isBgMusicPlaying) startBgMusic();
            } else {
                playNeighborTrack(-1);
            }
        });
    }

    if (playerBtnNext) {
        playerBtnNext.addEventListener('click', () => playNeighborTrack(1));
    }

    function playTrack(track, autoplay = true) {
        if (!track) return;
        currentMusicTrack = track;
        currentTrackIndex = currentMusicLibraryTracks.findIndex(t => t.id == track.id);
        currentMusicLibraryTracks.forEach(t => {
            t.is_active = (t.id == track.id) ? 1 : 0;
        });

        updateSpotifyPlayerUI(track);

        if (musicPlaylistContainer) {
            musicPlaylistContainer.querySelectorAll('.playlist-item').forEach(el => {
                const delBtn = el.querySelector('.btn-del-track');
                const selBtn = el.querySelector('.btn-select-track');
                const id = delBtn ? delBtn.getAttribute('data-id') : null;
                const isThisActive = (id == track.id);
                el.classList.toggle('active-track', isThisActive);

                const infoDiv = el.querySelector('.playlist-item-info');
                if (infoDiv) {
                    const existingTag = infoDiv.querySelector('.playlist-active-tag');
                    if (isThisActive && !existingTag) {
                        const tag = document.createElement('span');
                        tag.className = 'playlist-active-tag';
                        tag.innerHTML = '<span class="active-dot"></span> Active';
                        infoDiv.appendChild(tag);
                    } else if (!isThisActive && existingTag) {
                        existingTag.remove();
                    }
                }

                if (selBtn) {
                    selBtn.style.display = isThisActive ? 'none' : 'inline-flex';
                }
            });
        }

        const audioUrl = track.filename
            ? `/audio/music_library/${encodeURIComponent(track.filename)}`
            : `/audio/music.mp3?t=${Date.now()}`;

        if (autoplay) {
            playNewTrackSource(audioUrl);
        } else {
            bgMusicAudio.src = audioUrl;
        }

        // Persist active selection to database in background
        fetch(`/api/music/select-track/${track.id}`, { method: 'POST' }).catch(() => {});
    }

    function playNeighborTrack(offset) {
        if (!currentMusicLibraryTracks || currentMusicLibraryTracks.length === 0) return;

        let curIdx = currentTrackIndex;
        if (curIdx < 0) {
            curIdx = currentMusicLibraryTracks.findIndex(t => t.is_active);
            if (curIdx < 0) curIdx = 0;
        }

        let nextIdx;
        if (isShuffleOn && offset > 0) {
            shuffleHistory.push(curIdx);
            if (shuffleHistory.length > 50) shuffleHistory.shift();
            if (currentMusicLibraryTracks.length > 1) {
                do {
                    nextIdx = Math.floor(Math.random() * currentMusicLibraryTracks.length);
                } while (nextIdx === curIdx && currentMusicLibraryTracks.length > 1);
            } else {
                nextIdx = 0;
            }
        } else if (isShuffleOn && offset < 0 && shuffleHistory.length > 0) {
            nextIdx = shuffleHistory.pop();
        } else {
            nextIdx = curIdx + offset;
            if (nextIdx < 0) nextIdx = currentMusicLibraryTracks.length - 1;
            if (nextIdx >= currentMusicLibraryTracks.length) nextIdx = 0;
        }

        const targetTrack = currentMusicLibraryTracks[nextIdx];
        if (targetTrack) {
            playTrack(targetTrack, true);
        }
    }

    function formatTime(sec) {
        if (isNaN(sec) || sec <= 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    if (bgMusicAudio) {
        bgMusicAudio.addEventListener('play', () => {
            isBgMusicPlaying = true;
            updatePlayPauseBtn(true);
        });
        bgMusicAudio.addEventListener('pause', () => {
            isBgMusicPlaying = false;
            updatePlayPauseBtn(false);
        });
        bgMusicAudio.addEventListener('volumechange', () => {
            updateVolumeMuteUI();
        });
        bgMusicAudio.addEventListener('timeupdate', () => {
            if (!bgMusicAudio.duration) return;
            const cur = bgMusicAudio.currentTime;
            const dur = bgMusicAudio.duration;
            const pct = (cur / dur) * 100;

            if (playerCurrentTime) playerCurrentTime.textContent = formatTime(cur);
            if (playerTotalDuration) playerTotalDuration.textContent = formatTime(dur);
            if (spScrubberFill) spScrubberFill.style.width = `${pct}%`;
            if (playerScrubber && !isScrubbing) playerScrubber.value = pct;
        });

        bgMusicAudio.addEventListener('ended', () => {
            if (repeatMode === 'one') {
                bgMusicAudio.currentTime = 0;
                bgMusicAudio.play();
            } else if (repeatMode === 'all') {
                playNeighborTrack(1);
            } else {
                const curIdx = currentTrackIndex >= 0 ? currentTrackIndex : currentMusicLibraryTracks.findIndex(t => t.is_active);
                if (curIdx < currentMusicLibraryTracks.length - 1) {
                    playNeighborTrack(1);
                } else {
                    isBgMusicPlaying = false;
                    updatePlayPauseBtn(false);
                }
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
                const activeTrack = currentMusicLibraryTracks.find(t => t.is_active) || currentMusicLibraryTracks[0];
                if (activeTrack) {
                    currentMusicTrack = activeTrack;
                    currentTrackIndex = currentMusicLibraryTracks.findIndex(t => t.id === activeTrack.id);
                    updateSpotifyPlayerUI(activeTrack);
                }
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
            musicPlaylistContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 16px;">No matching tracks found. Try adjusting your search query or import a track.</div>`;
            return;
        }

        const activeTrack = tracks.find(t => t.is_active);
        const otherTracks = tracks.filter(t => !t.is_active).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        const sortedTracks = activeTrack ? [activeTrack, ...otherTracks] : otherTracks;

        sortedTracks.forEach(track => {
            const isAct = !!track.is_active;
            const src = track.source || 'spotify';
            const srcColor = src === 'youtube' ? '#ef4444' : (src === 'custom' ? '#00e676' : '#1db954');
            const srcLabel = src === 'youtube' ? 'YouTube' : (src === 'custom' ? 'MP3' : 'Spotify');

            const item = document.createElement('div');
            item.className = `playlist-item ${isAct ? 'active-track' : ''}`;
            item.innerHTML = `
                <div class="playlist-item-info" style="display:flex; align-items:center; gap:10px; flex:1; overflow:hidden;">
                    <span style="display:inline-flex; align-items:center; gap:4px; font-size:0.68rem; color:${srcColor}; background:rgba(255,255,255,0.05); padding:2px 8px; border-radius:4px; font-weight:600; border:1px solid rgba(255,255,255,0.06);">
                        <span style="width:5px; height:5px; border-radius:50%; background:${srcColor};"></span>
                        ${srcLabel}
                    </span>
                    <span class="playlist-item-title" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:500; font-size:0.82rem;">${track.title}</span>
                    ${isAct ? '<span class="playlist-active-tag"><span class="active-dot"></span> Active</span>' : ''}
                </div>
                <div style="display:flex; gap:6px; align-items:center;">
                    <button class="btn btn-secondary btn-sm btn-select-track" data-id="${track.id}" style="font-size:0.75rem; padding:3px 10px; ${isAct ? 'display:none;' : ''}">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="margin-right:4px;"><path d="M8 5v14l11-7z"/></svg> Play
                    </button>
                    <button class="btn btn-secondary btn-sm btn-del-track" data-id="${track.id}" title="Delete Track" style="font-size:0.75rem; padding:4px 7px;">
                        ${SVG_ICONS.trash}
                    </button>
                </div>
            `;
            musicPlaylistContainer.appendChild(item);
        });

        musicPlaylistContainer.querySelectorAll('.btn-select-track').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                const target = currentMusicLibraryTracks.find(t => t.id == id);
                if (target) playTrack(target, true);
            });
        });

        musicPlaylistContainer.querySelectorAll('.btn-del-track').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                if (confirm("Delete this track from playlist library?")) {
                    await fetch(`/api/music/library/${id}`, { method: 'DELETE' });
                    loadMusicPlaylist();
                }
            });
        });
    }

    async function selectTrackById(id) {
        const target = currentMusicLibraryTracks.find(t => t.id == id);
        if (target) {
            playTrack(target, true);
        } else {
            const res = await fetch(`/api/music/select-track/${id}`, { method: 'POST' });
            const data = await res.json();
            if (data.success && data.track) {
                playTrack(data.track, true);
            }
        }
    }

    if (btnRefreshPlaylist) {
        btnRefreshPlaylist.addEventListener('click', loadMusicPlaylist);
    }

    // --- CLOUD & DATABASE CONFIGURATION HANDLERS ---
    const APPS_SCRIPT_SOURCE = `// =====================================================================
// PSSC PhotoBooth 3.0 - Google Sheets & Google Drive Live Sync Webhook
// =====================================================================

var DRIVE_FOLDER_ID = "1RVezpDehiH95Be-shltRgJhUAZsuNcrk";

// Color Palette for Status Badges (Green for Paid/Given, Red for Unpaid/Not Given)
var COLOR_GREEN_BG = "#d1e7dd";     // Soft Green
var COLOR_GREEN_TXT = "#0f5132";    // Dark Green
var COLOR_RED_BG = "#f8d7da";       // Soft Red
var COLOR_RED_TXT = "#842029";      // Dark Red

/**
 * ⚡ CRITICAL: 1-CLICK AUTHORIZATION & CONNECTION TEST FUNCTION
 * Follow these quick steps to fix "Tinanggihang bigyan ng access: DriveApp":
 * 1. In Apps Script top toolbar, choose 'authorizeAndTestDrive' in the function dropdown.
 * 2. Click the 'Run' (or 'Patakbuhin' ▶️) button.
 * 3. When prompted: Click 'Review permissions' -> Choose Account -> 'Advanced' -> 'Go to project (unsafe)' -> 'Allow' (Payagan).
 * 4. Check the Execution log below: It will print '✅ Google Drive Authorized Successfully!'
 * 5. After that, click: Deploy -> Manage deployments -> Edit (✏️) -> Version: 'New version' -> Deploy!
 */
function authorizeAndTestDrive() {
  SpreadsheetApp.getActiveSpreadsheet();
  var folder = getBoothUploadFolder(DRIVE_FOLDER_ID);
  var testFile = folder.createFile("PSSC_Auth_Test.txt", "PSSC PhotoBooth Drive connection test successful at " + new Date());
  var url = testFile.getUrl();
  testFile.setTrashed(true);
  Logger.log("✅ Google Drive Authorized Successfully!");
  Logger.log("📁 Upload folder ready: " + folder.getName() + " (ID: " + folder.getId() + ")");
  Logger.log("🎉 ALL PERMISSIONS GRANTED! Now Deploy a New Version.");
  return "SUCCESS: Google Drive is fully authorized and working!";
}

/**
 * Helper to get or safely create the photobooth upload folder in Google Drive.
 * Automatically tests write permission to prevent read-only folder errors.
 */
function getBoothUploadFolder(preferredFolderId) {
  var folder = null;
  if (preferredFolderId && preferredFolderId !== "YOUR_DRIVE_FOLDER_ID" && preferredFolderId !== "-") {
    try {
      var candidate = DriveApp.getFolderById(preferredFolderId);
      // Verify we have write/create permission in this folder
      var probe = candidate.createFile("_probe_perm.tmp", "test");
      probe.setTrashed(true);
      folder = candidate;
    } catch (e) {
      Logger.log("Candidate folder is read-only or inaccessible, falling back to user's Drive folder: " + e);
      folder = null;
    }
  }
  if (!folder) {
    var folders = DriveApp.getFoldersByName("PSSC PhotoBooth Uploads");
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = DriveApp.createFolder("PSSC PhotoBooth Uploads");
      try {
        folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (e) {}
    }
  }
  return folder;
}

/**
 * Helper to get or safely create the dedicated session folder inside the main Drive folder.
 * Folder name includes: Guest Name, Queue #, and Date & Time.
 */
function getOrCreateSessionFolder(parentFolder, sessionFolderName) {
  if (!sessionFolderName) return parentFolder;
  var folders = parentFolder.getFoldersByName(sessionFolderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  var newFolder = parentFolder.createFolder(sessionFolderName);
  try {
    newFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {}
  return newFolder;
}

/**
 * Helper to save a base64 encoded file into a Google Drive folder.
 */
function saveFileToFolder(folder, base64Data, filename, mimeType) {
  if (!base64Data || base64Data.length < 20) return null;
  var cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
  var decodedBytes = Utilities.base64Decode(cleanBase64);
  var blob = Utilities.newBlob(decodedBytes, mimeType || "application/octet-stream", filename);
  var file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {}
  return file;
}

function doPost(e) {
  try {
    var rawData = e.postData.contents;
    var data = JSON.parse(rawData);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    
    ensureHeadersAndRules(sheet);

    // 1. ACTION: Test Drive Permission (runs cleanly without modifying rows)
    if (data.action === "test_drive_permission") {
      var testDriveUrl = "-";
      try {
        var folder = getBoothUploadFolder(data.folder_id || DRIVE_FOLDER_ID);
        var cleanB64 = (data.image_base64 || "").replace(/^data:image\/[a-zA-Z0-9]+;base64,/, "");
        var decoded = Utilities.base64Decode(cleanB64);
        var blob = Utilities.newBlob(decoded, "image/png", "PSSC_Auth_Test.png");
        var testFile = folder.createFile(blob);
        try { testFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (sErr) {}
        testDriveUrl = testFile.getUrl();
        testFile.setTrashed(true);
        return createJsonResponse({
          success: true,
          message: "Google Drive is fully authorized and working!",
          folder: folder.getName(),
          drive_url: testDriveUrl
        });
      } catch (dErr) {
        return createJsonResponse({
          success: false,
          drive_url: "Drive Error: " + dErr.toString(),
          error: dErr.toString()
        });
      }
    }

    // 2. ACTION: Reset Queue
    if (data.action === "reset_queue" || data.action === "RESET_QUEUE" || data.event === "RESET_QUEUE") {
      sheet.appendRow([
        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss"),
        "RESET",
        "--- Queue Reset to #" + (data.new_queue_number || data.start_number || 1) + " ---",
        "-",
        "-",
        "-"
      ]);
      return createJsonResponse({ success: true, message: "Queue reset logged" });
    }

    // 3. ACTION: Update Status (Triggered when clicked in Photobooth Gallery)
    if (data.action === "update_status") {
      var targetQueue = data.queue_number;
      var paid = data.paid;
      var given = data.given;
      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();
      
      for (var i = 1; i < values.length; i++) {
        var rowQ = values[i][1];
        var rowQClean = String(rowQ).replace(/[^0-9]/g, '');
        var targetClean = String(targetQueue).replace(/[^0-9]/g, '');
        
        if (rowQClean === targetClean && targetClean.length > 0) {
          var rowIdx = i + 1;
          if (paid !== undefined && paid !== null) {
            var cellPaid = sheet.getRange(rowIdx, 4);
            cellPaid.setValue(paid);
            applyCellColor(cellPaid, paid);
          }
          if (given !== undefined && given !== null) {
            var cellGiven = sheet.getRange(rowIdx, 5);
            cellGiven.setValue(given);
            applyCellColor(cellGiven, given);
          }
          return createJsonResponse({
            success: true,
            message: "Row updated for Queue #" + targetClean,
            queue_number: targetClean,
            paid: paid,
            given: given
          });
        }
      }
      return createJsonResponse({ success: false, message: "Queue #" + targetQueue + " not found in sheet" });
    }

    // 4. ACTION: Upload Single Session File (e.g. RAW Video or RAW Photo) into Dedicated Session Folder
    if (data.action === "upload_session_file" || data.action === "upload_file") {
      var parentFolder = getBoothUploadFolder(data.folder_id || DRIVE_FOLDER_ID);
      var targetFolder = parentFolder;
      if (data.session_folder_name) {
        targetFolder = getOrCreateSessionFolder(parentFolder, data.session_folder_name);
      }
      var filename = data.filename || ("Queue_" + (data.queue_number || "") + "_File.bin");
      var file = saveFileToFolder(targetFolder, data.file_base64 || data.image_base64, filename, data.mime_type || "video/mp4");
      var fileUrl = file ? file.getUrl() : "-";
      return createJsonResponse({
        success: true,
        filename: filename,
        file_url: fileUrl,
        folder_url: targetFolder.getUrl()
      });
    }

    // 5. ACTION: Re-upload / Backfill Photo to Google Drive & Update Row
    if (data.action === "reupload_photo" || data.action === "upload_photo") {
      var targetQueue = data.queue_number;
      var parentFolder = getBoothUploadFolder(data.folder_id || DRIVE_FOLDER_ID);
      var targetFolder = parentFolder;
      if (data.session_folder_name) {
        targetFolder = getOrCreateSessionFolder(parentFolder, data.session_folder_name);
      }
      var filename = data.filename || ("PSSC_Q" + targetQueue + "_Repaired.png");
      var file = saveFileToFolder(targetFolder, data.image_base64, filename, "image/png");
      var newDriveUrl = targetFolder.getUrl();
      
      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();
      var updatedRow = -1;
      for (var i = 1; i < values.length; i++) {
        var rowQClean = String(values[i][1]).replace(/[^0-9]/g, '');
        var targetClean = String(targetQueue).replace(/[^0-9]/g, '');
        if (rowQClean === targetClean && targetClean.length > 0) {
          updatedRow = i + 1;
          sheet.getRange(updatedRow, 6).setValue(newDriveUrl);
          break;
        }
      }
      return createJsonResponse({
        success: true,
        message: "Session photo re-uploaded to Drive successfully!",
        queue_number: targetQueue,
        drive_url: newDriveUrl,
        row_updated: updatedRow
      });
    }

    // 6. ACTION: Get All Statuses (Allows Photobooth to pull edits made in Google Sheets)
    if (data.action === "get_all_statuses") {
      return createJsonResponse(getAllStatuses(sheet));
    }

    // 7. DEFAULT: Log Session & Upload Dedicated Session Package to Google Drive
    var dateStr = data.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss");
    var queueNum = data.queue_number || sheet.getLastRow();
    var guestName = data.name || "Guest";
    var paidStatus = data.paid || "Paid";
    var givenStatus = data.given || "Not Given";
    var parentFolder = getBoothUploadFolder(data.folder_id || DRIVE_FOLDER_ID);

    // Dedicated Session Folder: includes Name, Queue Number, and Date & Time
    var sessionFolderName = data.session_folder_name;
    if (!sessionFolderName) {
      sessionFolderName = "Queue #" + queueNum + " - " + guestName + " - " + dateStr.replace(/[\/:]/g, "-");
    }

    var sessionFolder = getOrCreateSessionFolder(parentFolder, sessionFolderName);
    var sessionFolderUrl = sessionFolder.getUrl();
    var primaryDriveUrl = sessionFolderUrl; // Links directly to the session folder with final ticket, raw photos, and video!

    // 1. Upload Final Ticket Strip into Session Folder
    var filename = data.filename || ("Queue_" + queueNum + "_" + guestName + "_Final_Strip.png");
    if (data.image_base64 && data.image_base64.length > 50) {
      try {
        saveFileToFolder(sessionFolder, data.image_base64, filename, "image/png");
      } catch (driveErr) {
        Logger.log("Final strip upload error: " + driveErr.toString());
      }
    }

    // 2. Upload RAW Photos into Session Folder
    if (data.raw_photos && Array.isArray(data.raw_photos)) {
      for (var p = 0; p < data.raw_photos.length; p++) {
        try {
          var rPhoto = data.raw_photos[p];
          var rName = rPhoto.filename || ("Queue_" + queueNum + "_" + guestName + "_Photo_" + (p + 1) + "_RAW.png");
          var rB64 = rPhoto.image_base64 || rPhoto.base64 || "";
          saveFileToFolder(sessionFolder, rB64, rName, "image/png");
        } catch (pErr) {
          Logger.log("Raw photo " + p + " upload error: " + pErr.toString());
        }
      }
    }

    // 3. Upload RAW Video into Session Folder (if bundled in payload)
    if (data.video_base64 && data.video_base64.length > 50) {
      try {
        var vName = data.video_filename || ("Queue_" + queueNum + "_" + guestName + "_Live_Recording.mp4");
        var vMime = data.video_mime || "video/mp4";
        saveFileToFolder(sessionFolder, data.video_base64, vName, vMime);
      } catch (vErr) {
        Logger.log("Video upload error: " + vErr.toString());
      }
    }

    // Append Row to Google Sheets (Drive link is the session folder URL containing all assets!)
    sheet.appendRow([
      dateStr,
      "#" + queueNum,
      guestName,
      paidStatus,
      givenStatus,
      primaryDriveUrl
    ]);

    var lastRow = sheet.getLastRow();
    applyRowFormatting(sheet, lastRow, paidStatus, givenStatus);

    return createJsonResponse({
      success: true,
      message: "Session logged to Google Sheets and saved to dedicated session folder in Google Drive!",
      queue: queueNum,
      session_folder_name: sessionFolderName,
      folder_url: sessionFolderUrl,
      drive_url: primaryDriveUrl
    });

  } catch (err) {
    return createJsonResponse({ success: false, error: err.toString() });
  }
}

function doGet(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  ensureHeadersAndRules(sheet);

  if (e && e.parameter && (e.parameter.action === "get_all_statuses" || e.parameter.action === "sync")) {
    return createJsonResponse(getAllStatuses(sheet));
  }

  return createJsonResponse({
    status: "online",
    service: "PSSC PhotoBooth 3.0 Live Sync",
    drive_folder: DRIVE_FOLDER_ID
  });
}

function getAllStatuses(sheet) {
  var dataRange = sheet.getDataRange();
  var values = dataRange.getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var rawQ = values[i][1];
    var qNum = parseInt(String(rawQ).replace(/[^0-9]/g, ''), 10);
    if (!isNaN(qNum) && qNum > 0) {
      rows.push({
        queue_number: qNum,
        guest_name: values[i][2] || "",
        paid: values[i][3] || "Paid",
        given: values[i][4] || "Not Given",
        drive_url: values[i][5] || ""
      });
    }
  }
  return { success: true, count: rows.length, rows: rows };
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ensureHeadersAndRules(sheet) {
  var headers = ["Timestamp", "Queue #", "Guest Name", "Payment Status", "Ticket Status", "Google Drive Photo Link"];
  var currentHeaders = sheet.getLastRow() >= 1 ? sheet.getRange(1, 1, 1, 6).getValues()[0] : [];
  var mismatch = false;
  for (var i = 0; i < headers.length; i++) {
    if (!currentHeaders[i] || String(currentHeaders[i]).trim() !== headers[i]) {
      mismatch = true;
      break;
    }
  }
  if (mismatch || sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground("#0f172a");
    headerRange.setFontColor("#f8fafc");
    headerRange.setFontWeight("bold");
    headerRange.setHorizontalAlignment("center");
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(2, 90);
    sheet.setColumnWidth(3, 160);
    sheet.setColumnWidth(4, 140);
    sheet.setColumnWidth(5, 140);
    sheet.setColumnWidth(6, 320);
  }
  setupConditionalFormatting(sheet);
}

/**
 * 🛠️ 1-CLICK SHEET FORMATTER & REPAIR TOOL
 * Run this function in Apps Script to instantly align headers, clear stray columns, and delete corrupted test rows.
 */
function formatAndCleanMySheet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var headers = ["Timestamp", "Queue #", "Guest Name", "Payment Status", "Ticket Status", "Google Drive Photo Link"];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setBackground("#0f172a");
  headerRange.setFontColor("#f8fafc");
  headerRange.setFontWeight("bold");
  headerRange.setHorizontalAlignment("center");
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 90);
  sheet.setColumnWidth(3, 160);
  sheet.setColumnWidth(4, 140);
  sheet.setColumnWidth(5, 140);
  sheet.setColumnWidth(6, 320);

  // Clear stray columns beyond column 6
  var maxCols = sheet.getMaxColumns();
  if (maxCols > 6) {
    sheet.getRange(1, 7, Math.max(sheet.getLastRow(), 10), maxCols - 6).clear();
  }

  // Delete corrupted test row 2 if it has timestamp pasted across
  if (sheet.getLastRow() >= 2) {
    var valB2 = String(sheet.getRange(2, 2).getValue());
    var valC2 = String(sheet.getRange(2, 3).getValue());
    if (valB2.indexOf('/') !== -1 || valC2.indexOf('/') !== -1) {
      sheet.deleteRow(2);
    }
  }

  setupConditionalFormatting(sheet);
  Logger.log("✅ Google Sheet has been successfully cleaned and aligned!");
  return "SUCCESS: Google Sheet is now pristine and aligned!";
}

function setupConditionalFormatting(sheet) {
  var rules = sheet.getConditionalFormatRules();
  if (rules.length >= 4) return;

  var rangePaid = sheet.getRange("D2:D500");
  var rangeGiven = sheet.getRange("E2:E500");

  var rulePaid = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo("Paid")
    .setBackground(COLOR_GREEN_BG)
    .setFontColor(COLOR_GREEN_TXT)
    .setRanges([rangePaid])
    .build();

  var ruleUnpaid = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo("Not Paid")
    .setBackground(COLOR_RED_BG)
    .setFontColor(COLOR_RED_TXT)
    .setRanges([rangePaid])
    .build();

  var ruleGiven = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo("Given")
    .setBackground(COLOR_GREEN_BG)
    .setFontColor(COLOR_GREEN_TXT)
    .setRanges([rangeGiven])
    .build();

  var ruleNotGiven = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo("Not Given")
    .setBackground(COLOR_RED_BG)
    .setFontColor(COLOR_RED_TXT)
    .setRanges([rangeGiven])
    .build();

  rules.push(rulePaid, ruleUnpaid, ruleGiven, ruleNotGiven);
  sheet.setConditionalFormatRules(rules);
}

function applyCellColor(cell, val) {
  cell.setFontWeight("bold");
  cell.setHorizontalAlignment("center");
  if (val === "Paid" || val === "Given") {
    cell.setBackground(COLOR_GREEN_BG);
    cell.setFontColor(COLOR_GREEN_TXT);
  } else if (val === "Not Paid" || val === "Not Given") {
    cell.setBackground(COLOR_RED_BG);
    cell.setFontColor(COLOR_RED_TXT);
  }
}

function applyRowFormatting(sheet, row, paid, given) {
  var paidRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(["Paid", "Not Paid"], true)
    .setAllowInvalid(false)
    .build();
  var cellPaid = sheet.getRange(row, 4);
  cellPaid.setDataValidation(paidRule);
  applyCellColor(cellPaid, paid);

  var givenRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(["Given", "Not Given"], true)
    .setAllowInvalid(false)
    .build();
  var cellGiven = sheet.getRange(row, 5);
  cellGiven.setDataValidation(givenRule);
  applyCellColor(cellGiven, given);
  
  sheet.getRange(row, 2).setHorizontalAlignment("center");
}`;

    const googleSheetsUrlInput = document.getElementById('googleSheetsUrlInput');
    const googleDriveUrlInput = document.getElementById('googleDriveUrlInput');
    const btnSaveCloudConfig = document.getElementById('btnSaveCloudConfig');
    const btnTestQueueSync = document.getElementById('btnTestQueueSync');
    const topbarQueueText = document.getElementById('topbarQueueText');

    const linkOpenGoogleSheet = document.getElementById('linkOpenGoogleSheet');
    const linkOpenGoogleDrive = document.getElementById('linkOpenGoogleDrive');

    const sheetsGuideModal = document.getElementById('sheetsGuideModal');
    const btnOpenSheetsGuide = document.getElementById('btnOpenSheetsGuide');
    const btnCloseSheetsGuideModal = document.getElementById('btnCloseSheetsGuideModal');
    const btnCloseSheetsGuideModalBtn = document.getElementById('btnCloseSheetsGuideModalBtn');
    const btnCopyAppsScript = document.getElementById('btnCopyAppsScript');
    const appsScriptCodeBlock = document.getElementById('appsScriptCodeBlock');
    const sheetsUrlNoticeBox = document.getElementById('sheetsUrlNoticeBox');

    if (appsScriptCodeBlock) {
        appsScriptCodeBlock.textContent = APPS_SCRIPT_SOURCE;
    }

    function openSheetsGuideModal() {
        if (sheetsGuideModal) sheetsGuideModal.classList.remove('hidden');
    }
    function closeSheetsGuideModal() {
        if (sheetsGuideModal) sheetsGuideModal.classList.add('hidden');
    }

    if (btnOpenSheetsGuide) btnOpenSheetsGuide.addEventListener('click', openSheetsGuideModal);
    if (btnCloseSheetsGuideModal) btnCloseSheetsGuideModal.addEventListener('click', closeSheetsGuideModal);
    if (btnCloseSheetsGuideModalBtn) btnCloseSheetsGuideModalBtn.addEventListener('click', closeSheetsGuideModal);

    if (btnCopyAppsScript) {
        btnCopyAppsScript.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(APPS_SCRIPT_SOURCE);
                btnCopyAppsScript.textContent = "✓ Copied to Clipboard!";
                setTimeout(() => {
                    btnCopyAppsScript.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Script Code`;
                }, 2500);
            } catch (err) {
                alert("Please select and copy the code manually.");
            }
        });
    }

    function checkSheetsUrlFormat() {
        if (!googleSheetsUrlInput || !sheetsUrlNoticeBox) return;
        const val = googleSheetsUrlInput.value.trim();
        if (val.includes('docs.google.com/spreadsheets')) {
            sheetsUrlNoticeBox.style.display = 'block';
        } else {
            sheetsUrlNoticeBox.style.display = 'none';
        }
    }
    if (googleSheetsUrlInput) {
        googleSheetsUrlInput.addEventListener('input', checkSheetsUrlFormat);
    }

    // --- SETTINGS AUDIO & VOLUME CONTROLS (VOICE, MUSIC, SFX) ---
    const voiceVolumeSlider = document.getElementById('voiceVolumeSlider');
    const voiceVolumeBadge = document.getElementById('voiceVolumeBadge');
    const voiceVolumeIcon = document.getElementById('voiceVolumeIcon');
    const btnTestVoiceAudio = document.getElementById('btnTestVoiceAudio');

    const musicVolumeSlider = document.getElementById('musicVolumeSlider');
    const musicVolumeBadge = document.getElementById('musicVolumeBadge');
    const musicVolumeIcon = document.getElementById('musicVolumeIcon');
    const btnToggleMusicPlayback = document.getElementById('btnToggleMusicPlayback');

    const sfxVolumeSlider = document.getElementById('sfxVolumeSlider');
    const sfxVolumeBadge = document.getElementById('sfxVolumeBadge');
    const sfxVolumeIcon = document.getElementById('sfxVolumeIcon');
    const btnTestSfxAudio = document.getElementById('btnTestSfxAudio');
    const btnTestBeepAudio = document.getElementById('btnTestBeepAudio');
    const btnMuteAllAudio = document.getElementById('btnMuteAllAudio');

    function getVolSvg(val) {
        if (val <= 0) {
            return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
        }
        if (val < 0.5) {
            return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
        }
        return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
    }

    function updateVoiceVolume(val, persist = true) {
        currentVoiceVolume = Math.max(0, Math.min(2.0, parseFloat(val) || 0));
        const pct = Math.round(currentVoiceVolume * 100);
        if (voiceVolumeSlider) voiceVolumeSlider.value = pct;
        if (voiceVolumeBadge) {
            voiceVolumeBadge.textContent = `${pct}%`;
            if (pct > 100) {
                voiceVolumeBadge.style.color = '#38bdf8';
                voiceVolumeBadge.style.background = 'rgba(56, 189, 248, 0.22)';
                voiceVolumeBadge.style.boxShadow = '0 0 8px rgba(56, 189, 248, 0.35)';
            } else if (pct > 0) {
                voiceVolumeBadge.style.color = 'var(--cyan)';
                voiceVolumeBadge.style.background = 'rgba(6,182,212,0.14)';
                voiceVolumeBadge.style.boxShadow = 'none';
            } else {
                voiceVolumeBadge.style.color = 'var(--t3)';
                voiceVolumeBadge.style.background = 'rgba(255,255,255,0.06)';
                voiceVolumeBadge.style.boxShadow = 'none';
            }
        }
        if (voiceVolumeIcon) voiceVolumeIcon.innerHTML = getVolSvg(currentVoiceVolume);
        if (activeVoiceInstance && activeVoiceInstance.gainNode) {
            try {
                activeVoiceInstance.gainNode.gain.value = currentVoiceVolume;
            } catch (e) {}
        } else if (activeVoiceInstance && activeVoiceInstance.audio) {
            activeVoiceInstance.audio.volume = Math.max(0, Math.min(1.0, currentVoiceVolume / 2.0));
        } else if (currentVoiceGainNode) {
            try {
                currentVoiceGainNode.gain.value = currentVoiceVolume;
            } catch (e) {}
        } else if (currentAudio) {
            currentAudio.volume = Math.max(0, Math.min(1.0, currentVoiceVolume / 2.0));
        }
        if (persist) {
            localStorage.setItem('pssc_vol_voice', currentVoiceVolume);
            debounceSaveVolumes();
        }
    }

    function updateMusicVolume(val, persist = true) {
        currentMusicVolume = Math.max(0, Math.min(1, parseFloat(val) || 0));
        const pct = Math.round(currentMusicVolume * 100);
        if (musicVolumeSlider) musicVolumeSlider.value = pct;
        if (bgMusicVolume) bgMusicVolume.value = currentMusicVolume;
        if (musicVolumeBadge) {
            musicVolumeBadge.textContent = `${pct}%`;
            musicVolumeBadge.style.color = pct > 0 ? 'var(--g)' : 'var(--t3)';
            musicVolumeBadge.style.background = pct > 0 ? 'var(--gdim)' : 'rgba(255,255,255,0.06)';
        }
        if (musicVolumeIcon) musicVolumeIcon.innerHTML = getVolSvg(currentMusicVolume);
        if (bgMusicAudio) {
            const factor = isAudioDuckingActive ? 0.20 : 1.0;
            bgMusicAudio.volume = currentMusicVolume * factor;
        }
        updateVolumeMuteUI();
        if (persist) {
            localStorage.setItem('pssc_vol_music', currentMusicVolume);
            debounceSaveVolumes();
        }
    }

    function updateSfxVolume(val, persist = true) {
        currentSfxVolume = Math.max(0, Math.min(2.0, parseFloat(val) || 0));
        const pct = Math.round(currentSfxVolume * 100);
        if (sfxVolumeSlider) sfxVolumeSlider.value = pct;
        if (sfxVolumeBadge) {
            sfxVolumeBadge.textContent = `${pct}%`;
            if (pct > 100) {
                sfxVolumeBadge.style.color = '#fbbf24';
                sfxVolumeBadge.style.background = 'rgba(245, 158, 11, 0.25)';
                sfxVolumeBadge.style.boxShadow = '0 0 8px rgba(245, 158, 11, 0.35)';
            } else if (pct > 0) {
                sfxVolumeBadge.style.color = '#f59e0b';
                sfxVolumeBadge.style.background = 'rgba(245, 158, 11, 0.14)';
                sfxVolumeBadge.style.boxShadow = 'none';
            } else {
                sfxVolumeBadge.style.color = 'var(--t3)';
                sfxVolumeBadge.style.background = 'rgba(255,255,255,0.06)';
                sfxVolumeBadge.style.boxShadow = 'none';
            }
        }
        if (sfxVolumeIcon) sfxVolumeIcon.innerHTML = getVolSvg(currentSfxVolume);
        if (persist) {
            localStorage.setItem('pssc_vol_sfx', currentSfxVolume);
            debounceSaveVolumes();
        }
    }

    let saveVolTimer = null;
    function debounceSaveVolumes() {
        clearTimeout(saveVolTimer);
        saveVolTimer = setTimeout(async () => {
            try {
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        volume_voice: currentVoiceVolume,
                        volume_music: currentMusicVolume,
                        volume_sfx: currentSfxVolume
                    })
                });
            } catch (e) {}
        }, 800);
    }

    if (voiceVolumeSlider) {
        voiceVolumeSlider.addEventListener('input', (e) => {
            updateVoiceVolume(parseFloat(e.target.value) / 100);
        });
    }

    if (musicVolumeSlider) {
        musicVolumeSlider.addEventListener('input', (e) => {
            updateMusicVolume(parseFloat(e.target.value) / 100);
        });
    }

    if (sfxVolumeSlider) {
        sfxVolumeSlider.addEventListener('input', (e) => {
            updateSfxVolume(parseFloat(e.target.value) / 100);
        });
    }

    if (btnTestVoiceAudio) {
        btnTestVoiceAudio.addEventListener('click', () => {
            if (currentVoiceVolume === 0) {
                showStatusNotice("Voice volume is 0%. Slide to increase!");
            }
            playAudioCategory('welcome');
        });
    }

    if (btnToggleMusicPlayback) {
        btnToggleMusicPlayback.addEventListener('click', () => {
            if (!bgMusicAudio) return;
            if (bgMusicAudio.paused) {
                if (currentMusicVolume === 0) {
                    showStatusNotice("Music volume is 0%. Slide to increase!");
                }
                bgMusicAudio.play().then(() => {
                    isBgMusicPlaying = true;
                    updatePlayPauseBtn(true);
                    btnToggleMusicPlayback.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> Pause`;
                }).catch(e => console.log(e));
            } else {
                bgMusicAudio.pause();
                isBgMusicPlaying = false;
                updatePlayPauseBtn(false);
                btnToggleMusicPlayback.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Play`;
            }
        });
    }

    if (btnTestSfxAudio) {
        btnTestSfxAudio.addEventListener('click', () => {
            if (currentSfxVolume === 0) {
                showStatusNotice("SFX volume is 0%. Slide to increase!");
            }
            playShutterSound();
        });
    }

    if (btnTestBeepAudio) {
        btnTestBeepAudio.addEventListener('click', () => {
            if (currentSfxVolume === 0) {
                showStatusNotice("SFX volume is 0%. Slide to increase!");
            }
            playBeepSound(880, 0.15);
        });
    }

    if (btnMuteAllAudio) {
        btnMuteAllAudio.addEventListener('click', () => {
            updateVoiceVolume(0);
            updateMusicVolume(0);
            updateSfxVolume(0);
            showStatusNotice("All audio channels muted to 0%.");
        });
    }

    async function loadSystemConfig() {
        try {
            const res = await fetch('/api/config');
            const data = await res.json();
            if (data.success) {
                if (googleSheetsUrlInput) googleSheetsUrlInput.value = data.google_sheets_url || '';
                if (googleDriveUrlInput) googleDriveUrlInput.value = data.google_drive_url || '';
                if (topbarQueueText) topbarQueueText.textContent = data.queue_display || 'Queue #1';
                if (linkOpenGoogleSheet && data.google_sheets_url) linkOpenGoogleSheet.href = data.google_sheets_url;
                if (linkOpenGoogleDrive && data.google_drive_url) linkOpenGoogleDrive.href = data.google_drive_url;
                checkSheetsUrlFormat();

                // Apply volumes (Voice: 200% boosted, Music: 0%, SFX: 200% boosted)
                const vVoice = data.volume_voice !== undefined
                    ? data.volume_voice
                    : (localStorage.getItem('pssc_vol_voice') !== null ? parseFloat(localStorage.getItem('pssc_vol_voice')) : 2.0);
                const vMusic = localStorage.getItem('pssc_vol_music') !== null
                    ? parseFloat(localStorage.getItem('pssc_vol_music'))
                    : (data.volume_music !== undefined ? data.volume_music : 0);
                const vSfx = (data.volume_sfx !== undefined && !isNaN(parseFloat(data.volume_sfx)))
                    ? parseFloat(data.volume_sfx)
                    : (localStorage.getItem('pssc_vol_sfx') !== null && !isNaN(parseFloat(localStorage.getItem('pssc_vol_sfx'))) ? parseFloat(localStorage.getItem('pssc_vol_sfx')) : 2.0);

                updateVoiceVolume(vVoice, false);
                updateMusicVolume(vMusic, false);
                updateSfxVolume(vSfx > 0 ? vSfx : 2.0, false);

                if (data.selected_template_id) {
                    const serverSavedId = String(data.selected_template_id);
                    if (!localStorage.getItem('pssc_selected_template_id')) {
                        localStorage.setItem('pssc_selected_template_id', serverSavedId);
                        if (templates && templates.length > 0) {
                            const match = templates.find(t => String(t.id) === serverSavedId);
                            if (match && (!activeTemplate || activeTemplate.id !== match.id)) {
                                selectTemplate(match);
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error("Config fetch error:", err);
            updateVoiceVolume(currentVoiceVolume, false);
            updateMusicVolume(currentMusicVolume, false);
            updateSfxVolume(currentSfxVolume, false);
        }
    }

    if (btnSaveCloudConfig) {
        btnSaveCloudConfig.addEventListener('click', async () => {
            const sheetsUrl = googleSheetsUrlInput ? googleSheetsUrlInput.value.trim() : '';
            const driveUrl = googleDriveUrlInput ? googleDriveUrlInput.value.trim() : '';

            btnSaveCloudConfig.disabled = true;
            btnSaveCloudConfig.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${SVG_ICONS.spinner} Saving...</span>`;

            try {
                const res = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        google_sheets_url: sheetsUrl,
                        google_drive_url: driveUrl,
                        volume_voice: currentVoiceVolume,
                        volume_music: currentMusicVolume,
                        volume_sfx: currentSfxVolume,
                        selected_template_id: activeTemplate ? activeTemplate.id : undefined
                    })
                });
                const data = await res.json();
                if (data.success) {
                    if (linkOpenGoogleSheet && sheetsUrl) linkOpenGoogleSheet.href = sheetsUrl;
                    if (linkOpenGoogleDrive && driveUrl) linkOpenGoogleDrive.href = driveUrl;
                    checkSheetsUrlFormat();
                    alert("Settings and volume configurations saved successfully.");
                    logUserAction("Saved System Settings", `Sheets, Drive, and Audio Volumes (Voice:${Math.round(currentVoiceVolume*100)}%, Music:${Math.round(currentMusicVolume*100)}%, SFX:${Math.round(currentSfxVolume*100)}%)`);
                } else {
                    alert("Error saving settings: " + (data.error || "Failed to save"));
                }
            } catch (err) {
                alert("Failed to save cloud config: " + err.message);
            } finally {
                btnSaveCloudConfig.disabled = false;
                btnSaveCloudConfig.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${SVG_ICONS.save} Save Settings</span>`;
            }
        });
    }

    if (btnTestQueueSync) {
        btnTestQueueSync.addEventListener('click', async () => {
            const sheetsUrl = googleSheetsUrlInput ? googleSheetsUrlInput.value.trim() : '';
            const driveUrl = googleDriveUrlInput ? googleDriveUrlInput.value.trim() : '';
            if (!sheetsUrl) {
                alert("Please enter a Google Sheets Webhook URL first.");
                return;
            }

            btnTestQueueSync.disabled = true;
            btnTestQueueSync.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${SVG_ICONS.spinner} Testing...</span>`;

            try {
                showStatusNotice("Testing Google Sheets & Drive live sync...");
                const res = await fetch('/api/cloud/test-sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sheets_url: sheetsUrl, drive_url: driveUrl })
                });
                const data = await res.json();
                hideStatusNotice();

                if (data.success) {
                    alert("✅ Success!\n\n" + data.message + "\n\nCheck your Google Sheet! Photos from completed sessions will automatically upload to your Google Drive folder.");
                } else if (data.is_sheet_viewer) {
                    if (confirm("⚠️ Spreadsheet Viewer Link Detected:\n\nGoogle forbids external apps from uploading directly without an Apps Script Web App.\n\nWould you like to open the 2-minute Setup Guide now?")) {
                        openSheetsGuideModal();
                    }
                } else {
                    alert("❌ Connection Test Failed:\n\n" + (data.error || "Unable to reach Google Apps Script webhook"));
                }
            } catch (err) {
                hideStatusNotice();
                alert("Connection Test Error: " + err.message);
            } finally {
                btnTestQueueSync.disabled = false;
                btnTestQueueSync.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${SVG_ICONS.zap} Test Connection</span>`;
            }
        });
    }

    // --- REPAIR / RE-UPLOAD DRIVE LINKS HANDLERS ---
    const btnRepairDriveGallery = document.getElementById('btnRepairDriveGallery');
    const btnRepairDriveSettings = document.getElementById('btnRepairDriveSettings');

    async function handleRepairDriveUploads(btnElement) {
        if (btnElement) {
            btnElement.disabled = true;
            btnElement.dataset.origHtml = btnElement.innerHTML;
            btnElement.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${SVG_ICONS.spinner} Uploading to Drive...</span>`;
        }
        showStatusNotice("Uploading session photos to Google Drive & updating sheet rows...");

        try {
            const res = await fetch('/api/cloud/repair-drive-uploads', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json();
            hideStatusNotice();

            if (data.success) {
                alert(`✅ Drive Repair Complete!\n\n${data.message}\n\nYour Google Sheet rows have been updated with direct photo links.`);
                loadGallery();
            } else {
                alert(`⚠️ Drive Upload Notice:\n\n${data.error || "Unable to upload to Google Drive."}\n\nFix: In Google Apps Script, select 'authorizeAndTestDrive', click Run (Patakbuhin ▶️) to grant Drive permission, then Deploy a New Version.`);
            }
        } catch (err) {
            hideStatusNotice();
            alert("Error repairing Drive uploads: " + err.message);
        } finally {
            if (btnElement) {
                btnElement.disabled = false;
                btnElement.innerHTML = btnElement.dataset.origHtml || "Fix Drive Links";
            }
        }
    }

    if (btnRepairDriveGallery) {
        btnRepairDriveGallery.addEventListener('click', () => handleRepairDriveUploads(btnRepairDriveGallery));
    }
    if (btnRepairDriveSettings) {
        btnRepairDriveSettings.addEventListener('click', () => handleRepairDriveUploads(btnRepairDriveSettings));
    }

    // --- QUEUE RESET HANDLERS ---
    const btnOpenResetQueueModal = document.getElementById('btnOpenResetQueueModal');
    const topbarQueueChip = document.getElementById('topbarQueueChip');
    const resetQueueModal = document.getElementById('resetQueueModal');
    const btnCloseResetQueueModal = document.getElementById('btnCloseResetQueueModal');
    const btnCancelResetQueue = document.getElementById('btnCancelResetQueue');
    const btnConfirmResetQueue = document.getElementById('btnConfirmResetQueue');
    const resetQueueStartNum = document.getElementById('resetQueueStartNum');
    const resetQueuePreviewBadge = document.getElementById('resetQueuePreviewBadge');
    const resetQueueNoticeBox = document.getElementById('resetQueueNoticeBox');

    function openResetQueueModal() {
        if (!resetQueueModal) return;
        if (resetQueueStartNum) resetQueueStartNum.value = '1';
        if (resetQueuePreviewBadge) resetQueuePreviewBadge.textContent = 'Queue #1';
        if (resetQueueNoticeBox) {
            resetQueueNoticeBox.className = 'hidden';
            resetQueueNoticeBox.textContent = '';
        }
        resetQueueModal.classList.remove('hidden');
        if (resetQueueStartNum) {
            setTimeout(() => {
                resetQueueStartNum.focus();
                resetQueueStartNum.select();
            }, 50);
        }
    }

    function closeResetQueueModal() {
        if (resetQueueModal) resetQueueModal.classList.add('hidden');
    }

    if (resetQueueStartNum) {
        resetQueueStartNum.addEventListener('input', () => {
            let val = parseInt(resetQueueStartNum.value, 10);
            if (isNaN(val) || val < 1) val = 1;
            if (resetQueuePreviewBadge) {
                resetQueuePreviewBadge.textContent = `Queue #${val}`;
            }
        });
        resetQueueStartNum.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (btnConfirmResetQueue) btnConfirmResetQueue.click();
            }
        });
    }

    if (btnOpenResetQueueModal) {
        btnOpenResetQueueModal.addEventListener('click', openResetQueueModal);
    }

    if (topbarQueueChip) {
        topbarQueueChip.addEventListener('click', openResetQueueModal);
    }

    if (btnCloseResetQueueModal) {
        btnCloseResetQueueModal.addEventListener('click', closeResetQueueModal);
    }

    if (btnCancelResetQueue) {
        btnCancelResetQueue.addEventListener('click', closeResetQueueModal);
    }

    if (resetQueueModal) {
        resetQueueModal.addEventListener('click', (e) => {
            if (e.target === resetQueueModal) closeResetQueueModal();
        });
    }

    if (btnConfirmResetQueue) {
        btnConfirmResetQueue.addEventListener('click', async () => {
            let startNum = 1;
            if (resetQueueStartNum) {
                startNum = parseInt(resetQueueStartNum.value, 10);
                if (isNaN(startNum) || startNum < 1) startNum = 1;
            }

            btnConfirmResetQueue.disabled = true;
            btnConfirmResetQueue.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${SVG_ICONS.spinner} Resetting...</span>`;
            if (resetQueueNoticeBox) {
                resetQueueNoticeBox.className = '';
                resetQueueNoticeBox.style.background = 'rgba(59, 130, 246, 0.1)';
                resetQueueNoticeBox.style.borderColor = 'rgba(59, 130, 246, 0.3)';
                resetQueueNoticeBox.style.color = '#93c5fd';
                resetQueueNoticeBox.textContent = 'Resetting photobooth queue and pinging cloud services...';
            }

            try {
                const res = await fetch('/api/queue/reset', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ start_number: startNum })
                });
                const data = await res.json();
                if (data.success) {
                    const nextQ = data.next_queue_number || startNum;
                    const queueDisplay = data.queue_display || `Queue #${nextQ}`;

                    if (topbarQueueText) topbarQueueText.textContent = queueDisplay;

                    // Sync with guest screen/viewfinder
                    broadcastSync('STATUS_NOTICE', { text: `Queue Reset -> ${queueDisplay}` });
                    broadcastSync('QUEUE_UPDATED', { next_queue_number: nextQ, queue_display: queueDisplay });

                    showStatusNotice(`Queue reset to ${queueDisplay}`);
                    logUserAction("Reset Queue", `Counter reset to ${queueDisplay}`);

                    const cloud = data.cloud_status || {};
                    if (resetQueueNoticeBox) {
                        resetQueueNoticeBox.className = '';
                        resetQueueNoticeBox.style.background = 'rgba(16, 185, 129, 0.12)';
                        resetQueueNoticeBox.style.borderColor = 'rgba(16, 185, 129, 0.35)';
                        resetQueueNoticeBox.style.color = '#6ee7b7';
                        resetQueueNoticeBox.innerHTML = `<strong>Success:</strong> Next session will be <strong>${queueDisplay}</strong>.<br>` +
                            `<span style="font-size:0.73rem;opacity:0.9">Sheets: ${cloud.sheets_message || 'Skipped'} | Drive: ${cloud.drive_message || 'Skipped'}</span>`;
                    }

                    setTimeout(() => {
                        closeResetQueueModal();
                    }, 1400);
                } else {
                    throw new Error(data.error || 'Failed to reset queue');
                }
            } catch (err) {
                console.error("Queue reset error:", err);
                if (resetQueueNoticeBox) {
                    resetQueueNoticeBox.className = '';
                    resetQueueNoticeBox.style.background = 'rgba(239, 68, 68, 0.12)';
                    resetQueueNoticeBox.style.borderColor = 'rgba(239, 68, 68, 0.35)';
                    resetQueueNoticeBox.style.color = '#fca5a5';
                    resetQueueNoticeBox.textContent = 'Error: ' + err.message;
                }
                alert("Queue Reset error: " + err.message);
            } finally {
                btnConfirmResetQueue.disabled = false;
                btnConfirmResetQueue.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> Confirm Reset`;
            }
        });
    }

    // --- INIT ---
    loadSystemConfig();
    initCameraDevices();
    initMicrophonePermissionCheck();
    loadTemplates();
    loadMusicPlaylist();
});
