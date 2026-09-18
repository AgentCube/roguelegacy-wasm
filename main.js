// main.js — Rogue Legacy WASM bootstrap
import { dotnet } from './_framework/dotnet.js';

const canvas = document.getElementById("canvas");
const progressEl = document.getElementById("loading-progress");
const overlayEl = document.getElementById("loading-overlay");

if (canvas) {
    canvas.width = 1320;
    canvas.height = 720;
}

function setStatus(msg) {
    console.log("[RogueLegacy] " + msg);
    if (progressEl) progressEl.textContent = msg;
}

setStatus("Initialising .NET WebAssembly runtime...");

// Attach canvas to global Module immediately for early SDL/WebGL detection
globalThis.Module = globalThis.Module || {};
if (canvas) {
    globalThis.Module.canvas = canvas;
}

// ---------------------------------------------------------------------------
// 1. Web Audio: Autoplay Unlock & Safe ScriptProcessor Clamping
// ---------------------------------------------------------------------------
const activeAudioContexts = new Set();
const OrigAudioContext = window.AudioContext || window.webkitAudioContext;

if (OrigAudioContext) {
    const WrappedAudioContext = function(...args) {
        let opts = args[0];
        if (!opts || typeof opts !== 'object') opts = {};
        else opts = Object.assign({}, opts);
        if (!opts.sampleRate) opts.sampleRate = 48000;
        const ctx = new OrigAudioContext(opts);
        activeAudioContexts.add(ctx);
        console.log("[RogueLegacy Audio] AudioContext created. Sample rate:", ctx.sampleRate, "State:", ctx.state);
        ctx.addEventListener('statechange', () => {
            console.log("[RogueLegacy Audio] AudioContext state:", ctx.state);
        });
        return ctx;
    };
    WrappedAudioContext.prototype = OrigAudioContext.prototype;

    // Safety guard on createScriptProcessor: bufferSize MUST be power of 2 between 256 and 16384
    const origCSP = OrigAudioContext.prototype.createScriptProcessor;
    if (origCSP) {
        OrigAudioContext.prototype.createScriptProcessor = function(bufferSize, inChannels, outChannels) {
            const validPowers = [256, 512, 1024, 2048, 4096, 8192, 16384];
            let clamped = bufferSize;
            if (!validPowers.includes(bufferSize)) {
                clamped = validPowers.reduce((best, p) =>
                    Math.abs(p - bufferSize) < Math.abs(best - bufferSize) ? p : best, 4096);
                console.warn(`[RogueLegacy Audio] Clamping bufferSize ${bufferSize} -> ${clamped}`);
            }
            console.log(`[RogueLegacy Audio] createScriptProcessor(size=${clamped}, in=${inChannels}, out=${outChannels})`);
            return origCSP.call(this, clamped, inChannels, outChannels);
        };
    }

    window.AudioContext = WrappedAudioContext;
    if (window.webkitAudioContext) {
        window.webkitAudioContext = WrappedAudioContext;
    }
}

function resumeAllAudio() {
    for (const ctx of activeAudioContexts) {
        if (ctx.state === 'suspended') {
            ctx.resume().then(() => {
                console.log("[RogueLegacy Audio] AudioContext resumed successfully!");
            }).catch(err => {
                console.warn("[RogueLegacy Audio] AudioContext resume error:", err);
            });
        }
    }
    // Also check Emscripten Module SDL2 reference
    const sdl2 = globalThis.Module?.SDL2 || globalThis.SDL2 || window.SDL2;
    if (sdl2?.audioContext && sdl2.audioContext.state === 'suspended') {
        sdl2.audioContext.resume().then(() => {
            console.log("[RogueLegacy Audio] Module.SDL2.audioContext resumed successfully!");
        }).catch(() => {});
    }
}

// User-interaction unlock listeners
const unlockAudio = () => {
    resumeAllAudio();
};
['click', 'keydown', 'keyup', 'mousedown', 'mouseup', 'pointerdown', 'touchstart', 'touchend'].forEach(evt => {
    window.addEventListener(evt, unlockAudio, { capture: true, passive: true });
    document.addEventListener(evt, unlockAudio, { capture: true, passive: true });
    if (canvas) canvas.addEventListener(evt, unlockAudio, { capture: true, passive: true });
});

