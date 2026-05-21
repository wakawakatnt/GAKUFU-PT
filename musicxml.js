// MusicXML を ePiano JSON v5 形式に変換
(function() {
    'use strict';

    // 音名→ePiano表記 (E.g. step=C, alter=1, octave=4 → "C#4")
    function pitchToNote(step, alter, octave) {
        let note = step.toUpperCase();
        if (alter == 1) note += '#';
        else if (alter == -1) {
            // フラットを半音下のシャープに変換
            const map = { 'C':'B','D':'C#','E':'D#','F':'E','G':'F#','A':'G#','B':'A#' };
            const lowerOct = ['C','F'].includes(step) ? octave - 1 : octave;
            return map[step] + lowerOct;
        }
        return note + octave;
    }

    // duration(分母指定) → ePiano拍数 (4分音符=1)
    // MusicXML の duration は divisions に対する相対値
    function calcBeats(duration, divisions) {
        return duration / divisions;
    }

    function parseMusicXML(xmlText) {
        // .mxl の場合は ZIP 展開が必要だが、ここでは plain XML 前提
        // (mxl対応する場合は JSZip が必要)
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'application/xml');
        const errNode = doc.querySelector('parsererror');
        if (errNode) throw new Error('XMLパース失敗');

        const scoreParts = doc.querySelectorAll('score-part');
        const parts = doc.querySelectorAll('part');

        // タイトル
        let title = doc.querySelector('movement-title, work-title')?.textContent?.trim() || 'Untitled';

        // BPM
        let bpm = 120;
        const tempo = doc.querySelector('sound[tempo]');
        if (tempo) bpm = parseFloat(tempo.getAttribute('tempo'));
        else {
            const perMinute = doc.querySelector('per-minute');
            if (perMinute) bpm = parseFloat(perMinute.textContent);
        }

        const tracks = [];

        parts.forEach((part, partIdx) => {
            const partId = part.getAttribute('id');
            const scorePart = Array.from(scoreParts).find(sp => sp.getAttribute('id') === partId);
            const trackName = scorePart?.querySelector('part-name')?.textContent?.trim() || `Track ${partIdx + 1}`;

            const notes = [];
            const measures = part.querySelectorAll('measure');
            let divisions = 1;

            // 同時発音を和音にまとめるバッファ
            let chordBuffer = null;

            measures.forEach(measure => {
                // divisions 更新
                const div = measure.querySelector('attributes > divisions');
                if (div) divisions = parseInt(div.textContent);

                // 子要素を順番に処理
                Array.from(measure.children).forEach(elem => {
                    if (elem.tagName !== 'note') return;

                    const isChord = elem.querySelector(':scope > chord');
                    const isRest = elem.querySelector(':scope > rest');
                    const pitch = elem.querySelector(':scope > pitch');
                    const durationEl = elem.querySelector(':scope > duration');
                    if (!durationEl) return;

                    const duration = parseInt(durationEl.textContent);
                    const beats = calcBeats(duration, divisions);

                    if (isRest) {
                        // 前の和音バッファを確定
                        if (chordBuffer) { notes.push(chordBuffer); chordBuffer = null; }
                        notes.push({ rest: beats });
                        return;
                    }

                    if (!pitch) return;

                    const step = pitch.querySelector('step')?.textContent || 'C';
                    const alterEl = pitch.querySelector('alter');
                    const alter = alterEl ? parseInt(alterEl.textContent) : 0;
                    const octave = parseInt(pitch.querySelector('octave')?.textContent || '4');
                    const noteName = pitchToNote(step, alter, octave);

                    if (isChord) {
                        // 直前の音と同時発音
                        if (chordBuffer) {
                            if (chordBuffer.notes) chordBuffer.notes.push(noteName);
                            else chordBuffer = { notes: [chordBuffer.note, noteName], duration: chordBuffer.duration, velocity: 80 };
                        }
                    } else {
                        // 前のバッファを確定
                        if (chordBuffer) { notes.push(chordBuffer); chordBuffer = null; }
                        chordBuffer = { note: noteName, duration: beats, velocity: 80 };
                    }
                });
            });
            if (chordBuffer) notes.push(chordBuffer);

            if (notes.length > 0) {
                tracks.push({ name: trackName, instrument: '', notes });
            }
        });

        return {
            version: '5.0',
            title,
            bpm: Math.round(bpm),
            defaultInstrument: 'piano1',
            tracks
        };
    }

    window.MusicXMLParser = { parse: parseMusicXML };
})();
