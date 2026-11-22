'use strict';

const REPORT_THEMES = {
    navy: { ink: '#102735', line: '#276980', tint: '#edf6fa', grid: '#dce8ed' },
    teal: { ink: '#16352c', line: '#16785e', tint: '#ebf7f2', grid: '#dbece4' },
    mono: { ink: '#171717', line: '#303030', tint: '#f3f3f3', grid: '#e4e4e4' }
};

function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function localCoordinates(points) {
    const origin = points[0];
    return points.map(p => {
        const inverse = WGS84.Inverse(origin.lat, origin.lon, p.lat, p.lon);
        const rad = inverse.azi1 * Math.PI / 180;
        return { e: inverse.s12 * Math.sin(rad), n: inverse.s12 * Math.cos(rad) };
    });
}

function tidyOrder(points, closed) {
    if (points.length < 4) return points;
    const xy = localCoordinates(points);
    const order = points.map((_, i) => i);
    const edgeCount = closed ? points.length : points.length - 1;
    const turn = (a, b, c) => (b.e - a.e) * (c.n - a.n) - (b.n - a.n) * (c.e - a.e);
    function straddle(a, b, c, d) {
        return Math.sign(turn(a, b, c)) * Math.sign(turn(a, b, d)) < 0;
    }
    // A two-edge reversal removes a proper crossing while retaining the original point IDs.
    for (let pass = 0; pass < edgeCount; pass++) {
        let changed = false;
        for (let i = 0; i < edgeCount - 2; i++) {
            for (let j = i + 2; j < edgeCount; j++) {
                const next = (j + 1) % order.length;
                if (next === i) continue;
                const a = xy[order[i]], b = xy[order[i + 1]], c = xy[order[j]], d = xy[order[next]];
                if (straddle(a, b, c, d) && straddle(c, d, a, b)) {
                    for (let left = i + 1, right = j; left < right; left++, right--) {
                        [order[left], order[right]] = [order[right], order[left]];
                    }
                    changed = true;
                }
            }
        }
        if (!changed) break;
    }
    return order.map(i => points[i]);
}

function arrangeReportPoints(points, options) {
    return options.order === 'tidy' && (options.draw === 'polygon' || options.draw === 'route')
        ? tidyOrder(points, options.draw === 'polygon') : points;
}

