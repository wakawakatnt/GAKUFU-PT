// Y座標 → 音高 変換
(function() {
    'use strict';
    
    // ト音記号: 最上線 = F5, 最下線 = E4
    // ヘ音記号: 最上線 = A3, 最下線 = C3
    //
    // 線・間は半ステップ(diatonic step)単位で交互に並ぶ。
    // 五線の線間隔(spacing)は2半ステップ分。
    
    const TREBLE_TOP_LINE = { name: 'F', octave: 5 };  // 最上線(=lines[0])
    const BASS_TOP_LINE   = { name: 'A', octave: 3 };  // 最上線(=lines[0])
    
    const SCALE = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
    
    function noteToIndex(name, octave) {
        return SCALE.indexOf(name) + octave * 7;
    }
    
    function indexToNote(idx) {
        const o = Math.floor(idx / 7);
        const n = ((idx % 7) + 7) % 7;
        return { name: SCALE[n], octave: o };
    }
    
    // y座標 → 音名(臨時記号適用済み)
    function yToPitch(y, system, clef, accidental) {
        const halfStep = system.spacing / 2;
        // 最上線からの半ステップ数（下方向=正）
        const stepsDown = Math.round((y - system.topY) / halfStep);
        
        const top = (clef === 'bass') ? BASS_TOP_LINE : TREBLE_TOP_LINE;
        const topIdx = noteToIndex(top.name, top.octave);
        const targetIdx = topIdx - stepsDown;  // 下に行くほどピッチは低い
        
        const note = indexToNote(targetIdx);
        const oct = Math.max(0, Math.min(9, note.octave));
        let name = note.name;
        
        if (accidental === 1) {
            // シャープ: E# → F, B# → C(+1)
            if (name === 'E') return 'F' + oct;
            if (name === 'B') return 'C' + (oct + 1);
            return name + '#' + oct;
        } else if (accidental === -1) {
            // フラット → 半音下のシャープ表記に正規化
            if (name === 'C') return 'B' + (oct - 1);
            if (name === 'F') return 'E' + oct;
            const flatMap = { 'D': 'C#', 'E': 'D#', 'G': 'F#', 'A': 'G#', 'B': 'A#' };
            return flatMap[name] + oct;
        }
        return name + oct;
    }
    
    window.OMR_Pitch = { yToPitch };
})();
