// 臨時記号 (#, b, ♮) 検出 - 過検出を厳しく抑制する
(function() {
    'use strict';
    
    // 符頭の左に臨時記号があるかを慎重に判定
    function detectAccidentals(noStaff, system, notes, opts = {}) {
        const sp = system.spacing;
        const enabled = opts.detectAccidentals !== false; // デフォルト有効
        if (!enabled) return;
        
        for (const n of notes) {
            // 符頭の左 sp*0.3 〜 sp*1.8 の範囲を調査
            const xEnd = Math.floor(n.x - n.w / 2 - sp * 0.2);
            const xStart = Math.max(0, xEnd - Math.ceil(sp * 1.6));
            const yStart = Math.max(0, Math.floor(n.y - sp * 1.2));
            const yEnd = Math.min(noStaff.rows, Math.floor(n.y + sp * 1.2));
            
            if (xEnd <= xStart) continue;
            
            // 該当領域の黒画素を収集
            const pxs = [];
            for (let y = yStart; y < yEnd; y++) {
                for (let x = xStart; x < xEnd; x++) {
                    if (noStaff.ucharPtr(y, x)[0] > 0) {
                        pxs.push({ x, y });
                    }
                }
            }
            
            // 厳しい閾値: 少なすぎる/多すぎるピクセルは除外
            const minPx = sp * sp * 0.15;
            const maxPx = sp * sp * 1.5;
            if (pxs.length < minPx || pxs.length > maxPx) continue;
            
            // バウンディングボックス計算
            const xs = pxs.map(p => p.x);
            const ys = pxs.map(p => p.y);
            const symXmin = Math.min(...xs);
            const symXmax = Math.max(...xs);
            const symYmin = Math.min(...ys);
            const symYmax = Math.max(...ys);
            const symW = symXmax - symXmin + 1;
            const symH = symYmax - symYmin + 1;
            
            // 臨時記号は縦長 (h > w)、ある程度の大きさが必要
            if (symH < sp * 0.8) continue;
            if (symW > sp * 1.2) continue;  // 横に広すぎるのは何か別物
            if (symW < sp * 0.15) continue; // 細すぎ→ステム残骸
            
            // ★ 隣の音符のステム/連桁残骸を除外
            //   臨時記号は符頭から少なくとも sp*0.3 以上離れているはず
            //   かつ、別の符頭/連桁とは独立しているはず
            const gapToHead = (n.x - n.w / 2) - symXmax;
            if (gapToHead < sp * 0.15) continue;  // 符頭に密着しすぎ
            if (gapToHead > sp * 1.5) continue;   // 符頭から遠すぎ
            
            // 形状解析
            const accidental = classifyAccidentalShape(pxs, symXmin, symYmin, symW, symH, sp);
            if (accidental !== 0) {
                n.accidental = accidental;
            }
        }
    }
    
    // 形状から #, b, ♮ を判定（テンプレートマッチングの簡易版）
    function classifyAccidentalShape(pxs, xmin, ymin, w, h, sp) {
        // 縦方向ヒストグラム（縦線の本数を数える）
        const colHist = new Array(w).fill(0);
        for (const p of pxs) {
            colHist[p.x - xmin]++;
        }
        // 縦線として強いカラム数をカウント
        const strongColThresh = h * 0.5;
        let strongCols = 0;
        let inCol = false;
        let columnRuns = [];
        let runStart = 0;
        for (let i = 0; i < w; i++) {
            if (colHist[i] >= strongColThresh) {
                if (!inCol) { runStart = i; inCol = true; }
            } else if (inCol) {
                columnRuns.push({ start: runStart, end: i - 1 });
                inCol = false;
                strongCols++;
            }
        }
        if (inCol) {
            columnRuns.push({ start: runStart, end: w - 1 });
            strongCols++;
        }
        
        // 重心の上下分布（♭判定用）
        const cy = pxs.reduce((s, p) => s + p.y, 0) / pxs.length;
        const heightRatio = (cy - ymin) / h;
        const aspectRatio = w / h;
        
        // ♭: 縦に細長く、重心が下半分（>0.55）、強い縦線は1本
        if (heightRatio > 0.58 && aspectRatio < 0.65 && strongCols <= 1) {
            return -1; // flat
        }
        
        // ♯: 縦線2本以上、適度な横幅
        if (strongCols >= 2 && aspectRatio > 0.45 && aspectRatio < 1.2) {
            return 1; // sharp
        }
        
        // ♮: 縦線2本だがシャープより細い (今は無視)
        // どれにも該当しない → 0 (臨時記号なし、安全側に倒す)
        return 0;
    }
    
    window.OMR_Accidentals = { detectAccidentals };
})();
