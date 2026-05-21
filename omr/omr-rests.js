// 休符検出
(function() {
    'use strict';
    
    function detectRests(noStaff, system) {
        const sp = system.spacing;
        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const n = cv.connectedComponentsWithStats(noStaff, labels, stats, centroids);
        
        const rests = [];
        for (let i = 1; i < n; i++) {
            const x = stats.intAt(i, cv.CC_STAT_LEFT);
            const y = stats.intAt(i, cv.CC_STAT_TOP);
            const w = stats.intAt(i, cv.CC_STAT_WIDTH);
            const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
            const area = stats.intAt(i, cv.CC_STAT_AREA);
            const cx = centroids.doubleAt(i, 0);
            const cy = centroids.doubleAt(i, 1);
            
            // 五線範囲内のみ
            if (cy < system.topY - sp * 0.5 || cy > system.bottomY + sp * 0.5) continue;
            if (area < sp * sp * 0.15) continue;
            if (area > sp * sp * 4) continue;
            
            const dur = classifyRestShape(w, h, cx, cy, system, sp);
            if (dur === 0) continue;
            
            rests.push({ x: cx, y: cy, w, h, duration: dur, type: 'rest' });
        }
        labels.delete(); stats.delete(); centroids.delete();
        return rests;
    }
    
    function classifyRestShape(w, h, cx, cy, system, sp) {
        // 全休符/2分休符: 横長で短い (h < sp*0.7)
        if (h < sp * 0.7 && w > sp * 0.4 && w < sp * 1.5) {
            const onLine3 = Math.abs(cy - system.lines[2]) < sp * 0.4;
            const onLine4 = Math.abs(cy - system.lines[1]) < sp * 0.4;
            if (onLine4) return 4;  // 全休符（第4線下）
            if (onLine3) return 2;  // 2分休符（第3線上）
            return 0;
        }
        // 4分休符: 縦長で大きい
        if (h > sp * 1.8 && h < sp * 3.5 && w < sp * 1.2 && w > sp * 0.3) {
            return 1;
        }
        // 8分休符: 中サイズ
        if (h > sp && h < sp * 2 && w > sp * 0.5 && w < sp * 1.5) {
            return 0.5;
        }
        return 0;
    }
    
    window.OMR_Rests = { detectRests };
})();
