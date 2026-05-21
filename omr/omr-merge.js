// 音符・休符のマージ・和音グルーピング・ePiano形式変換
(function() {
    'use strict';
    
    // x座標で並べ、近接する複数符頭を「和音」として束ねる
    function mergeAndGroup(notes, rests, system) {
        const events = [];
        for (const n of notes) events.push({ kind: 'note', ...n });
        for (const r of rests) events.push({ kind: 'rest', ...r });
        events.sort((a, b) => a.x - b.x);
        
        const sp = system.spacing;
        // ★ 和音と認める閾値: x方向に sp*0.5 以内、かつ y方向に差がある
        const chordXThresh = sp * 0.5;
        const minChordYGap = sp * 0.8;  // Y方向にこれ以上離れていないと和音と見なさない
        
        const grouped = [];
        let i = 0;
        while (i < events.length) {
            const ev = events[i];
            if (ev.kind === 'rest') {
                grouped.push(ev);
                i++;
                continue;
            }
            const chord = [ev];
            let j = i + 1;
            while (j < events.length
                   && events[j].kind === 'note'
                   && Math.abs(events[j].x - ev.x) < chordXThresh) {
                chord.push(events[j]);
                j++;
            }
            
            // Yの広がりを確認: 全て近すぎる場合は1音として扱う(重複検出のリカバリ)
            const ys = chord.map(c => c.y);
            const yRange = Math.max(...ys) - Math.min(...ys);
            
            if (chord.length === 1 || yRange < minChordYGap) {
                // 単音 (面積が大きい方を採用)
                const best = chord.reduce((a, b) => (a.area > b.area ? a : b));
                grouped.push({ kind: 'note', single: best, x: best.x });
            } else {
                // 和音
                const minDur = Math.min(...chord.map(c => c.duration || 1));
                grouped.push({
                    kind: 'chord',
                    notes: chord,
                    duration: minDur,
                    x: ev.x
                });
            }
            i = j;
        }
        return grouped;
    }
    
    // ePiano JSON形式に変換
    function toEpianoFormat(grouped, barLines, fallbackDur) {
        const result = [];
        for (const ev of grouped) {
            if (ev.kind === 'rest') {
                result.push({ rest: ev.duration || fallbackDur });
            } else if (ev.kind === 'note') {
                const n = ev.single;
                if (!n.pitch) continue;
                result.push({
                    note: n.pitch,
                    duration: n.duration || fallbackDur,
                    velocity: 80
                });
            } else if (ev.kind === 'chord') {
                const pitches = ev.notes.filter(n => n.pitch).map(n => n.pitch);
                if (pitches.length === 0) continue;
                if (pitches.length === 1) {
                    result.push({
                        note: pitches[0],
                        duration: ev.duration,
                        velocity: 80
                    });
                } else {
                    result.push({
                        notes: pitches,
                        duration: ev.duration,
                        velocity: 80
                    });
                }
            }
        }
        return result;
    }
    
    window.OMR_Merge = { mergeAndGroup, toEpianoFormat };
})();