// ---------------------------------------------------------------------------
// Real-time FPS Counter Overlay
// ---------------------------------------------------------------------------
const fpsEl = document.getElementById("fps-counter");
let lastFpsTime = performance.now();
let fpsFrames = 0;

function fpsTick(now) {
    fpsFrames++;
    const elapsed = now - lastFpsTime;
    if (elapsed >= 500) {
        const currentFps = Math.round((fpsFrames * 1000) / elapsed);
        if (fpsEl) {
            fpsEl.textContent = `${currentFps} FPS`;
            if (currentFps >= 50) {
                fpsEl.style.color = "#4ade80";
                fpsEl.style.borderColor = "rgba(74, 222, 128, 0.35)";
            } else if (currentFps >= 28) {
                fpsEl.style.color = "#facc15";
                fpsEl.style.borderColor = "rgba(250, 204, 21, 0.35)";
            } else {
                fpsEl.style.color = "#f87171";
                fpsEl.style.borderColor = "rgba(248, 113, 113, 0.35)";
            }
        }
        fpsFrames = 0;
        lastFpsTime = now;

        // Periodic check to resume audio if page has user activation
        if (navigator.userActivation && navigator.userActivation.hasBeenActive) {
            resumeAllAudio();
        }
    }
    requestAnimationFrame(fpsTick);
}
requestAnimationFrame(fpsTick);

// ---------------------------------------------------------------------------
// 2. Pure JavaScript Path & Directory Helpers
// ---------------------------------------------------------------------------
function getDirname(filePath) {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? '' : filePath.substring(0, idx);
}

function ensureDirectoryExists(fs, dirPath) {
    if (!dirPath || dirPath === '/' || dirPath === '.') return;
    const parts = dirPath.split('/').filter(p => p.length > 0);
    let current = '';
    for (const part of parts) {
        current += '/' + part;
        try {
            if (typeof fs.analyzePath === 'function') {
                if (!fs.analyzePath(current).exists) {
                    fs.mkdir(current);
                }
            } else {
                fs.mkdir(current);
            }
        } catch (e) {
            // Directory may already exist, ignore
        }
    }
}

// ---------------------------------------------------------------------------
// 3. Pre-load content into Emscripten MEMFS (with Browser Cache Storage)
// ---------------------------------------------------------------------------
const ASSET_CACHE_NAME = 'roguelegacy-assets-v2';

