// 符頭検出（塗りつぶし/中空判定）
(function() {
    'use strict';
    
    function detectNoteHeads(binary, noStaff, system, stems) {
        const sp = system.spacing;
        const minW = sp * 0.55, maxW = sp * 1.8;
        const minH = sp * 0.5,  maxH = sp * 1.5;
        const minArea = sp * sp * 0.25;
        
        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const n = cv.connectedComponentsWithStats(noStaff, labels, stats, centroids);
        
        const heads = [];
        for (let i = 1; i < n; i++) {
            const x = stats.intAt(i, cv.CC_STAT_LEFT);
            const y = stats.intAt(i, cv.CC_STAT_TOP);
            const w = stats.intAt(i, cv.CC_STAT_WIDTH);
            const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
            const area = stats.intAt(i, cv.CC_STAT_AREA);
            const cx = centroids.doubleAt(i, 0);
            const cy = centroids.doubleAt(i, 1);
            
            if (w < minW || w > maxW) continue;
            if (h < minH || h > maxH) continue;
            if (area < minArea) continue;
            const ratio = w / h;
            if (ratio < 0.5 || ratio > 2.6) continue;
            if (cy < system.topY - sp * 6 || cy > system.bottomY + sp * 6) continue;
            
            // ★ 重要: 符頭の中心円領域だけで「塗りつぶし率」を測る
            //    (元のbinary画像を使う。noStaffだと符頭が削れる場合がある)
            const fillRatio = measureCenterFillRatio(binary, cx, cy, w, h);
            
            let headType;
            if (fillRatio >= 0.7) headType = 'filled';        // 4分以下
            else if (fillRatio >= 0.25) headType = 'hollow';  // 2分・全
            else continue;
            
            const stem = findAttachedStem(cx, cy, w, h, stems, sp);
            const isWhole = (headType === 'hollow') && !stem && (w > sp * 0.9);
            
            heads.push({
                x: cx, y: cy, w, h, area,
                fillRatio,
                headType,
                stem,
                isWhole,
                accidental: 0,
                dotted: false,
                pitch: null,
                duration: null
            });
        }
        labels.delete(); stats.delete(); centroids.delete();
        
        // 同位置の重複ヘッドをマージ
        return mergeDuplicateHeads(heads, sp);
    }
    
    // 符頭中心の円形領域で黒画素率を計算（元のbinary使用）
    function measureCenterFillRatio(binary, cx, cy, w, h) {
        const r = Math.max(1, Math.round(Math.min(w, h) * 0.28));
        const cxI = Math.round(cx), cyI = Math.round(cy);
        let black = 0, total = 0;
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (dx * dx + dy * dy > r * r) continue;
                const yy = cyI + dy, xx = cxI + dx;
                if (yy < 0 || yy >= binary.rows) continue;
                if (xx < 0 || xx >= binary.cols) continue;
                if (binary.ucharPtr(yy, xx)[0] > 0) black++;
                total++;
            }
        }
        return total > 0 ? black / total : 0;
    }
    
    function findAttachedStem(cx, cy, w, h, stems, sp) {
        const tolerance = w * 0.75;
        let best = null, bestDist = Infinity;
        for (const stem of stems) {
            const dx = Math.abs(stem.x - cx);
            if (dx > tolerance) continue;
            if (cy < stem.yTop - sp * 0.5 || cy > stem.yBottom + sp * 0.5) continue;
            if (dx < bestDist) { bestDist = dx; best = stem; }
        }
        return best;
    }
    
    // X座標が極端に近い符頭(<sp*0.5)を1つに統合（誤検出対策）
    function mergeDuplicateHeads(heads, sp) {
        heads.sort((a, b) => a.x - b.x);
        const out = [];
        for (const h of heads) {
            const last = out[out.length - 1];
            if (last && Math.abs(h.x - last.x) < sp * 0.4
                && Math.abs(h.y - last.y) < sp * 0.4) {
                // ほぼ同位置 → 面積大きい方を残す
                if (h.area > last.area) out[out.length - 1] = h;
                continue;
            }
            out.push(h);
        }
        return out;
    }
    
    window.OMR_Heads = { detectNoteHeads };
})();