function makePlan(points, options, result) {
    if (options.draw === 'none' || !points.length) return { svg: '', hidden: 0 };
    const wide = options.orientation === 'landscape';
    const width = wide ? 900 : 680;
    const height = wide ? 430 : 470;
    const pad = 75;
    const theme = options.theme;
    const offsets = localCoordinates(points);
    const east = offsets.map(p => p.e);
    const north = offsets.map(p => p.n);
    const minE = Math.min(...east), maxE = Math.max(...east);
    const minN = Math.min(...north), maxN = Math.max(...north);
    const scale = Math.min((width - 2 * pad) / Math.max(.01, maxE - minE), (height - 2 * pad) / Math.max(.01, maxN - minN));
    const plot = offsets.map((p, i) => ({
        x: width / 2 + (p.e - (minE + maxE) / 2) * scale,
        y: height / 2 - (p.n - (minN + maxN) / 2) * scale,
        id: points[i].id
    }));
    const scaleUnit = 1 / scale * 90;
    const magnitude = 10 ** Math.floor(Math.log10(scaleUnit));
    const scaleMeters = ([5, 2, 1].find(n => n * magnitude <= scaleUnit) || 1) * magnitude;
    const scalePixels = scaleMeters * scale;
    const reserved = [
        { x: width - 68, y: 12, w: 56, h: 68 },
        { x: 10, y: height - 45, w: 146, h: 34 },
        ...plot.map(p => ({ x: p.x - 6, y: p.y - 6, w: 12, h: 12 }))
    ];
    const labels = [];
    let hidden = 0;

    function place(text, anchor, positions, guide) {
        const w = text.length * 8 + 12, h = 21;
        if (labels.length >= 100) { hidden++; return; }
        const box = positions.map(position => ({ x: position[0] - w / 2, y: position[1] - h / 2, w, h }))
            .find(p => p.x > 6 && p.x + p.w < width - 6 && p.y > 6 && p.y + p.h < height - 6 &&
                !reserved.some(other => overlaps(p, other)));
        if (!box) { hidden++; return; }
        reserved.push({ x: box.x - 2, y: box.y - 2, w: box.w + 4, h: box.h + 4 });
        const centerX = box.x + w / 2, centerY = box.y + h / 2;
        labels.push((guide ? '<path d="M' + anchor.x + ' ' + anchor.y + ' L' + centerX + ' ' + centerY +
            '" stroke="' + theme.line + '" stroke-width=".7" opacity=".55"/>' : '') +
            '<rect x="' + box.x + '" y="' + box.y + '" width="' + w + '" height="' + h + '" rx="4" fill="#fff" stroke="' + theme.grid + '"/>' +
            '<text x="' + centerX + '" y="' + (centerY + 4.3) + '" text-anchor="middle">' + xml(text) + '</text>');
    }

    if (options.labels === 'ids' || options.labels === 'both') {
        plot.forEach(p => {
            const offsets = [[25,-18],[-25,-18],[25,18],[-25,18],[0,-25],[0,25],[43,-4],[-43,-4]];
            place('P' + p.id, p, offsets.map(([x,y]) => [p.x + x, p.y + y]), true);
        });
    }

    const path = options.draw === 'polygon' || options.draw === 'route';
    if (path && (options.labels === 'lengths' || options.labels === 'both')) {
        result.segments.forEach(segment => {
            const a = plot[segment.from], b = plot[segment.to];
            const length = Math.hypot(a.x - b.x, a.y - b.y);
            if (length < 10) { hidden++; return; }
            const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const nx = (a.y - b.y) / length, ny = (b.x - a.x) / length;
            const options = [16, -16, 30, -30].map(d => [center.x + nx * d, center.y + ny * d]);
            place(segment.meters.toFixed(2) + ' m', center, options, true);
        });
    }

    let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height +
        '" role="img" aria-label="مخطط نقاط المسح"><rect width="100%" height="100%" fill="' + theme.tint + '"/>';
    const grid = [];
    for (let x = 30; x < width; x += 30) grid.push('M' + x + ' 0 V' + height);
    for (let y = 30; y < height; y += 30) grid.push('M0 ' + y + ' H' + width);
    svg += '<path d="' + grid.join(' ') + '" stroke="' + theme.grid + '" fill="none"/>';
    if (path && plot.length > 1) {
        const form = result.closed ? 'polygon' : 'polyline';
        svg += '<' + form + ' points="' + plot.map(p => p.x.toFixed(2) + ',' + p.y.toFixed(2)).join(' ') +
            '" stroke="' + theme.line + '" stroke-width="2" stroke-linejoin="round" fill="' +
            (result.closed ? theme.line : 'none') + '" fill-opacity=".13"/>';
    }
    svg += '<g fill="' + theme.ink + '" font-family="Arial,sans-serif" font-size="13" direction="ltr">';
    svg += labels.join('');
    svg += plot.map(p => '<circle cx="' + p.x.toFixed(2) + '" cy="' + p.y.toFixed(2) +
        '" r="4.3" stroke="#fff" stroke-width="1.4" fill="' + theme.line + '"/>').join('');
    svg += '<path d="M' + (width-47) + ' 58 l11 -25 11 25 -11 -7Z"/><text x="' + (width-36) +
        '" y="24" text-anchor="middle">N</text><path d="M18 ' + (height-18) + ' h' + scalePixels +
        '" stroke="' + theme.ink + '" stroke-width="2.6"/><text x="18" y="' + (height-24) + '">' +
        Number(scaleMeters.toPrecision(3)) + ' m</text></g></svg>';
    return { svg, hidden };
}

