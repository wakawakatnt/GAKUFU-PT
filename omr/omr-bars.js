// 小節線検出
(function() {
    'use strict';
    
    function detectBarLines(binary, system) {
        const sp = system.spacing;
        const yTop = Math.max(0, Math.round(system.topY - 1));
        const yBot = Math.min(binary.rows, Math.round(system.bottomY + 1));
        const expectedHeight = yBot - yTop;
        const maxWidth = Math.max(3, Math.ceil(sp * 0.5));
        
        const kernel = cv.getStructuringElement(
            cv.MORPH_RECT,
            new cv.Size(1, Math.floor(expectedHeight * 0.8))
        );
        const vertical = new cv.Mat();
        cv.morphologyEx(binary, vertical, cv.MORPH_OPEN, kernel);
        kernel.delete();
        
        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const n = cv.connectedComponentsWithStats(vertical, labels, stats, centroids);
        
        const bars = [];
        for (let i = 1; i < n; i++) {
            const x = stats.intAt(i, cv.CC_STAT_LEFT);
            const y = stats.intAt(i, cv.CC_STAT_TOP);
            const w = stats.intAt(i, cv.CC_STAT_WIDTH);
            const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
            if (w > maxWidth) continue;
            if (h < expectedHeight * 0.7) continue;
            const cy = y + h / 2;
            if (cy < system.topY - sp || cy > system.bottomY + sp) continue;
            bars.push({ x: x + w / 2, top: y, bottom: y + h });
        }
        labels.delete(); stats.delete(); centroids.delete(); vertical.delete();
        
        bars.sort((a, b) => a.x - b.x);
        return bars;
    }
    
    window.OMR_Bars = { detectBarLines };
})();
