// デバッグ描画
(function() {
    'use strict';
    
    function drawDebug(canvas, srcCanvas, system, data) {
        canvas.width = srcCanvas.width;
        canvas.height = srcCanvas.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(srcCanvas, 0, 0);
        
        // 五線（赤）
        ctx.strokeStyle = 'rgba(255,80,80,0.6)';
        ctx.lineWidth = 1;
        for (const y of system.lines) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvas.width, y);
            ctx.stroke();
        }
        
        // ステム（青）
        ctx.strokeStyle = 'rgba(33,150,243,0.9)';
        ctx.lineWidth = 2;
        for (const stem of data.stems || []) {
            ctx.beginPath();
            ctx.moveTo(stem.x, stem.yTop);
            ctx.lineTo(stem.x, stem.yBottom);
            ctx.stroke();
        }
        
        // 連桁（オレンジ枠）
        ctx.strokeStyle = 'rgba(255,152,0,0.9)';
        ctx.lineWidth = 2;
        for (const beam of data.beams || []) {
            ctx.strokeRect(beam.x, beam.y, beam.w, beam.h);
        }
        
        // 小節線（紫）
        ctx.strokeStyle = 'rgba(156,39,176,0.8)';
        ctx.lineWidth = 2;
        for (const bar of data.barLines || []) {
            ctx.beginPath();
            ctx.moveTo(bar.x, bar.top);
            ctx.lineTo(bar.x, bar.bottom);
            ctx.stroke();
        }
        
        // 休符（黄色枠）
        ctx.strokeStyle = 'rgba(255,235,59,0.95)';
        ctx.lineWidth = 2;
        ctx.font = 'bold 10px sans-serif';
        for (const rest of data.rests || []) {
            ctx.strokeRect(rest.x - rest.w / 2, rest.y - rest.h / 2, rest.w, rest.h);
            ctx.fillStyle = '#ffeb3b';
            ctx.fillText(`R/${rest.duration}`, rest.x + rest.w / 2 + 2, rest.y);
        }
        
        // 符頭（色分け）
        ctx.lineWidth = 2;
        ctx.font = 'bold 11px monospace';
        for (const n of data.notes || []) {
            let color;
            if (n.isWhole) color = '#ff80ab';
            else if (n.headType === 'hollow') color = '#00bcd4';
            else color = '#00e676';
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.ellipse(n.x, n.y, n.w / 2, n.h / 2, 0, 0, Math.PI * 2);
            ctx.stroke();
            const acc = n.accidental === 1 ? '#'
                      : n.accidental === -1 ? 'b' : '';
            const label = `${acc}${n.pitch || '?'}${n.dotted ? '.' : ''}/${n.duration}`;
            ctx.fillText(label, n.x + n.w / 2 + 2, n.y + 4);
        }
    }
    
    window.OMR_Debug = { drawDebug };
})();
