// ステム(縦棒)・連桁(beam)・旗(flag)検出
(function() {
    'use strict';
    
    // 縦長の細い構造をステムとして検出
    function detectStems(binary, system) {
        const sp = system.spacing;
        const minLength = Math.floor(sp * 2.5);
        const maxThickness = Math.max(2, Math.ceil(sp * 0.35));
        
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, minLength));
        const vertical = new cv.Mat();
        cv.morphologyEx(binary, vertical, cv.MORPH_OPEN, kernel);
        kernel.delete();
        
        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const n = cv.connectedComponentsWithStats(vertical, labels, stats, centroids);
        
        const stems = [];
        for (let i = 1; i < n; i++) {
            const x = stats.intAt(i, cv.CC_STAT_LEFT);
            const y = stats.intAt(i, cv.CC_STAT_TOP);
            const w = stats.intAt(i, cv.CC_STAT_WIDTH);
            const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
            if (w > maxThickness) continue;
            if (h < minLength) continue;
            stems.push({
                x: x + w / 2,
                yTop: y,
                yBottom: y + h,
                width: w,
                height: h
            });
        }
        labels.delete(); stats.delete(); centroids.delete(); vertical.delete();
        
        stems.sort((a, b) => a.x - b.x);
        return stems;
    }
    
    // 連桁: ステム上端/下端を結ぶ太い水平線
    function detectBeams(binary, system, stems) {
        const sp = system.spacing;
        const minWidth = Math.floor(sp * 1.5);
        const minThickness = Math.max(2, Math.floor(sp * 0.35));
        
        const kernelH = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(minWidth, 1));
        const horizontal = new cv.Mat();
        cv.morphologyEx(binary, horizontal, cv.MORPH_OPEN, kernelH);
        kernelH.delete();
        
        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const n = cv.connectedComponentsWithStats(horizontal, labels, stats, centroids);
        
        const beams = [];
        for (let i = 1; i < n; i++) {
            const x = stats.intAt(i, cv.CC_STAT_LEFT);
            const y = stats.intAt(i, cv.CC_STAT_TOP);
            const w = stats.intAt(i, cv.CC_STAT_WIDTH);
            const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
            if (h < minThickness) continue;
            if (w < minWidth) continue;
            
            // 五線そのものを除外
            const cy = y + h / 2;
            let onStaff = false;
            for (const ly of system.lines) {
                if (Math.abs(cy - ly) < system.lineThickness * 1.5) {
                    onStaff = true;
                    break;
                }
            }
            if (onStaff && h <= system.lineThickness * 2) continue;
            
            beams.push({ x, y, w, h, cx: x + w / 2, cy });
        }
        labels.delete(); stats.delete(); centroids.delete(); horizontal.delete();
        
        // 各 beam に属するステムを記録
        for (const beam of beams) {
            beam.stems = stems.filter(s =>
                s.x >= beam.x - 2 && s.x <= beam.x + beam.w + 2 &&
                (Math.abs(s.yTop - beam.cy) < beam.h * 2 ||
                 Math.abs(s.yBottom - beam.cy) < beam.h * 2)
            );
        }
        return beams;
    }
    
    // 旗: ステム端の小さな塊
    function detectFlags(noStaff, system, stems, beams) {
        const sp = system.spacing;
        const flags = [];
        const beamStems = new Set();
        for (const b of beams) {
            for (const s of (b.stems || [])) beamStems.add(s);
        }
        
        for (const stem of stems) {
            if (beamStems.has(stem)) continue;  // 連桁ステムには旗無し
            
            for (const endY of [stem.yTop, stem.yBottom]) {
                const checkY1 = Math.max(0, endY - Math.floor(sp * 1.2));
                const checkY2 = Math.min(noStaff.rows, endY + Math.floor(sp * 1.2));
                const checkX1 = Math.max(0, Math.floor(stem.x));
                const checkX2 = Math.min(noStaff.cols, Math.floor(stem.x + sp * 1.5));
                
                let pixCount = 0;
                for (let y = checkY1; y < checkY2; y++) {
                    for (let x = checkX1; x < checkX2; x++) {
                        if (noStaff.ucharPtr(y, x)[0] > 0) pixCount++;
                    }
                }
                if (pixCount > sp * sp * 0.3) {
                    flags.push({
                        stem,
                        count: 1,
                        side: endY === stem.yTop ? 'top' : 'bottom'
                    });
                    break;
                }
            }
        }
        return flags;
    }
    
    window.OMR_Stems = { detectStems, detectBeams, detectFlags };
})();