async function preloadContent(FS) {
    if (!FS) {
        console.warn("[RogueLegacy] Emscripten FS not available, skipping asset preload.");
        return;
    }

    let files = [];
    try {
        const resp = await fetch("Content/manifest.json", { cache: "no-store" });
        if (resp.ok) files = await resp.json();
    } catch (e) {
        console.warn("[RogueLegacy] No Content/manifest.json:", e);
    }

    if (files.length === 0) return;

    ensureDirectoryExists(FS, "/Content");

    let cache = null;
    if (typeof caches !== 'undefined') {
        try {
            cache = await caches.open(ASSET_CACHE_NAME);
            console.log("[RogueLegacy] Browser Cache Storage active.");
        } catch (e) {
            console.warn("[RogueLegacy] Cache Storage open failed:", e);
        }
    }

    let count = 0;
    const total = files.length;
    setStatus(`Pre-loading assets (0/${total})...`);

    const CONCURRENCY = 6;
    let nextIndex = 0;

    async function loadWorker() {
        while (nextIndex < files.length) {
            const idx = nextIndex++;
            const relPath = files[idx];
            const url = "Content/" + relPath;
            const virtPath = "/Content/" + relPath;
            const dir = getDirname(virtPath);
            if (dir) {
                ensureDirectoryExists(FS, dir);
            }

            // Special handling for SFXWaveBank.xwb: assemble from split chunks to bypass GitHub's 100MB limit without Git LFS
            if (relPath === 'Audio/SFXWaveBank.xwb' || relPath.startsWith('Audio/SFXWaveBank.xwb.part_') || url === 'Content/Audio/SFXWaveBank.xwb') {
                const sfxVirtPath = '/Content/Audio/SFXWaveBank.xwb';
                const sfxUrl = 'Content/Audio/SFXWaveBank.xwb';
                try {
                    let combined = null;
                    // Check if already assembled in MEMFS
                    try {
                        const existingStat = FS.stat(sfxVirtPath);
                        if (existingStat && existingStat.size > 1000) {
                            count++;
                            if (count % 5 === 0 || count === total) {
                                setStatus(`Pre-loading assets (${count}/${total})...`);
                                await new Promise(r => setTimeout(r, 0));
                            }
                            continue;
                        }
                    } catch (_) {}

                    if (cache) {
                        try {
                            const cachedResp = await cache.match(sfxUrl);
                            if (cachedResp) {
                                const cachedBuf = await cachedResp.arrayBuffer();
                                if (cachedBuf.byteLength > 1000) {
                                    combined = new Uint8Array(cachedBuf);
                                } else {
                                    console.warn("[RogueLegacy] Cached SFXWaveBank is an unresolved Git LFS pointer, purging from cache.");
                                    await cache.delete(sfxUrl);
                                }
                            }
                        } catch (_) {}
                    }

                    if (!combined) {
                        const parts = [
                            'Content/Audio/SFXWaveBank.xwb.part_aa',
                            'Content/Audio/SFXWaveBank.xwb.part_ab',
                            'Content/Audio/SFXWaveBank.xwb.part_ac'
                        ];
                        try {
                            console.log("[RogueLegacy] Downloading split SFXWaveBank chunks...");
                            const buffers = [];
                            let totalLen = 0;
                            for (let p = 0; p < parts.length; p++) {
                                const partUrl = parts[p];
                                let partBuf = null;
                                if (cache) {
                                    try {
                                        const cp = await cache.match(partUrl);
                                        if (cp) partBuf = await cp.arrayBuffer();
                                    } catch (_) {}
                                }
                                if (!partBuf) {
                                    const pr = await fetch(partUrl);
                                    if (!pr.ok) throw new Error("HTTP " + pr.status + " for " + partUrl);
                                    if (cache) {
                                        try { await cache.put(partUrl, pr.clone()); } catch (_) {}
                                    }
                                    partBuf = await pr.arrayBuffer();
                                }
                                const b = new Uint8Array(partBuf);
                                buffers.push(b);
                                totalLen += b.byteLength;
                            }
                            combined = new Uint8Array(totalLen);
                            let offset = 0;
                            for (const b of buffers) {
                                combined.set(b, offset);
                                offset += b.length;
                            }
                            console.log(`[RogueLegacy] Successfully reassembled SFXWaveBank.xwb (${(totalLen / (1024 * 1024)).toFixed(1)} MB) from ${parts.length} chunks.`);
                            if (cache) {
                                try {
                                    await cache.put(sfxUrl, new Response(combined, {
                                        headers: { 'Content-Type': 'application/octet-stream' }
                                    }));
                                } catch (_) {}
                            }
                        } catch (splitErr) {
                            console.warn("[RogueLegacy] Split chunk load failed, attempting direct fetch:", splitErr);
                            const resp = await fetch(sfxUrl);
                            if (!resp.ok) throw new Error("HTTP " + resp.status + " for " + sfxUrl);
                            const rawBuf = await resp.arrayBuffer();
                            if (rawBuf.byteLength < 1000) {
                                throw new Error("SFXWaveBank.xwb returned Git LFS pointer and split parts unavailable!");
                            }
                            combined = new Uint8Array(rawBuf);
                            if (cache) {
                                try { await cache.put(sfxUrl, new Response(combined)); } catch (_) {}
                            }
                        }
                    }

                    FS.writeFile(sfxVirtPath, combined);
                } catch (e) {
                    console.error("[RogueLegacy] Critical error loading SFXWaveBank.xwb:", e);
                }

                count++;
                if (count % 5 === 0 || count === total) {
                    setStatus(`Pre-loading assets (${count}/${total})...`);
                    await new Promise(r => setTimeout(r, 0));
                }
                continue;
            }

            try {
                let buf = null;
                if (cache) {
                    try {
                        const cachedResp = await cache.match(url);
                        if (cachedResp) {
                            const cachedBuf = await cachedResp.arrayBuffer();
                            if (url.endsWith('.xwb') && cachedBuf.byteLength < 1000) {
                                console.warn("[RogueLegacy] Purging cached Git LFS pointer for: " + url);
                                await cache.delete(url);
                            } else {
                                buf = cachedBuf;
                            }
                        }
                    } catch (_) {}
                }

                if (!buf) {
                    const resp = await fetch(url);
                    if (!resp.ok) throw new Error("HTTP " + resp.status + " for " + url);
                    const rawBuf = await resp.arrayBuffer();
                    if (url.endsWith('.xwb') && rawBuf.byteLength < 1000) {
                        throw new Error(url + " is an unresolved Git LFS pointer (~" + rawBuf.byteLength + " bytes)!");
                    }
                    buf = rawBuf;
                    if (cache) {
                        try {
                            await cache.put(url, new Response(buf));
                        } catch (_) {}
                    }
                }

                FS.writeFile(virtPath, new Uint8Array(buf));
            } catch (e) {
                console.warn("[RogueLegacy] Asset load failed: " + url, e);
            }

            count++;
            if (count % 5 === 0 || count === total) {
                setStatus(`Pre-loading assets (${count}/${total})...`);
                await new Promise(r => setTimeout(r, 0));
            }
        }
    }

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, files.length); i++) {
        workers.push(loadWorker());
    }
    await Promise.all(workers);

    // Guarantee /Content/Audio/SFXWaveBank.xwb is assembled even if manifest was updated to use parts
    try {
        let needAssemble = false;
        try {
            const stat = FS.stat('/Content/Audio/SFXWaveBank.xwb');
            if (!stat || stat.size < 1000) needAssemble = true;
        } catch (_) {
            needAssemble = true;
        }

        if (needAssemble) {
            const p1 = '/Content/Audio/SFXWaveBank.xwb.part_aa';
            const p2 = '/Content/Audio/SFXWaveBank.xwb.part_ab';
            const p3 = '/Content/Audio/SFXWaveBank.xwb.part_ac';
            let hasParts = false;
            try {
                hasParts = FS.stat(p1).size > 0 && FS.stat(p2).size > 0 && FS.stat(p3).size > 0;
            } catch (_) {}
            if (hasParts) {
                const b1 = FS.readFile(p1);
                const b2 = FS.readFile(p2);
                const b3 = FS.readFile(p3);
                const combined = new Uint8Array(b1.length + b2.length + b3.length);
                combined.set(b1, 0);
                combined.set(b2, b1.length);
                combined.set(b3, b1.length + b2.length);
                FS.writeFile('/Content/Audio/SFXWaveBank.xwb', combined);
                try { FS.unlink(p1); FS.unlink(p2); FS.unlink(p3); } catch (_) {}
                console.log(`[RogueLegacy] Reassembled /Content/Audio/SFXWaveBank.xwb from MEMFS parts (${combined.length} bytes).`);
            }
        }
    } catch (e) {
        console.warn("[RogueLegacy] Post-assembly verification exception:", e);
    }

    console.log(`[RogueLegacy] Preloaded ${files.length} assets into /Content/`);
}