function buildReport(points, options, picture) {
    const result = solveGeometry(points, options.draw === 'polygon');
    const plan = makePlan(points, options, result);
    const theme = options.theme;
    const names = [['المشروع أو الموقع', options.project], ['العميل', options.client], ['المسّاح', options.surveyor]];
    const meta = names.filter(pair => pair[1]).map(pair =>
        '<div><b>' + xml(pair[0]) + '</b><span>' + xml(pair[1]) + '</span></div>').join('');
    const summary = [
        ['عدد النقاط', points.length],
        [result.closed ? 'المحيط' : 'طول المسار', result.segments.length ? fixed(result.total, 2) + ' م' : '—'],
        ['المسافة بين الأولى والأخيرة', result.direct == null ? '—' : fixed(result.direct, 2) + ' م'],
        ...(result.area == null ? [] : [['المساحة', fixed(result.area, 2) + ' م²']])
    ].map(pair => '<div><span>' + pair[0] + '</span><strong>' + pair[1] + '</strong></div>').join('');
    const pointRows = points.map(p => '<tr><td>' + p.id + '</td><td dir="ltr">' + fixed(p.lat, 8) +
        '</td><td dir="ltr">' + fixed(p.lon, 8) + '</td><td>' + fixed(p.alt, 2) + '</td><td>' +
        xml(p.datum ? datumLabel(p.datum) : '—') + '</td><td>' + xml(SOURCE_LABELS[p.source]) +
        '</td><td>' + (p.horizontal95 ? 'R95 ' + fixed(p.horizontal95, 3) : fixed(p.acc, 2)) + '</td></tr>').join('');
    const lengths = result.segments.map(s => '<tr><td>' + points[s.from].id + '</td><td>' + points[s.to].id +
        '</td><td>' + s.meters.toFixed(3) + '</td></tr>').join('');
    const planSection = plan.svg ? '<figure><h2>المخطط الميداني</h2>' + plan.svg +
        (plan.hidden ? '<figcaption>التسميات التي تعذّر وضعها داخل الرسم موجودة في الجداول.</figcaption>' : '') +
        '</figure>' : '';
    const image = picture && options.image && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(picture)
        ? '<figure><h2>الصورة الجوية المرفقة</h2><img src="' + picture + '" alt="صورة جوية مرفقة"></figure>' : '';
    return '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>' + xml(options.title) +
        '</title><style>' +
        '@page{margin:13mm}*{box-sizing:border-box}body{font:12px/1.5 system-ui,sans-serif;color:' + theme.ink +
        ';margin:0;print-color-adjust:exact;-webkit-print-color-adjust:exact}h1{font-size:23px;margin:4px 0}h2{font-size:15px;margin:14px 0 6px}' +
        'header{border-bottom:2px solid ' + theme.line + ';padding-bottom:7px;margin-bottom:8px}p{margin:5px 0}' +
        '.metadata,.summary{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.metadata div,.summary div{background:' +
        theme.tint + ';padding:7px;flex:1 1 8em}.metadata span,.summary strong{display:block}' +
        'figure{margin:10px 0;break-inside:avoid}svg,img{width:100%;display:block;max-height:132mm;object-fit:contain}' +
        'table{width:100%;border-collapse:collapse;font-size:10px}thead{display:table-header-group}th,td{padding:5px;text-align:center;border:1px solid ' +
        theme.grid + '}th{background:' + theme.tint + '}tr{break-inside:avoid}figcaption,footer{font-size:10px;color:#495960}' +
        '.notes{white-space:pre-wrap;overflow-wrap:anywhere}footer{margin-top:12px;border-top:1px solid ' + theme.grid +
        ';padding-top:5px}</style><body><header><p>مسّاح اليمن · ' + xml(options.date) + '</p><h1>' +
        xml(options.title) + '</h1></header>' +
        (meta ? '<div class="metadata">' + meta + '</div>' : '') +
        '<section class="summary">' + summary + '</section>' + planSection +
        '<h2>الإحداثيات</h2><table><thead><tr><th>نقطة</th><th>خط العرض</th><th>خط الطول</th><th>ارتفاع (م)</th><th>مرجع الارتفاع</th><th>المصدر</th><th>تقدير أفقي (م)</th></tr></thead><tbody>' +
        pointRows + '</tbody></table>' +
        (lengths ? '<h2>أبعاد الأضلاع</h2><table><thead><tr><th>من</th><th>إلى</th><th>المسافة الأفقية (م)</th></tr></thead><tbody>' + lengths + '</tbody></table>' : '') +
        (options.notes ? '<h2>ملاحظات</h2><p class="notes">' + xml(options.notes) + '</p>' : '') + image +
        '<footer>WGS 84 · الحسابات الجيوديسية على الإهليلج. دقة الهاتف تقدير من مزود الموقع، وR95 تقدير من المستقبل.</footer></body></html>';
}
