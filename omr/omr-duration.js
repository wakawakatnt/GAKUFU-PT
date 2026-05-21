// 音価判定 (符頭の塗り/中空 + ステム + 連桁/旗 + 付点)
(function() {
    'use strict';
    
    function assignDurations(heads, stems, beams, flags, system, fallback) {
        for (const h of heads) {
            h.duration = inferDuration(h, beams, flags, fallback);
        }
    }
    
    function inferDuration(head, beams, flags, fallback) {
        // 1. 全音符: 中空 & ステム無し & ある程度大きい
        if (head.isWhole) return 4;
        
        // 2. 中空 + ステム → 2分音符
        if (head.headType === 'hollow' && head.stem) return 2;
        
        // 3. 塗りつぶし + ステム
        if (head.headType === 'filled' && head.stem) {
            // 連桁にぶら下がっているか
            const beam = beams.find(b => b.stems && b.stems.includes(head.stem));
            if (beam) {
                // 連桁が複数本積層されているか(16分)はY方向に他の連桁があるか確認
                const stackedBeams = beams.filter(b2 =>
                    b2 !== beam && b2.stems && b2.stems.includes(head.stem)
                );
                if (stackedBeams.length >= 1) return 0.25;  // 16分音符
                return 0.5;  // 8分音符
            }
            const flag = flags.find(f => f.stem === head.stem);
            if (flag) return 0.5;  // 単独8分音符
            return 1;  // 4分音符
        }
        
        // 4. 塗りつぶし + ステム無し: 4分音符の符頭でステム見逃し
        if (head.headType === 'filled' && !head.stem) return 1;
        
        return fallback;
    }
    
    // 付点検出: 符頭の右に小さな点があるか
    function detectDots(noStaff, system, notes) {
        const sp = system.spacing;
        const dotMin = sp * sp * 0.08;
        const dotMax = sp * sp * 0.6;
        
        for (const n of notes) {
            const xStart = Math.floor(n.x + n.w / 2 + 1);
            const xEnd = Math.min(noStaff.cols, xStart + Math.ceil(sp * 0.9));
            const yStart = Math.max(0, Math.floor(n.y - sp * 0.4));
            const yEnd = Math.min(noStaff.rows, Math.floor(n.y + sp * 0.4));
            
            let count = 0;
            for (let y = yStart; y < yEnd; y++) {
                for (let x = xStart; x < xEnd; x++) {
                    if (noStaff.ucharPtr(y, x)[0] > 0) count++;
                }
            }
            if (count > dotMin && count < dotMax) {
                n.dotted = true;
                n.duration *= 1.5;
            }
        }
    }
    
    window.OMR_Duration = { assignDurations, detectDots };
})();