// ---------------------------------------------------------------------------
// 4. Save Data Management (IDBFS + IndexedDB Direct Redundancy)
// ---------------------------------------------------------------------------
const SAVE_DB_NAME = "RogueLegacySaveDB";
const SAVE_STORE_NAME = "saves";
let isIDBFSMounted = false;

function openSaveDB() {
    return new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') {
            resolve(null);
            return;
        }
        try {
            const req = indexedDB.open(SAVE_DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(SAVE_STORE_NAME)) {
                    db.createObjectStore(SAVE_STORE_NAME);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => {
                console.warn("[RogueLegacy] IndexedDB open failed:", req.error);
                resolve(null);
            };
        } catch (e) {
            resolve(null);
        }
    });
}

async function restoreSavesFromIDB(FS) {
    const db = await openSaveDB();
    if (!db) return;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(SAVE_STORE_NAME, "readonly");
            const store = tx.objectStore(SAVE_STORE_NAME);
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const filePath = cursor.key;
                    const data = cursor.value;
                    try {
                        const dir = getDirname(filePath);
                        if (dir) ensureDirectoryExists(FS, dir);
                        FS.writeFile(filePath, data);
                        console.log("[RogueLegacy] Restored save file:", filePath);

                        // If file was from legacy ~/.local/share path, also mirror into /save/
                        if (filePath.includes('.local/share/RogueLegacy')) {
                            const sub = filePath.substring(filePath.indexOf('.local/share/RogueLegacy') + '.local/share/RogueLegacy'.length);
                            const saveMirror = "/save/RogueLegacyStorageContainer" + sub;
                            const mirrorDir = getDirname(saveMirror);
                            if (mirrorDir) ensureDirectoryExists(FS, mirrorDir);
                            FS.writeFile(saveMirror, data);
                            console.log("[RogueLegacy] Mirrored legacy save into:", saveMirror);
                        }
                    } catch (err) {
                        console.warn("[RogueLegacy] Restore save failed:", filePath, err);
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            req.onerror = () => resolve();
        } catch (err) {
            console.warn("[RogueLegacy] IDB restore transaction error:", err);
            resolve();
        }
    });
}

