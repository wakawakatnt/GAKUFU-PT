// OMR エントリポイント・各モジュール統合
(function() {
    'use strict';
    
    let cvReady = false;
    function checkCv() {
        if (typeof cv !== 'undefined' && cv.Mat) {
            cvReady = true;
            return true;
        }
        return false;
    }
    if (!checkCv()) {
        if (typeof cv !== 'undefined') {
            cv['onRuntimeInitialized'] = () => {
                cvReady = true;
                console.log('[OMR] OpenCV.js ready');
            };
        } else {
            const iv = setInterval(() => {
                if (checkCv()) {
                    clearInterval(iv);
                    console.log('[OMR] OpenCV.js ready (poll)');
                }
            }, 200);
        }
    }
    
    function ensureModules() {
        const required = [
            'OMR_Preprocess', 'OMR_Staff', 'OMR_Stems', 'OMR_Heads',
            'OMR_Accidentals', 'OMR_Rests', 'OMR_Bars', 'OMR_Pitch',
            'OMR_Duration', 'OMR_Merge', 'OMR_Debug'
        ];
        for (const m of required) {
            if (!window[m]) throw new Error(`OMRモジュール ${m} がロードされていません`);
        }
    }
    
    // ============================================================
    // メイン認識関数
    // ============================================================
    function recognizeRegion(sourceCanvas, region, opts = {}) {
        if (!cvReady) throw new Error('OpenCV.js未準備');
        ensureModules();
        
        const onStatus = opts.onStatus || (() => {});
        const debugCanvas = opts.debugCanvas;
        const userClef = opts.clef || 'auto';
        const fallbackDuration = opts.defaultDuration || 1;
        
        // 切り出し
        const sub = document.createElement('canvas');
        sub.width = region.w;
        sub.height = region.h;
        sub.getContext('2d').drawImage(
            sourceCanvas,
            region.x, region.y, region.w, region.h,
            0, 0, region.w, region.h
        );
        
        // Step 1: 前処理
        onStatus('前処理中...', 'ok');
        const pre = OMR_Preprocess.preprocess(sub, opts);
        
        try {
            // Step 2: 五線検出
            onStatus('五線検出中...', 'ok');
            const staffInfo = OMR_Staff.detectStaffLines(pre.binary);
            if (!staffInfo || staffInfo.lines.length < 5) {
                throw new Error(
                    `五線が検出できません(${staffInfo ? staffInfo.lines.length : 0}本)。閾値や領域を調整してください`
                );
            }
            const system = OMR_Staff.buildSystem(staffInfo.lines, staffInfo.lineThickness);
            if (!system) throw new Error('五線の構成に失敗しました');
            onStatus(
                `五線5本検出 (間隔${system.spacing.toFixed(1)}px, 線太さ${system.lineThickness.toFixed(1)}px)`,
                'ok'
            );
            
            // Step 3: 音部記号
            let clef = userClef;
            if (clef === 'auto') {
                clef = OMR_Staff.guessClef(pre.binary, system);
                onStatus(`音部記号: ${clef === 'treble' ? 'ト音' : 'ヘ音'} (自動推定)`, 'ok');
            }
            
            // Step 4: 五線除去
            const noStaff = OMR_Staff.removeStaves(pre.binary, system);
            
            try {
                // Step 5: ステム
                onStatus('縦棒検出中...', 'ok');
                const stems = OMR_Stems.detectStems(pre.binary, system);
                onStatus(`縦棒 ${stems.length}本検出`, 'ok');
                
                // Step 6: 連桁
                const beams = OMR_Stems.detectBeams(pre.binary, system, stems);
                if (beams.length > 0) onStatus(`連桁 ${beams.length}本検出`, 'ok');
                
                // Step 7: 旗
                const flags = OMR_Stems.detectFlags(noStaff, system, stems, beams);
                
                // Step 8: 符頭
                onStatus('符頭検出中...', 'ok');
                const heads = OMR_Heads.detectNoteHeads(pre.binary, noStaff, system, stems);
                onStatus(`符頭 ${heads.length}個検出`, 'ok');
                
                // Step 9: 音価判定
                OMR_Duration.assignDurations(heads, stems, beams, flags, system, fallbackDuration);
                
                // Step 10: 付点
                OMR_Duration.detectDots(noStaff, system, heads);
                
                // Step 11: 臨時記号
                OMR_Accidentals.detectAccidentals(noStaff, system, heads, opts);
                
                // Step 12: 休符
                const rests = OMR_Rests.detectRests(noStaff, system);
                
                // Step 13: 小節線
                const barLines = OMR_Bars.detectBarLines(pre.binary, system);
                
                // Step 14: ピッチ計算
                for (const h of heads) {
                    h.pitch = OMR_Pitch.yToPitch(h.y, system, clef, h.accidental);
                }
                
                // Step 15: マージ・グルーピング
                const merged = OMR_Merge.mergeAndGroup(heads, rests, system);
                
                // Step 16: ePiano形式
                const ePianoNotes = OMR_Merge.toEpianoFormat(merged, barLines, fallbackDuration);
                
                // デバッグ描画
                if (debugCanvas) {
                    OMR_Debug.drawDebug(debugCanvas, sub, system, {
                        heads, stems, beams, flags, rests, barLines, notes: heads
                    });
                }
                
                onStatus(
                    `完了: 音符${heads.length}, 休符${rests.length}, 小節線${barLines.length}`,
                    'ok'
                );
                
                return ePianoNotes;
                
            } finally {
                noStaff.delete();
            }
        } finally {
            pre.cleanup();
        }
    }
    
    // 段の自動検出
    function detectSystems(sourceCanvas, opts = {}) {
        if (!cvReady) throw new Error('OpenCV.js未準備');
        ensureModules();
        const pre = OMR_Preprocess.preprocess(sourceCanvas, opts);
        try {
            return OMR_Staff.detectSystems(pre.binary);
        } finally {
            pre.cleanup();
        }
    }
    
    // クリック位置からピッチを取得
    function pitchAtPoint(sourceCanvas, region, clickX, clickY, opts = {}) {
        if (!cvReady) throw new Error('OpenCV.js未準備');
        ensureModules();
        
        const sub = document.createElement('canvas');
        sub.width = region.w;
        sub.height = region.h;
        sub.getContext('2d').drawImage(
            sourceCanvas, region.x, region.y, region.w, region.h,
            0, 0, region.w, region.h
        );
        const pre = OMR_Preprocess.preprocess(sub, opts);
        try {
            const info = OMR_Staff.detectStaffLines(pre.binary);
            if (!info || info.lines.length < 5) return null;
            const system = OMR_Staff.buildSystem(info.lines, info.lineThickness);
            if (!system) return null;
            return OMR_Pitch.yToPitch(clickY - region.y, system, opts.clef || 'treble', 0);
        } finally {
            pre.cleanup();
        }
    }
    
    window.OMR = {
        recognize: recognizeRegion,
        detectSystems,
        pitchAtPoint,
        isReady: () => cvReady
    };
})();
