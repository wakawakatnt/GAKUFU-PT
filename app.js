(function() {
    'use strict';

    let currentSong = null;
    let osmd = null;
    let previewAudioCtx = null;
    let previewTimers = [];

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
        const text = await file.text();
        try {
            const song = MusicXMLParser.parse(text);
            loadSong(song);
            document.getElementById('musicxml-info').innerHTML =
                `<div class="hint status-ok">✓ "${song.title}" を読込 (${song.tracks.length}トラック, ${song.bpm}BPM)</div>`;
        } catch (e) {
            document.getElementById('musicxml-info').innerHTML =
                `<div class="hint status-err">✗ 読込失敗: ${e.message}</div>`;
        }
    });

    // ========== 画像認識 ==========
    setupDropZone('dz-image', 'file-image', async (file) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.getElementById('image-canvas');
            // 幅を1200pxに正規化（処理高速化のため）
            const scale = Math.min(1, 1200 / img.width);
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            document.getElementById('image-preview-container').style.display = 'block';
            document.getElementById('debug-canvas').classList.remove('show');
        };
        img.src = URL.createObjectURL(file);
    });

    document.getElementById('threshold').addEventListener('input', (e) => {
        document.getElementById('threshold-val').textContent = e.target.value;
    });

    document.getElementById('btn-run-omr').addEventListener('click', () => {
        if (!OMR.isReady()) {
            setOmrStatus('OpenCV.js を読込中です。数秒待ってから再度押してください...', 'warn');
            return;
        }
        try {
            const canvas = document.getElementById('image-canvas');
            const threshold = parseInt(document.getElementById('threshold').value);
            const debugCanvas = document.getElementById('debug-canvas');
            const song = OMR.recognize(canvas, {
                threshold,
                debugCanvas,
                onStatus: setOmrStatus
            });
            loadSong(song);
        } catch (e) {
            setOmrStatus('エラー: ' + e.message, 'err');
            console.error(e);
        }
    });

    function setOmrStatus(msg, level) {
        const el = document.getElementById('omr-status');
        el.textContent = msg;
        el.className = 'status-' + (level || 'ok');
    }

    // ========== 手動入力 ==========
    document.getElementById('btn-parse-manual').addEventListener('click', () => {
        const text = document.getElementById('manual-input').value.trim();
        const tracks = [];
        text.split(/\n/).forEach((line, idx) => {
            if (!line.trim()) return;
            const notes = [];
            // 例: C4/4 D4/4 [C4,E4,G4]/2 R/4
            const tokens = line.replace(/\|/g, '').split(/\s+/).filter(Boolean);
            for (const tk of tokens) {
                const m = tk.match(/^(.+?)\/(\d+(?:\.\d+)?)$/);
                if (!m) continue;
                const noteStr = m[1].trim();
                const denom = parseFloat(m[2]);
                const beats = 4 / denom; // 4=quarter=1拍

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

    // ========== 共通処理 ==========
    function setupDropZone(zoneId, inputId, handler) {
        const zone = document.getElementById(zoneId);
        const input = document.getElementById(inputId);
        zone.addEventListener('click', () => input.click());
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', e => {
            e.preventDefault(); zone.classList.remove('dragover');
            if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]);
        });
        input.addEventListener('change', e => {
            if (e.target.files[0]) handler(e.target.files[0]);
        });
    }

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
        container.innerHTML = currentSong.tracks.map((track, i) => `
            <div class="track-edit" data-index="${i}">
                <div class="track-edit-header">
                    <input type="text" class="track-name" value="${escapeHtml(track.name || '')}" placeholder="トラック名">
                    <select class="track-instrument">
                        <option value="">(デフォルト)</option>
                        <option value="piano1">ピアノ1</option>
                        <option value="piano2">ピアノ2</option>
                        <option value="ep1">エレピ1</option>
                        <option value="org1">オルガン1</option>
                        <option value="bell1">ベル1</option>
                        <option value="gtr1">ギター1</option>
                        <option value="bass1">ベース1</option>
                        <option value="str1">ストリングス</option>
                    </select>
                    <button class="btn track-delete" data-index="${i}">×</button>
                </div>
                <div class="track-notes-display">${formatNotesPreview(track.notes)}</div>
            </div>
        `).join('');

        container.querySelectorAll('.track-name').forEach((inp, i) => {
            inp.addEventListener('input', () => {
                currentSong.tracks[i].name = inp.value;
                updateJsonOutput();
            });
        });
        container.querySelectorAll('.track-instrument').forEach((sel, i) => {
            sel.value = currentSong.tracks[i].instrument || '';
            sel.addEventListener('change', () => {
                currentSong.tracks[i].instrument = sel.value;
                updateJsonOutput();
            });
        });
        container.querySelectorAll('.track-delete').forEach(btn => {
            btn.addEventListener('click', () => {
                if (currentSong.tracks.length <= 1) { alert('最低1トラック必要'); return; }
                if (confirm('このトラックを削除？')) {
                    currentSong.tracks.splice(parseInt(btn.dataset.index), 1);
                    renderTrackEditor();
                    updateJsonOutput();
                }
            });
        });
    }

    function formatNotesPreview(notes) {
        return notes.slice(0, 60).map(n => {
            if (n.rest) return `R/${n.rest}`;
            if (n.pedal !== undefined) return `Ped/${n.pedal}`;
            if (n.notes) return `[${n.notes.join(',')}]/${n.duration}`;
            return `${n.note}/${n.duration}`;
        }).join(' ') + (notes.length > 60 ? ` ... (+${notes.length - 60})` : '');
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    document.getElementById('meta-title').addEventListener('input', () => {
        currentSong.title = document.getElementById('meta-title').value;
        updateJsonOutput();
    });
    document.getElementById('meta-bpm').addEventListener('input', () => {
        currentSong.bpm = parseInt(document.getElementById('meta-bpm').value) || 120;
        updateJsonOutput();
    });
    document.getElementById('meta-instrument').addEventListener('change', () => {
        currentSong.defaultInstrument = document.getElementById('meta-instrument').value;
        updateJsonOutput();
    });

    document.getElementById('btn-add-track').addEventListener('click', () => {
        currentSong.tracks.push({ name: `Track ${currentSong.tracks.length + 1}`, instrument: '', notes: [] });
        renderTrackEditor();
        updateJsonOutput();
    });

    document.getElementById('btn-transpose-up').addEventListener('click', () => transpose(1));
    document.getElementById('btn-transpose-down').addEventListener('click', () => transpose(-1));

    function transpose(octaves) {
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

    function updateJsonOutput() {
        document.getElementById('json-output').value = JSON.stringify(currentSong, null, 2);
    }

    // ========== OSMD表示（音符を簡易MusicXMLに戻して表示） ==========
    function renderOSMD() {
        const container = document.getElementById('osmd-container');
        container.innerHTML = '';
        try {
            const xml = epianoToMusicXML(currentSong);
            if (!osmd) {
                osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
                    autoResize: true,
                    drawTitle: true,
                    drawPartNames: true
                });
            }
            osmd.load(xml).then(() => osmd.render()).catch(e => {
                container.innerHTML = `<div style="color:#888;padding:10px;font-size:11px;">楽譜表示エラー: ${e.message}</div>`;
            });
        } catch (e) {
            container.innerHTML = `<div style="color:#888;padding:10px;font-size:11px;">楽譜表示不可: ${e.message}</div>`;
        }
    }

    // ePiano JSON → 簡易MusicXML (OSMD表示用)
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

        const beatsToDur = (beats) => Math.max(1, Math.round(beats * 4)); // divisions=4

        let parts = '';
        let partList = '';
        song.tracks.forEach((track, i) => {
            const pid = `P${i + 1}`;
            partList += `<score-part id="${pid}"><part-name>${escapeHtml(track.name || `Part ${i+1}`)}</part-name></score-part>`;

            let measures = '';
            let curMeasure = '<measure number="1"><attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>';
            let beatsInMeasure = 0;
            let measureNum = 1;
            const maxBeats = 4;

            for (const n of track.notes) {
                if (n.pedal !== undefined) continue; // ペダルは表示しない
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
        if (!previewAudioCtx) previewAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
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
                const noteList = n.notes ? n.notes.map(nn => typeof nn === 'string' ? nn : nn.note) : [n.note];
                for (const nstr of noteList) {
                    const freq = noteToFreq(nstr);
                    if (!freq) continue;
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.value = freq;
                    osc.connect(gain).connect(ctx.destination);
                    const onTime = startTime + beatsToSec(t);
                    const offTime = onTime + beatsToSec(dur) * 0.9;
                    gain.gain.setValueAtTime(0, onTime);
                    gain.gain.linearRampToValueAtTime(0.15, onTime + 0.01);
                    gain.gain.setValueAtTime(0.15, offTime - 0.05);
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
            previewAudioCtx.close();
            previewAudioCtx = null;
        }
    }

    document.getElementById('btn-download').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(currentSong, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentSong.title || 'song'}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    document.getElementById('btn-copy').addEventListener('click', async () => {
        await navigator.clipboard.writeText(document.getElementById('json-output').value);
        alert('コピーしました');
    });
})();