let isSyncing = false;
let saveIsDirty = false;

async function persistSavesToIDB(FS, force = false) {
    if (!FS || isSyncing) return;
    if (!saveIsDirty && !force) return;

    isSyncing = true;
    try {
        // Flush IDBFS if mounted
        if (isIDBFSMounted && typeof FS?.syncfs === 'function' && FS?.filesystems?.IDBFS) {
            await new Promise((resolve) => {
                FS.syncfs(false, (err) => {
                    if (err) console.warn("[RogueLegacy] IDBFS flush error:", err);
                    resolve();
                });
            });
        }

        // Direct IndexedDB backup of all files in /save and /home/web_user/.local/share
        const db = await openSaveDB();
        if (!db) {
            saveIsDirty = false;
            return;
        }

        function collectFiles(dir) {
            let results = [];
            try {
                const entries = FS.readdir(dir);
                for (const entry of entries) {
                    if (entry === '.' || entry === '..') continue;
                    const fullPath = dir === '/' ? '/' + entry : dir + '/' + entry;
                    try {
                        const stat = FS.stat(fullPath);
                        if (FS.isDir(stat.mode)) {
                            results = results.concat(collectFiles(fullPath));
                        } else if (FS.isFile(stat.mode)) {
                            results.push(fullPath);
                        }
                    } catch (_) {}
                }
            } catch (_) {}
            return results;
        }

        const saveFiles = [
            ...collectFiles("/save"),
            ...collectFiles("/home/web_user/.local/share")
        ];

        if (saveFiles.length === 0) {
            saveIsDirty = false;
            return;
        }

        await new Promise((resolve) => {
            try {
                const tx = db.transaction(SAVE_STORE_NAME, "readwrite");
                const store = tx.objectStore(SAVE_STORE_NAME);
                for (const filePath of saveFiles) {
                    try {
                        const data = FS.readFile(filePath);
                        store.put(data, filePath);
                    } catch (err) {
                        console.warn("[RogueLegacy] Save write failed:", filePath, err);
                    }
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch (err) {
                console.warn("[RogueLegacy] IDB persist transaction error:", err);
                resolve();
            }
        });
        saveIsDirty = false;
    } catch (err) {
        console.warn("[RogueLegacy] persistSavesToIDB error:", err);
    } finally {
        isSyncing = false;
    }
}

async function mountSave(FS) {
    if (!FS) {
        console.warn("[RogueLegacy] Emscripten FS not available, skipping save mount.");
        return;
    }

    ensureDirectoryExists(FS, "/save");
    ensureDirectoryExists(FS, "/save/RogueLegacy");
    ensureDirectoryExists(FS, "/save/RogueLegacyStorageContainer");
    ensureDirectoryExists(FS, "/home/web_user/.local/share/RogueLegacy");

    // Intercept FS.writeFile so persistSavesToIDB only runs when save files actually change
    const origWriteFile = FS.writeFile;
    if (origWriteFile && !FS._saveHookInstalled) {
        FS._saveHookInstalled = true;
        FS.writeFile = function(path, data, options) {
            if (typeof path === 'string' && (path.startsWith('/save') || path.includes('.local/share'))) {
                saveIsDirty = true;
            }
            return origWriteFile.call(this, path, data, options);
        };
    }

    if (typeof FS.mount === 'function' && FS.filesystems?.IDBFS) {
        try {
            FS.mount(FS.filesystems.IDBFS, {}, "/save");
            await new Promise((resolve) => {
                FS.syncfs(true, (err) => {
                    if (err) console.warn("[RogueLegacy] IDBFS initial sync failed:", err);
                    resolve();
                });
            });
            isIDBFSMounted = true;
            console.log("[RogueLegacy] /save successfully mounted to IDBFS");
        } catch (e) {
            console.warn("[RogueLegacy] IDBFS mount failed, falling back to IDB storage:", e);
        }
    }

    console.log("[RogueLegacy] Syncing persistent saves from IndexedDB...");
    await restoreSavesFromIDB(FS);
}

// ---------------------------------------------------------------------------
// 5. Main Bootstrap
// ---------------------------------------------------------------------------
try {
    const runtime = await dotnet
        .withEnvironmentVariable("FNA_PLATFORM_BACKEND", "SDL2")
        .withDiagnosticTracing(false)
        .withModuleConfig({
            canvas: canvas
        })
        .create();

    // Ensure canvas is attached across all Emscripten Module references
    if (runtime.Module && canvas) {
        runtime.Module.canvas = canvas;
    }
    if (canvas) {
        globalThis.Module.canvas = canvas;
    }

    // Register JSImport for setMainLoop, notifyGameReady, and refillAudioRingBuffer
    if (typeof runtime.setModuleImports === 'function') {
        runtime.setModuleImports('main.js', {
            setMainLoop: (cb) => {
                console.log("[RogueLegacy JS] Starting JS requestAnimationFrame loop");
                function step() {
                    try {
                        cb();
                        requestAnimationFrame(step);
                    } catch (err) {
                        console.error("[RogueLegacy JS loop frame error]", err);
                    }
                }
                requestAnimationFrame(step);
            },
            notifyGameReady: () => {
                console.log("[RogueLegacy JS] notifyGameReady: First frame rendered by C# engine!");
                window._gameReady = true;
                const overlay = document.getElementById("loading-overlay");
                if (overlay) {
                    overlay.classList.add("hidden");
                }
            }
        });
    }


    // Resolve Emscripten FS safely
    const FS = runtime.Module?.FS || runtime.FS || globalThis.Module?.FS;

    setStatus("Mounting storage and pre-loading assets...");
    await mountSave(FS);
    await preloadContent(FS);

    // Auto-flush saves periodically (throttled) and on page unload
    const flushSaveData = (force = false) => {
        try {
            persistSavesToIDB(FS, force);
        } catch (_) {}
    };
    setInterval(() => flushSaveData(false), 10000);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushSaveData(true);
    });
    window.addEventListener("beforeunload", () => flushSaveData(true));

    setStatus("Initializing game engine & audio assets...");
    await new Promise(r => setTimeout(r, 50));

    // Run the application
    await dotnet.run();
} catch (err) {
    console.error("[RogueLegacy Fatal Error]", err);
    if (progressEl) progressEl.textContent = "Fatal Error: " + (err.message || err);
}
