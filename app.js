(function() {
    'use strict';

    let currentSong = null;
    let osmd = null;
    let previewAudioCtx = null;

    let imageState = {
        loaded: false,
        systems: [],
        currentDrag: null,
        sourceCanvas: null
    };

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
            document.getElementById('musicxml-info').innerHTML =
                `<div class="hint status-ok">✓ "${escapeHtml(song.title)}" を読込 (${song.tracks.length}トラック, ${song.bpm}BPM)</div>`;
        } catch (e) {
            document.getElementById('musicxml-info').innerHTML =
                `<div class="hint status-err">✗ 読込失敗: ${escapeHtml(e.message)}</div>`;
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

    document.getElementById('threshold').addEventListener('input', (e) => {
        document.getElementById('threshold-val').textContent = e.target.value;
    });

    document.getElementById('btn-auto-detect').addEventListener('click', () => {
        if (!imageState.loaded) return;
        if (!OMR.isReady()) { setOmrStatus('OpenCV.js 読込中... 数秒待ってから再度押してください', 'warn'); return; }
        try {
            const threshold = parseInt(document.getElementById('threshold').value);
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
                clef: i % 2 === 0 ? 'treble' : 'bass', // 大譜表想定で交互
                duration: 1,
                notes: null,
                label: `段${i + 1}`
            }));
            renderSystemsList();
            drawOverlay();
            setOmrStatus(`${systems.length}段を自動検出しました（音部記号は推測値。各段で要確認）`, 'ok');
        } catch (e) {
            setOmrStatus('エラー: ' + e.message, 'err');
            console.error(e);
        }
    });

    document.getElementById('btn-clear-regions').addEventListener('click', () => {
        imageState.systems = [];
        renderSystemsList();
        drawOverlay();
        document.getElementById('debug-canvas').classList.remove('show');
        setOmrStatus('領域をクリアしました', 'ok');
    });

    // マウス操作
    const overlay = document.getElementById('overlay-canvas');

    overlay.addEventListener('mousedown', (e) => {
        if (!imageState.loaded) return;
        const mode = document.getElementById('omr-mode').value;
        const rect = overlay.getBoundingClientRect();
        const scaleX = overlay.width / rect.width;
        const scaleY = overlay.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;

        if (mode === 'click') {
            handleClickInput(x, y);
            return;
        }
        imageState.currentDrag = { x0: x, y0: y, x1: x, y1: y };
    });

    overlay.addEventListener('mousemove', (e) => {
        if (!imageState.currentDrag) return;
        const rect = overlay.getBoundingClientRect();
        const scaleX = overlay.width / rect.width;
        const scaleY = overlay.height / rect.height;
        imageState.currentDrag.x1 = (e.clientX - rect.left) * scaleX;
        imageState.currentDrag.y1 = (e.clientY - rect.top) * scaleY;
        drawOverlay();
    });

    overlay.addEventListener('mouseup', () => {
        if (!imageState.currentDrag) return;
        const d = imageState.currentDrag;
        const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
        const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
        imageState.currentDrag = null;
        if (w > 30 && h > 20) {
            imageState.systems.push({
                x, y, w, h,
                clef: 'treble', duration: 1, notes: null,
                label: `段${imageState.systems.length + 1}`
            });
            renderSystemsList();
        }
        drawOverlay();
    });

    overlay.addEventListener('mouseleave', () => {
        if (imageState.currentDrag) {
            imageState.currentDrag = null;
            drawOverlay();
        }
    });

    function drawOverlay() {
        if (!overlay) return;
        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        imageState.systems.forEach((s) => {
            ctx.strokeStyle = s.notes ? 'rgba(76,175,80,0.9)' : 'rgba(255,193,7,0.9)';
            ctx.lineWidth = 2;
            ctx.strokeRect(s.x, s.y, s.w, s.h);
            ctx.fillStyle = s.notes ? 'rgba(76,175,80,0.85)' : 'rgba(255,193,7,0.85)';
            ctx.fillRect(s.x, Math.max(0, s.y - 18), 60, 18);
            ctx.fillStyle = '#000';
            ctx.font = 'bold 12px sans-serif';
            ctx.fillText(s.label, s.x + 4, Math.max(12, s.y - 4));
        });

        if (imageState.currentDrag) {
            const d = imageState.currentDrag;
            ctx.strokeStyle = 'rgba(33,150,243,0.9)';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 3]);
            ctx.strokeRect(
                Math.min(d.x0, d.x1), Math.min(d.y0, d.y1),
                Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)
            );
            ctx.setLineDash([]);
        }
    }

    function renderSystemsList() {
        const list = document.getElementById('systems-list');
        if (imageState.systems.length === 0) {
            list.innerHTML = '<div class="hint">段が未指定です。「段を自動検出」または矩形ドラッグで領域を作成してください。</div>';
            return;
        }
        list.innerHTML = imageState.systems.map((s, i) => `
            <div class="system-item" data-index="${i}">
                <span class="system-item-label">${s.label}</span>
                <select class="sys-clef">
                    <option value="treble" ${s.clef === 'treble' ? 'selected' : ''}>ト音記号 𝄞</option>
                    <option value="bass" ${s.clef === 'bass' ? 'selected' : ''}>ヘ音記号 𝄢</option>
                </select>
                <label style="font-size:10px;color:#aaa;">音価:
                    <select class="sys-dur">
                        <option value="4" ${s.duration == 4 ? 'selected' : ''}>全音符</option>
                        <option value="2" ${s.duration == 2 ? 'selected' : ''}>2分音符</option>
                        <option value="1" ${s.duration == 1 ? 'selected' : ''}>4分音符</option>
                        <option value="0.5" ${s.duration == 0.5 ? 'selected' : ''}>8分音符</option>
                        <option value="0.25" ${s.duration == 0.25 ? 'selected' : ''}>16分音符</option>
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
                // 既に認識済みなら音価も更新
                if (imageState.systems[i].notes) {
                    imageState.systems[i].notes.forEach(n => {
                        if (n.note) n.duration = parseFloat(e.target.value);
                    });
                    renderSystemsList();
                }
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

        // 一括操作ボタン
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
            const threshold = parseInt(document.getElementById('threshold').value);
            const notes = OMR.recognize(imageState.sourceCanvas, sys, {
                threshold,
                defaultDuration: sys.duration,
                clef: sys.clef,
                debugCanvas: document.getElementById('debug-canvas'),
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
            const threshold = parseInt(document.getElementById('threshold').value);
            const pitch = OMR.pitchAtPoint(imageState.sourceCanvas, sys, x, y, {
                threshold, clef: sys.clef
            });
            if (!pitch) {
                setOmrStatus('ピッチ判定失敗（領域内の五線検出が不安定）', 'err');
                return;
            }
            if (!sys.notes) sys.notes = [];
            sys.notes.push({ note: pitch, duration: sys.duration, velocity: 80, x: x }); // x座標を一時保持
            // x順にソート
            sys.notes.sort((a, b) => (a.x || 0) - (b.x || 0));
            renderSystemsList();
            drawOverlay();

            // クリック地点に印
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
            if (n.notes) return `[${n.notes.join(',')}]`;
            return n.note;
        }).join(' ') + (notes.length > 30 ? ` +${notes.length - 30}` : '');
    }

    function buildSongFromSystems(multiTrack) {
        const recognized = imageState.systems.filter(s => s.notes && s.notes.length > 0);
        if (recognized.length === 0) {
            alert('認識済みの段がありません');
            return;
        }

        // クリーンなnotes（内部用xプロパティを除去）
        const cleanNotes = notes => notes.map(n => {
            const c = { ...n };
            delete c.x;
            return c;
        });

        let tracks;
        if (multiTrack) {
            tracks = recognized.map((sys, i) => ({
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
    document.getElementById('btn-parse-manual').addEventListener('click', () => {
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

    // グローバルD&D抑制
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
                            `<option value="${v}" ${(track.instrument || '') === v ? 'selected' : ''}>${n}</option>`).join('')}
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

    // ========== メタ情報変更 ==========
    document.getElementById('meta-title').addEventListener('input', () => {
        if (!currentSong) return;
        currentSong.title = document.getElementById('meta-title').value;
        updateJsonOutput();
    });
    document.getElementById('meta-bpm').addEventListener('input', () => {
        if (!currentSong) return;
        currentSong.bpm = parseInt(document.getElementById('meta-bpm').value) || 120;
        updateJsonOutput();
    });
    document.getElementById('meta-instrument').addEventListener('change', () => {
        if (!currentSong) return;
        currentSong.defaultInstrument = document.getElementById('meta-instrument').value;
        updateJsonOutput();
    });

    document.getElementById('btn-add-track').addEventListener('click', () => {
        if (!currentSong) return;
        currentSong.tracks.push({
            name: `Track ${currentSong.tracks.length + 1}`,
            instrument: '',
            notes: []
        });
        renderTrackEditor();
        updateJsonOutput();
    });

    document.getElementById('btn-transpose-up').addEventListener('click', () => transpose(1));
    document.getElementById('btn-transpose-down').addEventListener('click', () => transpose(-1));

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

    document.getElementById('btn-refresh-display').addEventListener('click', () => {
        renderOSMD();
    });

    function updateJsonOutput() {
        if (!currentSong) return;
        document.getElementById('json-output').value = JSON.stringify(currentSong, null, 2);
    }

    // ========== OSMD楽譜表示 ==========
    function renderOSMD() {
        const container = document.getElementById('osmd-container');
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

    // ========== プレビュー再生（Web Audio API） ==========
    document.getElementById('btn-preview').addEventListener('click', () => {
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

    document.getElementById('btn-stop-preview').addEventListener('click', stopPreview);
    function stopPreview() {
        if (previewAudioCtx) {
            try { previewAudioCtx.close(); } catch(e){}
            previewAudioCtx = null;
        }
    }

    // ========== 出力 ==========
    document.getElementById('btn-download').addEventListener('click', () => {
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

    document.getElementById('btn-copy').addEventListener('click', async () => {
        const text = document.getElementById('json-output').value;
        try {
            await navigator.clipboard.writeText(text);
            alert('クリップボードにコピーしました');
        } catch (e) {
            const ta = document.getElementById('json-output');
            ta.select();
            document.execCommand('copy');
            alert('コピーしました');
        }
    });
})();
