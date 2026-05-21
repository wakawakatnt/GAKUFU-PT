// 五線検出・段(system)構築・五線除去
(function() {
    'use strict';
    
    // 横方向の射影で五線を検出
    function detectStaffLines(binary) {
        const rows = binary.rows, cols = binary.cols;
        const data = binary.data;
        const proj = new Array(rows).fill(0);
        
        for (let y = 0; y < rows; y++) {
            let s = 0;
            const rowStart = y * cols;
            for (let x = 0; x < cols; x++) {
                if (data[rowStart + x] > 0) s++;
            }
            proj[y] = s;
        }
        
        // 横幅の60%以上が黒い行を線候補
        const thresh = cols * 0.6;
        const segments = [];
        let inL = false, start = 0;
        for (let y = 0; y < rows; y++) {
            if (proj[y] > thresh) {
                if (!inL) { start = y; inL = true; }
            } else if (inL) {
                const thickness = y - start;
                segments.push({
                    start, end: y - 1,
                    center: (start + y - 1) / 2,
                    thickness
                });
                inL = false;
            }
        }
        if (segments.length === 0) return null;
        
        const thicks = segments.map(s => s.thickness).sort((a, b) => a - b);
        const lineThickness = thicks[Math.floor(thicks.length / 2)] || 1;
        
        return {
            lines: segments.map(s => s.center),
            lineThickness,
            segments
        };
    }
    
    // 5本の線をまとめて system 化（線間隔のバラツキが小さい連続5本を選択）
    function buildSystem(lines, lineThickness) {
        let five;
        if (lines.length === 5) {
            five = lines.slice();
        } else if (lines.length < 5) {
            return null;
        } else {
            // 連続5本のうち最も等間隔なものを選ぶ
            let bestIdx = 0, bestVar = Infinity;
            for (let i = 0; i + 4 < lines.length; i++) {
                const f = lines.slice(i, i + 5);
                const gaps = [];
                for (let j = 1; j < 5; j++) gaps.push(f[j] - f[j - 1]);
                const avg = gaps.reduce((a, b) => a + b, 0) / 4;
                if (avg < 3 || avg > 100) continue;
                const v = gaps.reduce((s, g) => s + (g - avg) ** 2, 0) / 4;
                if (v < bestVar) { bestVar = v; bestIdx = i; }
            }
            five = lines.slice(bestIdx, bestIdx + 5);
        }
        
        const gaps = [];
        for (let i = 1; i < 5; i++) gaps.push(five[i] - five[i - 1]);
        const spacing = gaps.reduce((a, b) => a + b, 0) / 4;
        
        return {
            lines: five,                              // [topY, ..., bottomY]
            spacing,                                  // 線間距離(px)
            lineThickness: lineThickness || Math.max(1, spacing * 0.1),
            topY: five[0],
            bottomY: five[4],
            centerY: (five[0] + five[4]) / 2
        };
    }
    
    // 段の自動検出（画像全体から複数段を抽出）
    function detectSystems(binary) {
        const info = detectStaffLines(binary);
        if (!info || info.lines.length < 5) return [];
        const lines = info.lines;
        const systems = [];
        let i = 0;
        while (i + 4 < lines.length) {
            const five = lines.slice(i, i + 5);
            const gaps = [];
            for (let j = 1; j < 5; j++) gaps.push(five[j] - five[j - 1]);
            const avg = gaps.reduce((a, b) => a + b, 0) / 4;
            const ok = gaps.every(g => Math.abs(g - avg) < avg * 0.4) && avg > 3 && avg < 80;
            if (ok) {
                const margin = avg * 5;
                systems.push({
                    y: Math.max(0, Math.round(five[0] - margin)),
                    height: Math.round(five[4] - five[0] + margin * 2),
                    lines: five
                });
                i += 5;
            } else {
                i += 1;
            }
        }
        return systems;
    }
    
    // 五線を画像から除去（横方向のオープニングで抽出して引き算）
    function removeStaves(binary, system) {
        const result = binary.clone();
        const kSize = Math.max(20, Math.floor(system.spacing * 8));
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kSize, 1));
        const horizontal = new cv.Mat();
        cv.morphologyEx(binary, horizontal, cv.MORPH_OPEN, kernel);
        cv.subtract(result, horizontal, result);
        kernel.delete();
        horizontal.delete();
        
        // 縦方向に軽くClose（途切れた符頭などを補修）
        const k2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, 2));
        const closed = new cv.Mat();
        cv.morphologyEx(result, closed, cv.MORPH_CLOSE, k2);
        k2.delete();
        result.delete();
        return closed;
    }
    
    // 音部記号の自動推定（五線左端領域の黒画素重心で判定）
    function guessClef(binary, system) {
        const xStart = 0;
        const xEnd = Math.min(binary.cols, Math.round(system.spacing * 4));
        const yStart = Math.max(0, Math.round(system.topY - system.spacing * 2));
        const yEnd = Math.min(binary.rows, Math.round(system.bottomY + system.spacing * 2));
        
        let sumY = 0, count = 0;
        for (let y = yStart; y < yEnd; y++) {
            for (let x = xStart; x < xEnd; x++) {
                if (binary.ucharPtr(y, x)[0] > 0) {
                    sumY += y;
                    count++;
                }
            }
        }
        if (count === 0) return 'treble';
        const cy = sumY / count;
        return cy < system.centerY ? 'treble' : 'bass';
    }
    
    window.OMR_Staff = {
        detectStaffLines,
        buildSystem,
        detectSystems,
        removeStaves,
        guessClef
    };
})();
