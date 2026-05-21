document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    let currentSong = null;
    let osmd = null;
    let previewAudioCtx = null;

    let imageState = {
        loaded: false,
        systems: [],
        currentDrag: null,
        sourceCanvas: null,
        hoverHandle: null
    };

    const HANDLE_SIZE = 10;

    // ========== タブ切替 ==========
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
        });
    });

    // ========== MusicXML ==========
    setupDropZone('dz-musicxml', 'file-musicxml', async (file) => {
        try {
            const text = await file.text();
            const song = MusicXMLParser.parse(text);
            loadSong(song);
            const info = document.getElementById('musicxml-info');
            if (info) info.innerHTML = `<div class="hint status-ok">✓ "${escapeHtml(song.title)}" を読込 (${song.tracks.length}トラック, ${song.bpm}BPM)</div>`;
        } catch (e) {
            const info = document.getElementById('musicxml-info');
            if (info) info.innerHTML = `<div class="hint status-err">✗ 読込失敗: ${escapeHtml(e.message)}</div>`;
            console.error(e);
        }
    });

    // ========== 画像認識 ==========
    setupDropZone('dz-image', 'file-image', async (file) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.getElementById('image-canvas');
            const overlay = document.getElementById('overlay-canvas');
            const scale = Math.min(1, 1200 / img.width);
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            overlay.width = canvas.width;
            overlay.height = canvas.height;
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            document.getElementById('image-preview-container').style.display = 'block';
            document.getElementById('debug-canvas').classList.remove('show');
            imageState.loaded = true;
            imageState.systems = [];
            imageState.sourceCanvas = canvas;
            renderSystemsList();
            drawOverlay();
            setOmrStatus('画像読込完了。「段を自動検出」または矩形ドラッグで領域を指定してください', 'ok');
        };
        img.src = URL.createObjectURL(file);
    });

    const thresholdEl = document.getElementById('threshold');
    if (thresholdEl) {
        thresholdEl.addEventListener('input', (e) => {
            const valEl = document.getElementById('threshold-val');
            const v = parseInt(e.target.value);
            if (valEl) {
                if (v === 0) {
                    valEl.textContent = '自動';
                    valEl.className = 'threshold-auto-label';
                } else {
                    valEl.textContent = v;
                    valEl.className = '';
                }
            }
        });
    }

    const btnAutoDetect = document.getElementById('btn-auto-detect');
    if (btnAutoDetect) btnAutoDetect.addEventListener('click', () => {
        if (!imageState.loaded) { setOmrStatus('先に画像を読み込んでください', 'warn'); return; }
        if (!OMR.isReady()) { setOmrStatus('OpenCV.js 読込中... 数秒待ってから再度押してください', 'warn'); return; }
        try {
            const thresholdRaw = parseInt(document.getElementById('threshold').value);
            const threshold = thresholdRaw > 0 ? thresholdRaw : 0;
            const systems = OMR.detectSystems(imageState.sourceCanvas, { threshold });
            if (systems.length === 0) {
                setOmrStatus('段を検出できませんでした。閾値を調整するか手動で矩形を描いてください', 'warn');
                return;
            }
            imageState.systems = systems.map((s, i) => ({
                x: 0,
                y: s.y,
                w: imageState.sourceCanvas.width,
                h: s.height,
                clef: 'auto',
                duration: 1,
                notes: null,
                label: `段${i + 1}`
            }));
            renderSystemsList();
            drawOverlay();
            setOmrStatus(`${systems.length}段を自動検出。各段の枠をドラッグで調整、四隅でリサイズできます`, 'ok');
        } catch (e) {
            setOmrStatus('エラー: ' + e.message, 'err');
            console.error(e);
        }
    });

    const btnClearRegions = document.getElementById('btn-clear-regions');
    if (btnClearRegions) btnClearRegions.addEventListener('click', () => {
        imageState.systems = [];
        renderSystemsList();
        drawOverlay();
        document.getElementById('debug-canvas').classList.remove('show');
        setOmrStatus('領域をクリアしました', 'ok');
    });

    // ========== オーバーレイ：矩形編集 ==========
    const overlay = document.getElementById('overlay-canvas');

    if (overlay) {
        overlay.addEventListener('mousedown', onOverlayMouseDown);
        overlay.addEventListener('mousemove', onOverlayMouseMove);
        overlay.addEventListener('mouseup', onOverlayMouseUp);
        overlay.addEventListener('mouseleave', onOverlayMouseLeave);
    }

    function getMousePos(e) {
        const rect = overlay.getBoundingClientRect();
        const scaleX = overlay.width / rect.width;
        const scaleY = overlay.height / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }

    function findHandleAt(x, y) {
        for (let i = imageState.systems.length - 1; i >= 0; i--) {
            const s = imageState.systems[i];
            const handles = getHandles(s);
            for (const h of handles) {
                if (x >= h.x - HANDLE_SIZE && x <= h.x + HANDLE_SIZE &&
                    y >= h.y - HANDLE_SIZE && y <= h.y + HANDLE_SIZE) {
                    return { sysIndex: i, handle: h.type };
                }
            }
        }
        return null;
    }

    function findRegionAt(x, y) {
        for (let i = imageState.systems.length - 1; i >= 0; i--) {
            const s = imageState.systems[i];
            if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
                return i;
            }
        }
        return -1;
    }

    function getHandles(s) {
        return [
            { type: 'nw', x: s.x, y: s.y },
            { type: 'n',  x: s.x + s.w / 2, y: s.y },
            { type: 'ne', x: s.x + s.w, y: s.y },
            { type: 'e',  x: s.x + s.w, y: s.y + s.h / 2 },
            { type: 'se', x: s.x + s.w, y: s.y + s.h },
            { type: 's',  x: s.x + s.w / 2, y: s.y + s.h },
            { type: 'sw', x: s.x, y: s.y + s.h },
            { type: 'w',  x: s.x, y: s.y + s.h / 2 }
        ];
    }

    function onOverlayMouseDown(e) {
        if (!imageState.loaded) return;
        const mode = document.getElementById('omr-mode').value;
        const pos = getMousePos(e);

        if (mode === 'click') {
            handleClickInput(pos.x, pos.y);
            return;
        }

        const handle = findHandleAt(pos.x, pos.y);
        if (handle) {
            const s = imageState.systems[handle.sysIndex];
            imageState.currentDrag = {
                mode: 'resize',
                sysIndex: handle.sysIndex,
                handle: handle.handle,
                origX: s.x, origY: s.y, origW: s.w, origH: s.h,
                startX: pos.x, startY: pos.y
            };
            return;
        }

        const regionIdx = findRegionAt(pos.x, pos.y);
        if (regionIdx >= 0) {
            const s = imageState.systems[regionIdx];
            imageState.currentDrag = {
                mode: 'move',
                sysIndex: regionIdx,
                offsetX: pos.x - s.x,
                offsetY: pos.y - s.y
            };
            return;
        }

        imageState.currentDrag = {
            mode: 'new',
            x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y
        };
    }

    function onOverlayMouseMove(e) {
        const pos = getMousePos(e);

        if (imageState.currentDrag) {
            const d = imageState.currentDrag;
            if (d.mode === 'new') {
                d.x1 = pos.x; d.y1 = pos.y;
            } else if (d.mode === 'move') {
                const s = imageState.systems[d.sysIndex];
                s.x = clamp(pos.x - d.offsetX, 0, overlay.width - s.w);
                s.y = clamp(pos.y - d.offsetY, 0, overlay.height - s.h);
            } else if (d.mode === 'resize') {
                const s = imageState.systems[d.sysIndex];
                const dx = pos.x - d.startX;
                const dy = pos.y - d.startY;
                resizeRegion(s, d.handle, d.origX, d.origY, d.origW, d.origH, dx, dy);
            }
            drawOverlay();
            return;
        }

        const handle = findHandleAt(pos.x, pos.y);
        if (handle) {
            overlay.style.cursor = getCursorForHandle(handle.handle);
        } else if (findRegionAt(pos.x, pos.y) >= 0) {
            overlay.style.cursor = 'move';
        } else {
            overlay.style.cursor = 'crosshair';
        }
    }

    function resizeRegion(s, handle, ox, oy, ow, oh, dx, dy) {
        let nx = ox, ny = oy, nw = ow, nh = oh;
        if (handle.includes('w')) { nx = ox + dx; nw = ow - dx; }
        if (handle.includes('e')) { nw = ow + dx; }
        if (handle.includes('n')) { ny = oy + dy; nh = oh - dy; }
        if (handle.includes('s')) { nh = oh + dy; }
        if (nw < 30) { if (handle.includes('w')) nx = ox + ow - 30; nw = 30; }
        if (nh < 20) { if (handle.includes('n')) ny = oy + oh - 20; nh = 20; }
        s.x = clamp(nx, 0, overlay.width - nw);
        s.y = clamp(ny, 0, overlay.height - nh);
        s.w = Math.min(nw, overlay.width - s.x);
        s.h = Math.min(nh, overlay.height - s.y);
    }

    function getCursorForHandle(h) {
        const map = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
                      ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
        return map[h] || 'pointer';
    }

    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

    function onOverlayMouseUp() {
        if (!imageState.currentDrag) return;
        const d = imageState.currentDrag;
        if (d.mode === 'new') {
            const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
            const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
            if (w > 30 && h > 20) {
                imageState.systems.push({
                    x, y, w, h,
                    clef: 'auto', duration: 1, notes: null,
                    label: `段${imageState.systems.length + 1}`
                });
                renderSystemsList();
            }
        }
        imageState.currentDrag = null;
        drawOverlay();
    }

    function onOverlayMouseLeave() {
        if (imageState.currentDrag) {
            imageState.currentDrag = null;
            drawOverlay();
        }
        overlay.style.cursor = 'crosshair';
    }

    function drawOverlay() {
        if (!overlay) return;
        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        imageState.systems.forEach((s, idx) => {
            const isActive = imageState.currentDrag && imageState.currentDrag.sysIndex === idx;
            ctx.strokeStyle = s.notes
                ? (isActive ? 'rgba(76,175,80,1)' : 'rgba(76,175,80,0.85)')
                : (isActive ? 'rgba(255,193,7,1)' : 'rgba(255,193,7,0.85)');
            ctx.lineWidth = isActive ? 3 : 2;
            ctx.strokeRect(s.x, s.y, s.w, s.h);

            ctx.fillStyle = s.notes ? 'rgba(76,175,80,0.95)' : 'rgba(255,193,7,0.95)';
            const labelY = Math.max(0, s.y - 20);
            ctx.fillRect(s.x, labelY, 70, 18);
            ctx.fillStyle = '#000';
            ctx.font = 'bold 12px sans-serif';
            ctx.fillText(s.label, s.x + 5, labelY + 13);

            const handles = getHandles(s);
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 1;
            handles.forEach(h => {
                ctx.fillRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
                ctx.strokeRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
            });
        });

        if (imageState.currentDrag && imageState.currentDrag.mode === 'new') {
            const d = imageState.currentDrag;
            ctx.strokeStyle = 'rgba(33,150,243,0.95)';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(
                Math.min(d.x0, d.x1), Math.min(d.y0, d.y1),
                Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)
            );
            ctx.setLineDash([]);
        }
    }

    function renderSystemsList() {
        const list = document.getElementById('systems-list');
        if (!list) return;
        if (imageState.systems.length === 0) {
            list.innerHTML = '<div class="hint">段が未指定です。「段を自動検出」または画像上を<b>ドラッグ</b>で矩形を作成してください。</div>';
            return;
        }
        list.innerHTML = imageState.systems.map((s, i) => `
            <div class="system-item" data-index="${i}">
                <span class="system-item-label">${s.label}</span>
                <select class="sys-clef">
                    <option value="auto" ${s.clef === 'auto' ? 'selected' : ''}>自動推定</option>
                    <option value="treble" ${s.clef === 'treble' ? 'selected' : ''}>ト音 𝄞</option>
                    <option value="bass" ${s.clef === 'bass' ? 'selected' : ''}>ヘ音 𝄢</option>
                </select>
                <label style="font-size:10px;color:#aaa;" title="OMRが音価を判定できなかった場合に使う値">フォールバック音価:
                    <select class="sys-dur">
                        <option value="4" ${s.duration == 4 ? 'selected' : ''}>全</option>
                        <option value="2" ${s.duration == 2 ? 'selected' : ''}>2分</option>
                        <option value="1" ${s.duration == 1 ? 'selected' : ''}>4分</option>
                        <option value="0.5" ${s.duration == 0.5 ? 'selected' : ''}>8分</option>
                        <option value="0.25" ${s.duration == 0.25 ? 'selected' : ''}>16分</option>
                    </select>
                </label>
                <button class="btn sys-recognize">認識</button>
                <button class="btn sys-clear">クリア</button>
                <button class="btn sys-delete" style="background:rgba(244,67,54,0.2);">×</button>
                <div class="recognized ${s.notes ? '' : 'empty'}">${s.notes ? formatNotesShort(s.notes) : '未認識'}</div>
            </div>
        `).join('');

        list.querySelectorAll('.system-item').forEach(item => {
            const i = parseInt(item.dataset.index);
            item.querySelector('.sys-clef').addEventListener('change', e => {
                imageState.systems[i].clef = e.target.value;
            });
            item.querySelector('.sys-dur').addEventListener('change', e => {
                imageState.systems[i].duration = parseFloat(e.target.value);
            });
            item.querySelector('.sys-recognize').addEventListener('click', () => recognizeSystem(i));
            item.querySelector('.sys-clear').addEventListener('click', () => {
                imageState.systems[i].notes = null;
                renderSystemsList();
                drawOverlay();
            });
            item.querySelector('.sys-delete').addEventListener('click', () => {
                imageState.systems.splice(i, 1);
                imageState.systems.forEach((s, idx) => s.label = `段${idx + 1}`);
                renderSystemsList();
                drawOverlay();
            });
        });

        const actionRow = document.createElement('div');
        actionRow.className = 'action-row';
        actionRow.innerHTML = `
            <button id="btn-recognize-all" class="btn primary">▶ 全段まとめて認識</button>
            <button id="btn-build-song" class="btn primary">📝 認識結果から曲を生成（1トラック連結）</button>
            <button id="btn-build-song-multi" class="btn">📝 段ごとに別トラックで生成</button>
        `;
        list.appendChild(actionRow);

        document.getElementById('btn-recognize-all').addEventListener('click', () => {
            imageState.systems.forEach((_, i) => recognizeSystem(i));
        });
        document.getElementById('btn-build-song').addEventListener('click', () => buildSongFromSystems(false));
        document.getElementById('btn-build-song-multi').addEventListener('click', () => buildSongFromSystems(true));
    }

    function recognizeSystem(i) {
        if (!OMR.isReady()) { setOmrStatus('OpenCV.js 読込中...', 'warn'); return; }
        const sys = imageState.systems[i];
        try {
            const thresholdRaw = parseInt(document.getElementById('threshold').value);
            const threshold = thresholdRaw > 0 ? thresholdRaw : 0;
            const showDebug = document.getElementById('show-debug').checked;
            const notes = OMR.recognize(imageState.sourceCanvas, sys, {
                threshold,
                defaultDuration: sys.duration,
                clef: sys.clef,
                debugCanvas: showDebug ? document.getElementById('debug-canvas') : null,
                onStatus: (m, l) => setOmrStatus(`[${sys.label}] ${m}`, l)
            });
            sys.notes = notes;
            renderSystemsList();
            drawOverlay();
        } catch (e) {
            setOmrStatus(`[${sys.label}] エラー: ${e.message}`, 'err');
            console.error(e);
        }
    }

    function handleClickInput(x, y) {
        if (imageState.systems.length === 0) {
            setOmrStatus('先に対象の段（矩形領域）を指定してください', 'warn');
            return;
        }
        const sys = imageState.systems.find(s =>
            x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h
        );
        if (!sys) {
            setOmrStatus('段の範囲外をクリックしました', 'warn');
            return;
        }
        try {
            const thresholdRaw = parseInt(document.getElementById('threshold').value);
            const threshold = thresholdRaw > 0 ? thresholdRaw : 0;
            const clefToUse = sys.clef === 'auto' ? 'treble' : sys.clef;
            const pitch = OMR.pitchAtPoint(imageState.sourceCanvas, sys, x, y, {
                threshold, clef: clefToUse
            });
            if (!pitch) {
                setOmrStatus('ピッチ判定失敗（領域内の五線検出が不安定）', 'err');
                return;
            }
            if (!sys.notes) sys.notes = [];
            sys.notes.push({ note: pitch, duration: sys.duration, velocity: 80, _x: x });
            sys.notes.sort((a, b) => (a._x || 0) - (b._x || 0));
            renderSystemsList();
            drawOverlay();

            const ctx = overlay.getContext('2d');
            ctx.fillStyle = '#00e676';
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#000';
            ctx.font = 'bold 11px monospace';
            ctx.fillText(pitch, x + 7, y + 4);

            setOmrStatus(`[${sys.label}] ${pitch} を追加 (${sys.notes.length}個目)`, 'ok');
        } catch (e) {
            setOmrStatus('エラー: ' + e.message, 'err');
        }
    }

    function formatNotesShort(notes) {
        return notes.slice(0, 30).map(n => {
            if (n.rest) return `R/${n.rest}`;
            if (n.notes) return `[${n.notes.join(',')}]/${n.duration}`;
            return `${n.note}/${n.duration}`;
        }).join(' ') + (notes.length > 30 ? ` +${notes.length - 30}` : '');
    }

    function buildSongFromSystems(multiTrack) {
        const recognized = imageState.systems.filter(s => s.notes && s.notes.length > 0);
        if (recognized.length === 0) {
            alert('認識済みの段がありません');
            return;
        }
        const cleanNotes = notes => notes.map(n => {
            const c = { ...n };
            delete c._x;
            return c;
        });

        let tracks;
        if (multiTrack) {
            tracks = recognized.map((sys) => ({
                name: sys.label,
                instrument: '',
                notes: cleanNotes(sys.notes)
            }));
        } else {
            const allNotes = [];
            for (const sys of recognized) allNotes.push(...cleanNotes(sys.notes));
            tracks = [{ name: 'Track 1', instrument: '', notes: allNotes }];
        }

        loadSong({
            version: '5.0',
            title: 'OMR Result',
            bpm: 120,
            defaultInstrument: 'piano1',
            tracks
        });
    }

    function setOmrStatus(msg, level) {
        const el = document.getElementById('omr-status');
        if (!el) return;
        el.textContent = msg;
        el.className = 'status-' + (level || 'ok');
    }

    // ========== 手動入力 ==========
    const btnParseManual = document.getElementById('btn-parse-manual');
    if (btnParseManual) btnParseManual.addEventListener('click', () => {
        const text = document.getElementById('manual-input').value.trim();
        if (!text) { alert('入力が空です'); return; }
        const tracks = [];
        text.split(/\n/).forEach((line, idx) => {
            if (!line.trim()) return;
            const notes = [];
            const tokens = line.replace(/\|/g, '').split(/\s+/).filter(Boolean);
            for (const tk of tokens) {
                const m = tk.match(/^(.+?)\/(\d+(?:\.\d+)?)$/);
                if (!m) continue;
                const noteStr = m[1].trim();
                const denom = parseFloat(m[2]);
                const beats = 4 / denom;

                if (noteStr.toUpperCase() === 'R') {
                    notes.push({ rest: beats });
                } else if (noteStr.startsWith('[') && noteStr.endsWith(']')) {
                    const chord = noteStr.slice(1, -1).split(',').map(n => n.trim().toUpperCase());
                    notes.push({ notes: chord, duration: beats, velocity: 80 });
                } else {
                    notes.push({ note: noteStr.toUpperCase(), duration: beats, velocity: 80 });
                }
            }
            if (notes.length) tracks.push({ name: `Track ${idx + 1}`, instrument: '', notes });
        });

        if (tracks.length === 0) {
            alert('解析できる音符がありません');
            return;
        }
        loadSong({
            version: '5.0',
            title: 'Manual Input',
            bpm: 120,
            defaultInstrument: 'piano1',
            tracks
        });
    });

    // ========== 共通: ドロップゾーン ==========
    function setupDropZone(zoneId, inputId, handler) {
        const zone = document.getElementById(zoneId);
        const input = document.getElementById(inputId);
        if (!zone || !input) return;
        zone.addEventListener('click', () => input.click());
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.classList.remove('dragover');
            if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]);
        });
        input.addEventListener('change', e => {
            if (e.target.files[0]) handler(e.target.files[0]);
        });
    }

    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => e.preventDefault());

    // ========== 曲の読み込み・編集 ==========
    function loadSong(song) {
        currentSong = song;
        document.getElementById('editor-section').style.display = 'block';
        document.getElementById('output-section').style.display = 'block';

        document.getElementById('meta-title').value = song.title || '';
        document.getElementById('meta-bpm').value = song.bpm || 120;
        document.getElementById('meta-instrument').value = song.defaultInstrument || 'piano1';

        renderTrackEditor();
        renderOSMD();
        updateJsonOutput();
        document.getElementById('editor-section').scrollIntoView({ behavior: 'smooth' });
    }

    function renderTrackEditor() {
        const container = document.getElementById('tracks-editor');
        if (!container || !currentSong) return;
        const instOptions = [
            ['', '(デフォルト)'], ['piano1', 'ピアノ1'], ['piano2', 'ピアノ2'], ['piano3', 'ピアノ3'],
            ['ep1', 'エレピ1'], ['org1', 'オルガン1'], ['bell1', 'ベル1'], ['music', 'オルゴール'],
            ['gtr1', 'ギター1'], ['bass1', 'ベース1'], ['lead1', 'リード1'], ['pad1', 'パッド1'],
            ['str1', 'ストリングス'], ['flute', 'フルート'], ['sax', 'サックス'], ['brass', 'ブラス'],
            ['choir', 'コーラス'], ['harp', 'ハープ'], ['marim', 'マリンバ'], ['vibra', 'ビブラフォン']
        ];
        container.innerHTML = currentSong.tracks.map((track, i) => `
            <div class="track-edit" data-index="${i}">
                <div class="track-edit-header">
                    <input type="text" class="track-name" value="${escapeHtml(track.name || '')}" placeholder="トラック名">
                    <select class="track-instrument">
                        ${instOptions.map(([v, n]) =>
                            `<option value="${v}" ${(track.instrument || '') === v ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
                    </select>
                    <button class="btn track-delete">× 削除</button>
                </div>
                <div class="track-notes-display">${formatNotesPreview(track.notes)}</div>
            </div>
        `).join('');

        container.querySelectorAll('.track-edit').forEach(item => {
            const i = parseInt(item.dataset.index);
            item.querySelector('.track-name').addEventListener('input', e => {
                currentSong.tracks[i].name = e.target.value;
                updateJsonOutput();
            });
            item.querySelector('.track-instrument').addEventListener('change', e => {
                currentSong.tracks[i].instrument = e.target.value;
                updateJsonOutput();
            });
            item.querySelector('.track-delete').addEventListener('click', () => {
                if (currentSong.tracks.length <= 1) { alert('最低1トラック必要'); return; }
                if (confirm('このトラックを削除しますか?')) {
                    currentSong.tracks.splice(i, 1);
                    renderTrackEditor();
                    renderOSMD();
                    updateJsonOutput();
                }
            });
        });
    }

    function formatNotesPreview(notes) {
        return notes.slice(0, 80).map(n => {
            if (n.rest) return `R/${n.rest}`;
            if (n.pedal !== undefined) return `Ped/${n.pedal}`;
            if (n.notes) return `[${n.notes.join(',')}]/${n.duration}`;
            return `${n.note}/${n.duration}`;
        }).join(' ') + (notes.length > 80 ? ` ... (+${notes.length - 80}個)` : '');
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    document.getElementById('meta-title')?.addEventListener('input', () => {
        if (!currentSong) return;
        currentSong.title = document.getElementById('meta-title').value;
        updateJsonOutput();
    });
    document.getElementById('meta-bpm')?.addEventListener('input', () => {
        if (!currentSong) return;
        currentSong.bpm = parseInt(document.getElementById('meta-bpm').value) || 120;
        updateJsonOutput();
    });
    document.getElementById('meta-instrument')?.addEventListener('change', () => {
        if (!currentSong) return;
        currentSong.defaultInstrument = document.getElementById('meta-instrument').value;
        updateJsonOutput();
    });

    document.getElementById('btn-add-track')?.addEventListener('click', () => {
        if (!currentSong) return;
        currentSong.tracks.push({
            name: `Track ${currentSong.tracks.length + 1}`,
            instrument: '',
            notes: []
        });
        renderTrackEditor();
        updateJsonOutput();
    });

    document.getElementById('btn-transpose-up')?.addEventListener('click', () => transpose(1));
    document.getElementById('btn-transpose-down')?.addEventListener('click', () => transpose(-1));

    function transpose(octaves) {
        if (!currentSong) return;
        const shift = (note) => {
            const m = note.match(/^([A-G]#?)(\d)$/);
            if (!m) return note;
            return m[1] + Math.max(0, Math.min(9, parseInt(m[2]) + octaves));
        };
        for (const tr of currentSong.tracks) {
            for (const n of tr.notes) {
                if (n.note) n.note = shift(n.note);
                if (n.notes) n.notes = n.notes.map(nn =>
                    typeof nn === 'string' ? shift(nn) : { ...nn, note: shift(nn.note) }
                );
            }
        }
        renderTrackEditor();
        renderOSMD();
        updateJsonOutput();
    }

    document.getElementById('btn-refresh-display')?.addEventListener('click', () => {
        renderOSMD();
    });

    function updateJsonOutput() {
        if (!currentSong) return;
        const el = document.getElementById('json-output');
        if (el) el.value = JSON.stringify(currentSong, null, 2);
    }

    // ========== OSMD楽譜表示 ==========
    function renderOSMD() {
        const container = document.getElementById('osmd-container');
        if (!container) return;
        container.innerHTML = '';
        if (!currentSong) return;
        try {
            const xml = epianoToMusicXML(currentSong);
            if (!osmd) {
                osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
                    autoResize: true,
                    drawTitle: true,
                    drawPartNames: true,
                    drawingParameters: 'compact'
                });
            }
            osmd.load(xml).then(() => osmd.render()).catch(e => {
                container.innerHTML = `<div style="color:#888;padding:10px;font-size:11px;">楽譜表示エラー: ${escapeHtml(e.message)}</div>`;
                console.error('OSMD error', e);
            });
        } catch (e) {
            container.innerHTML = `<div style="color:#888;padding:10px;font-size:11px;">楽譜表示不可: ${escapeHtml(e.message)}</div>`;
            console.error('XML build error', e);
        }
    }

    function epianoToMusicXML(song) {
        const noteToPitch = (note) => {
            const m = note.match(/^([A-G])(#)?(\d)$/);
            if (!m) return null;
            return {
                step: m[1],
                alter: m[2] ? 1 : 0,
                octave: parseInt(m[3])
            };
        };
        const beatsToDur = (beats) => Math.max(1, Math.round(beats * 4));

        let parts = '';
        let partList = '';
        song.tracks.forEach((track, i) => {
            const pid = `P${i + 1}`;
            partList += `<score-part id="${pid}"><part-name>${escapeHtml(track.name || `Part ${i+1}`)}</part-name></score-part>`;

            let measures = '';
            let curMeasure = `<measure number="1"><attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`;
            let beatsInMeasure = 0;
            let measureNum = 1;
            const maxBeats = 4;

            for (const n of track.notes) {
                if (n.pedal !== undefined) continue;
                let dur, noteXml;
                if (n.rest) {
                    dur = n.rest;
                    noteXml = `<note><rest/><duration>${beatsToDur(dur)}</duration></note>`;
                } else if (n.notes) {
                    dur = n.duration;
                    noteXml = n.notes.map((nn, idx) => {
                        const noteStr = typeof nn === 'string' ? nn : nn.note;
                        const p = noteToPitch(noteStr);
                        if (!p) return '';
                        const chord = idx > 0 ? '<chord/>' : '';
                        return `<note>${chord}<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.octave}</octave></pitch><duration>${beatsToDur(dur)}</duration></note>`;
                    }).join('');
                } else if (n.note) {
                    dur = n.duration;
                    const p = noteToPitch(n.note);
                    if (!p) continue;
                    noteXml = `<note><pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.octave}</octave></pitch><duration>${beatsToDur(dur)}</duration></note>`;
                } else continue;

                curMeasure += noteXml;
                beatsInMeasure += dur;

                if (beatsInMeasure >= maxBeats) {
                    curMeasure += '</measure>';
                    measures += curMeasure;
                    measureNum++;
                    curMeasure = `<measure number="${measureNum}">`;
                    beatsInMeasure = 0;
                }
            }
            curMeasure += '</measure>';
            measures += curMeasure;

            parts += `<part id="${pid}">${measures}</part>`;
        });

        return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
<work><work-title>${escapeHtml(song.title || 'Untitled')}</work-title></work>
<part-list>${partList}</part-list>
${parts}
</score-partwise>`;
    }

    // ========== プレビュー再生 ==========
    document.getElementById('btn-preview')?.addEventListener('click', () => {
        stopPreview();
        if (!currentSong) return;
        previewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const ctx = previewAudioCtx;
        const bpm = currentSong.bpm || 120;
        const beatsToSec = (b) => (b * 60) / bpm;

        const startTime = ctx.currentTime + 0.1;
        for (const track of currentSong.tracks) {
            let t = 0;
            for (const n of track.notes) {
                if (n.rest) { t += n.rest; continue; }
                if (n.pedal !== undefined) { t += n.pedal; continue; }
                const dur = n.duration;
                const noteList = n.notes
                    ? n.notes.map(nn => typeof nn === 'string' ? nn : nn.note)
                    : [n.note];
                for (const nstr of noteList) {
                    const freq = noteToFreq(nstr);
                    if (!freq) continue;
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'triangle';
                    osc.frequency.value = freq;
                    osc.connect(gain).connect(ctx.destination);
                    const onTime = startTime + beatsToSec(t);
                    const offTime = onTime + beatsToSec(dur) * 0.9;
                    gain.gain.setValueAtTime(0, onTime);
                    gain.gain.linearRampToValueAtTime(0.12, onTime + 0.01);
                    gain.gain.setValueAtTime(0.12, Math.max(onTime + 0.02, offTime - 0.05));
                    gain.gain.linearRampToValueAtTime(0, offTime);
                    osc.start(onTime);
                    osc.stop(offTime + 0.05);
                }
                t += dur;
            }
        }
    });

    function noteToFreq(note) {
        const m = note.match(/^([A-G])(#)?(\d)$/);
        if (!m) return null;
        const steps = { C:-9, D:-7, E:-5, F:-4, G:-2, A:0, B:2 };
        const semi = steps[m[1]] + (m[2] ? 1 : 0) + (parseInt(m[3]) - 4) * 12;
        return 440 * Math.pow(2, semi / 12);
    }

    document.getElementById('btn-stop-preview')?.addEventListener('click', stopPreview);
    function stopPreview() {
        if (previewAudioCtx) {
            try { previewAudioCtx.close(); } catch(e){}
            previewAudioCtx = null;
        }
    }

    document.getElementById('btn-download')?.addEventListener('click', () => {
        if (!currentSong) return;
        const blob = new Blob([JSON.stringify(currentSong, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentSong.title || 'song'}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    document.getElementById('btn-copy')?.addEventListener('click', async () => {
        const ta = document.getElementById('json-output');
        const text = ta.value;
        try {
            await navigator.clipboard.writeText(text);
            alert('クリップボードにコピーしました');
        } catch (e) {
            ta.select();
            document.execCommand('copy');
            alert('コピーしました');
        }
    });
});
