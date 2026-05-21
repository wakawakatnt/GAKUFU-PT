// MusicXML を ePiano JSON v5 形式に変換
(function() {
    'use strict';

    function pitchToNote(step, alter, octave) {
        let note = String(step).toUpperCase();
        if (alter == 1) note += '#';
        else if (alter == -1) {
            // フラットを半音下のシャープに変換
            const map = { 'C':'B', 'D':'C#', 'E':'D#', 'F':'E', 'G':'F#', 'A':'G#', 'B':'A#' };
            const lowerOct = ['C','F'].includes(step) ? octave - 1 : octave;
            return map[step] + lowerOct;
        }
        return note + octave;
    }

    function calcBeats(duration, divisions) {
        return duration / divisions;
    }

    function parseMusicXML(xmlText) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'application/xml');
        const errNode = doc.querySelector('parsererror');
        if (errNode) throw new Error('XMLパース失敗: ' + errNode.textContent.slice(0, 100));

        const scoreParts = doc.querySelectorAll('score-part');
        const parts = doc.querySelectorAll('part');

        if (parts.length === 0) throw new Error('part要素が見つかりません');

        let title = doc.querySelector('movement-title, work-title')?.textContent?.trim() || 'Untitled';

        let bpm = 120;
        const tempoAttr = doc.querySelector('sound[tempo]');
        if (tempoAttr) {
            bpm = parseFloat(tempoAttr.getAttribute('tempo'));
        } else {
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

            let chordBuffer = null;

            measures.forEach(measure => {
                const divEl = measure.querySelector('attributes > divisions');
                if (divEl) divisions = parseInt(divEl.textContent) || 1;

                Array.from(measure.children).forEach(elem => {
                    if (elem.tagName !== 'note') return;

                    const isChord = elem.querySelector(':scope > chord');
                    const isRest = elem.querySelector(':scope > rest');
                    const isGrace = elem.querySelector(':scope > grace');
                    if (isGrace) return; // 装飾音は無視

                    const pitch = elem.querySelector(':scope > pitch');
                    const durationEl = elem.querySelector(':scope > duration');
                    if (!durationEl) return;

                    const duration = parseInt(durationEl.textContent);
                    const beats = calcBeats(duration, divisions);

                    if (isRest) {
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
                        if (chordBuffer) {
                            if (chordBuffer.notes) {
                                chordBuffer.notes.push(noteName);
                            } else {
                                chordBuffer = {
                                    notes: [chordBuffer.note, noteName],
                                    duration: chordBuffer.duration,
                                    velocity: 80
                                };
                            }
                        }
                    } else {
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

        if (tracks.length === 0) throw new Error('音符が抽出できませんでした');

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
