// ===== المتغيرات العامة =====
let savedPoints = [];
let calibrationProgress = 0;
let calibrationInterval = null;
let currentLocation = { lat: 0, lon: 0, alt: 0, acc: 0 };
let satelliteImageData = null;
const STORAGE_KEY = 'yemen_surveyor_points';
const SATELLITE_KEY = 'yemen_surveyor_satellite';

function persistPoints() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(savedPoints)); } catch (e) { console.error(e); }
}
function loadPersistedPoints() {
    try {
        const data = localStorage.getItem(STORAGE_KEY);
        if (data) { savedPoints = JSON.parse(data) || []; updatePointsList(); }
        const sat = localStorage.getItem(SATELLITE_KEY);
        if (sat) {
            satelliteImageData = sat;
            const preview = document.getElementById('satelliteImagePreview');
            if (preview) preview.innerHTML = `<img src="${sat}" style="max-width:100%;border-radius:8px;margin-top:10px;">`;
        }
    } catch (e) { savedPoints = []; }
}

function startCalibration() {
    if (window.DeviceMotionEvent) window.addEventListener('devicemotion', handleMotion);
    let elapsed = 0;
    calibrationInterval = setInterval(() => {
        elapsed += 100;
        calibrationProgress = Math.min((elapsed / 5000) * 100, 100);
        document.getElementById('calibrationProgress').style.width = calibrationProgress + '%';
        if (calibrationProgress >= 100) {
            clearInterval(calibrationInterval);
            window.removeEventListener('devicemotion', handleMotion);
            goToStabilize();
        }
    }, 100);
}
function handleMotion(event) {
    const acc = event.accelerationIncludingGravity;
    if (acc) {
        const magnitude = Math.sqrt(acc.x ** 2 + acc.y ** 2 + acc.z ** 2);
        if (magnitude > 2 && magnitude < 30)
            document.getElementById('calibrationStatus').textContent = '✅ حركة مكتشفة... استمر!';
    }
}

function goToStabilize() {
    showScreen('stabilizeScreen');
    document.getElementById('stabilizeStatus').textContent = '📡 جاري استقبال GPS...';
    if (window.Android && window.Android.startHighAccuracyTracking)
        window.Android.startHighAccuracyTracking();
    let stableCount = 0;
    const checkStable = setInterval(() => {
        stableCount++;
        if (stableCount >= 30) { clearInterval(checkStable); showResults(); }
    }, 100);
}

function onLocationUpdate(lat, lon, alt, acc) {
    currentLocation = kalmanFilter(currentLocation, { lat, lon, alt, acc });
    document.getElementById('latValue').textContent = currentLocation.lat.toFixed(8);
    document.getElementById('lonValue').textContent = currentLocation.lon.toFixed(8);
    document.getElementById('altValue').textContent = currentLocation.alt.toFixed(2) + ' م';
    document.getElementById('accValue').textContent = currentLocation.acc.toFixed(2) + ' م';
}

function kalmanFilter(prev, curr) {
    if (prev.lat === 0 && prev.lon === 0) return { ...curr };
    const K = prev.acc / (prev.acc + curr.acc);
    return {
        lat: prev.lat + K * (curr.lat - prev.lat),
        lon: prev.lon + K * (curr.lon - prev.lon),
        alt: prev.alt + K * (curr.alt - prev.alt),
        acc: Math.min(prev.acc, curr.acc)
    };
}

function savePoint() {
    if (currentLocation.lat === 0 && currentLocation.lon === 0) {
        document.getElementById('saveStatus').textContent = '⚠️ لا توجد إحداثيات';
        return;
    }
    savedPoints.push({
        id: savedPoints.length + 1,
        lat: currentLocation.lat, lon: currentLocation.lon,
        alt: currentLocation.alt, acc: currentLocation.acc,
        timestamp: new Date().toISOString()
    });
    updatePointsList(); persistPoints();
    document.getElementById('saveStatus').textContent = '✅ تم حفظ النقطة ' + savedPoints.length;
}

function updatePointsList() {
    const list = document.getElementById('pointsList');
    document.getElementById('pointCount').textContent = savedPoints.length;
    if (savedPoints.length === 0) {
        list.innerHTML = '<p style="text-align:center;color:#666;padding:12px;">لا توجد نقاط</p>';
        return;
    }
    list.innerHTML = savedPoints.map(p => `
        <div class="point-item">
            <span>${p.id}</span>
            <span class="coords">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</span>
            <button class="delete-btn" onclick="deletePoint(${p.id})">✕</button>
        </div>`).join('');
}
function deletePoint(id) {
    savedPoints = savedPoints.filter(p => p.id !== id);
    savedPoints.forEach((p, i) => p.id = i + 1);
    updatePointsList(); persistPoints();
}
function clearAllPoints() {
    if (savedPoints.length === 0) return;
    if (confirm('مسح جميع النقاط؟')) {
        savedPoints = []; updatePointsList(); persistPoints();
        document.getElementById('calcResults').innerHTML = '';
    }
}

// ===== صورة Google Earth =====
function attachSatelliteImage() {
    document.getElementById('satelliteImageInput').click();
}

function handleSatelliteImage(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
            // ضغط الصورة قبل التخزين
            const canvas = document.createElement('canvas');
            const maxW = 1000;
            const scale = Math.min(1, maxW / img.width);
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            satelliteImageData = canvas.toDataURL('image/jpeg', 0.75);

            const preview = document.getElementById('satelliteImagePreview');
            preview.innerHTML = `<img src="${satelliteImageData}" style="max-width:100%;border-radius:8px;margin-top:10px;border:2px solid #00d4aa;">`;

            try {
                localStorage.setItem(SATELLITE_KEY, satelliteImageData);
                alert('✅ تم إرفاق الصورة بنجاح');
            } catch (err) {
                alert('⚠️ الصورة كبيرة جداً. ستُستخدم في هذا التقرير فقط.');
            }
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function removeSatelliteImage() {
    if (!confirm('حذف صورة Google Earth؟')) return;
    satelliteImageData = null;
    document.getElementById('satelliteImagePreview').innerHTML = '';
    try { localStorage.removeItem(SATELLITE_KEY); } catch (e) {}
}

// ===== CSV والملفات =====
function buildCSV() {
    let csv = '\uFEFF';
    csv += 'ID,Latitude,Longitude,Altitude(m),Accuracy(m),Timestamp\n';
    savedPoints.forEach(p => {
        csv += `${p.id},${p.lat.toFixed(8)},${p.lon.toFixed(8)},${p.alt.toFixed(2)},${p.acc.toFixed(2)},${p.timestamp}\n`;
    });
    return csv;
}

function getDefaultFileName(ext) {
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    return `survey_${stamp}.${ext}`;
}

function saveWithDialog() {
    if (savedPoints.length === 0) { alert('⚠️ لا توجد نقاط'); return; }
    const csv = buildCSV();
    const defaultName = getDefaultFileName('csv');
    if (window.Android && window.Android.saveCSVWithDialog)
        window.Android.saveCSVWithDialog(csv, defaultName);
}

function shareCSV() {
    if (savedPoints.length === 0) { alert('⚠️ لا توجد نقاط'); return; }
    const csv = buildCSV();
    const fileName = getDefaultFileName('csv');
    if (window.Android && window.Android.shareCSV)
        window.Android.shareCSV(csv, fileName);
}

function triggerImport() { document.getElementById('importFile').click(); }

function handleFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    const reader = new FileReader();

    reader.onload = function (e) {
        if (ext === 'xlsx' || ext === 'xls') parseExcel(e.target.result);
        else parseCSV(e.target.result);
        event.target.value = '';
    };
    reader.onerror = () => alert('❌ فشل قراءة الملف');

    if (ext === 'xlsx' || ext === 'xls') reader.readAsArrayBuffer(file);
    else reader.readAsText(file, 'UTF-8');
}

function parseExcel(arrayBuffer) {
    try {
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
        processRows(jsonData);
    } catch (e) {
        alert('❌ خطأ في قراءة Excel: ' + e.message);
    }
}

function parseCSV(content) {
    if (content.charCodeAt(0) === 0xFEFF) content = content.substring(1);
    const firstLine = content.split(/\r?\n/)[0] || '';
    const sep = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    const rows = lines.map(l => l.split(sep).map(p => p.trim().replace(/^"|"$/g, '')));
    processRows(rows);
}

function processRows(rows) {
    if (rows.length < 2) { alert('⚠️ الملف فارغ'); return; }
    const header = rows[0].map(h => String(h).toLowerCase().trim());
    const latIdx = header.findIndex(h => h.includes('lat') || h.includes('عرض'));
    const lonIdx = header.findIndex(h => h.includes('lon') || h.includes('lng') || h.includes('طول'));
    const altIdx = header.findIndex(h => h.includes('alt') || h.includes('ارتفاع'));
    const accIdx = header.findIndex(h => h.includes('acc') || h.includes('دقة'));

    if (latIdx === -1 || lonIdx === -1) {
        alert('❌ لم يتم العثور على أعمدة Latitude/Longitude');
        return;
    }

    let imported = 0, skipped = 0;
    const startId = savedPoints.length;
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 2) { skipped++; continue; }
        const lat = parseFloat(row[latIdx]);
        const lon = parseFloat(row[lonIdx]);
        if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            skipped++; continue;
        }
        savedPoints.push({
            id: startId + imported + 1,
            lat, lon,
            alt: altIdx >= 0 ? (parseFloat(row[altIdx]) || 0) : 0,
            acc: accIdx >= 0 ? (parseFloat(row[accIdx]) || 0) : 0,
            timestamp: new Date().toISOString()
        });
        imported++;
    }
    updatePointsList(); persistPoints();
    let msg = `✅ تم استيراد ${imported} نقطة`;
    if (skipped > 0) msg += `\n⚠️ تم تجاهل ${skipped} سطر`;
    alert(msg);
}

function isClosePolygon() {
    const cb = document.getElementById('closePolygon');
    return cb ? cb.checked : true;
}

// ===== KML =====
function openInGoogleEarth() {
    if (savedPoints.length === 0) { alert('⚠️ لا توجد نقاط'); return; }
    const kml = buildKML(isClosePolygon());
    const fileName = getDefaultFileName('kml');
    if (window.Android && window.Android.exportKMLAndOpen)
        window.Android.exportKMLAndOpen(kml, fileName);
}

function buildKML(closed) {
    let placemarks = '';
    savedPoints.forEach(p => {
        placemarks += `
    <Placemark>
      <name>نقطة ${p.id}</name>
      <description>الارتفاع: ${p.alt.toFixed(2)} م | الدقة: ${p.acc.toFixed(2)} م</description>
      <Point><coordinates>${p.lon.toFixed(8)},${p.lat.toFixed(8)},${p.alt.toFixed(2)}</coordinates></Point>
    </Placemark>`;
    });
    if (savedPoints.length > 1) {
        const coords = savedPoints.map(p => `${p.lon.toFixed(8)},${p.lat.toFixed(8)},${p.alt.toFixed(2)}`).join(' ');
        placemarks += `
    <Placemark>
      <name>مسار المسح</name>
      <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>
    </Placemark>`;
    }
    if (savedPoints.length >= 3) {
        let polyCoords = savedPoints.map(p => `${p.lon.toFixed(8)},${p.lat.toFixed(8)},${p.alt.toFixed(2)}`).join(' ');
        if (closed) polyCoords += ` ${savedPoints[0].lon.toFixed(8)},${savedPoints[0].lat.toFixed(8)},${savedPoints[0].alt.toFixed(2)}`;
        placemarks += `
    <Placemark>
      <name>المضلع</name>
      <styleUrl>#polyStyle</styleUrl>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>${polyCoords}</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>نقاط مسّاح اليمن</name>
    <Style id="polyStyle">
      <LineStyle><color>ff00d4aa</color><width>2</width></LineStyle>
      <PolyStyle><color>4000d4aa</color></PolyStyle>
    </Style>${placemarks}
  </Document>
</kml>`;
}

// ===== حسابات جيوديسية =====
function vincentyDistance(lat1, lon1, lat2, lon2) {
    const a = 6378137.0;
    const f = 1 / 298.257223563;
    const b = (1 - f) * a;
    const L = (lon2 - lon1) * Math.PI / 180;
    const U1 = Math.atan((1 - f) * Math.tan(lat1 * Math.PI / 180));
    const U2 = Math.atan((1 - f) * Math.tan(lat2 * Math.PI / 180));
    const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
    const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

    let lambda = L, lambdaP, iterLimit = 100;
    let sinLambda, cosLambda, sinSigma, cosSigma, sigma, sinAlpha, cosSqAlpha, cos2SigmaM, C;

    do {
        sinLambda = Math.sin(lambda);
        cosLambda = Math.cos(lambda);
        sinSigma = Math.sqrt(
            (cosU2 * sinLambda) ** 2 +
            (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2
        );
        if (sinSigma === 0) return 0;
        cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
        sigma = Math.atan2(sinSigma, cosSigma);
        sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
        cosSqAlpha = 1 - sinAlpha * sinAlpha;
        cos2SigmaM = cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha;
        if (isNaN(cos2SigmaM)) cos2SigmaM = 0;
        C = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
        lambdaP = lambda;
        lambda = L + (1 - C) * f * sinAlpha * (
            sigma + C * sinSigma * (
                cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
            )
        );
    } while (Math.abs(lambda - lambdaP) > 1e-12 && --iterLimit > 0);

    if (iterLimit === 0) return haversineDistance(lat1, lon1, lat2, lon2);

    const uSq = cosSqAlpha * (a * a - b * b) / (b * b);
    const A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    const deltaSigma = B * sinSigma * (
        cos2SigmaM + B / 4 * (
            cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            B / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)
        )
    );
    return b * A * (sigma - deltaSigma);
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function polygonArea(points) {
    if (points.length < 3) return 0;
    const R = 6378137.0;
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        const lat1 = points[i].lat * Math.PI / 180;
        const lat2 = points[j].lat * Math.PI / 180;
        const lon1 = points[i].lon * Math.PI / 180;
        const lon2 = points[j].lon * Math.PI / 180;
        area += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
    }
    return Math.abs(area * R * R / 2);
}

function formatDistance(meters) {
    return meters >= 1000 ? (meters / 1000).toFixed(4) + ' كم' : meters.toFixed(2) + ' م';
}
function formatArea(sqm) {
    if (sqm >= 1000000) return (sqm / 1000000).toFixed(6) + ' كم² (' + (sqm / 10000).toFixed(4) + ' هكتار)';
    if (sqm >= 10000) return (sqm / 10000).toFixed(4) + ' هكتار (' + sqm.toFixed(2) + ' م²)';
    return sqm.toFixed(2) + ' م²';
}

function computeResults(closed) {
    const results = {
        segments: [], totalPerimeter: 0, directDistance: 0, area: 0, closed: closed
    };
    if (savedPoints.length < 2) return results;
    for (let i = 0; i < savedPoints.length - 1; i++) {
        const d = vincentyDistance(
            savedPoints[i].lat, savedPoints[i].lon,
            savedPoints[i + 1].lat, savedPoints[i + 1].lon
        );
        results.segments.push({ from: savedPoints[i].id, to: savedPoints[i + 1].id, distance: d });
        results.totalPerimeter += d;
    }
    if (closed && savedPoints.length >= 3) {
        const d = vincentyDistance(
            savedPoints[savedPoints.length - 1].lat, savedPoints[savedPoints.length - 1].lon,
            savedPoints[0].lat, savedPoints[0].lon
        );
        results.segments.push({ from: savedPoints[savedPoints.length - 1].id, to: savedPoints[0].id, distance: d, closing: true });
        results.totalPerimeter += d;
    }
    const first = savedPoints[0];
    const last = savedPoints[savedPoints.length - 1];
    results.directDistance = vincentyDistance(first.lat, first.lon, last.lat, last.lon);
    if (savedPoints.length >= 3) results.area = polygonArea(savedPoints);
    return results;
}

function calculateAll() {
    const container = document.getElementById('calcResults');
    if (savedPoints.length < 2) {
        container.innerHTML = '<p class="warn">⚠️ تحتاج نقطتين على الأقل لحساب المسافات</p>';
        return;
    }
    const closed = isClosePolygon();
    const r = computeResults(closed);
    let html = '<div class="calc-card">';
    html += '<h4>📏 المسافات بين النقاط (Vincenty)</h4>';
    r.segments.forEach(s => {
        const label = s.closing ? `${s.from} ← ${s.to} (إغلاق)` : `${s.from} ← ${s.to}`;
        html += `<div class="calc-row"><span>${label}</span><span class="val">${formatDistance(s.distance)}</span></div>`;
    });
    html += `<div class="calc-row total"><span>${closed ? 'المحيط الكلي (مضلع مغلق)' : 'المسافة الكلية'}</span><span class="val">${formatDistance(r.totalPerimeter)}</span></div>`;
    html += `<div class="calc-row"><span>المسافة المباشرة</span><span class="val">${formatDistance(r.directDistance)}</span></div>`;
    if (savedPoints.length >= 3) {
        html += '<h4 style="margin-top:14px;">📐 المساحة</h4>';
        html += `<div class="calc-row total"><span>مساحة المضلع</span><span class="val">${formatArea(r.area)}</span></div>`;
        html += `<div class="calc-row"><span>عدد النقاط</span><span class="val">${savedPoints.length}</span></div>`;
    } else {
        html += '<p class="warn" style="margin-top:10px;">⚠️ تحتاج 3 نقاط على الأقل لحساب المساحة</p>';
    }
    html += '</div>';
    container.innerHTML = html;
}

// ===== المخطط الهندسي SVG =====
function buildSchematicSVG(width, height) {
    if (savedPoints.length < 2) return '';

    const lats = savedPoints.map(p => p.lat);
    const lons = savedPoints.map(p => p.lon);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);

    const dLat = (maxLat - minLat) || 0.0001;
    const dLon = (maxLon - minLon) || 0.0001;
    const midLat = (minLat + maxLat) / 2;
    const midLon = (minLon + maxLon) / 2;

    const pad = 70;
    const drawW = width - 2 * pad;
    const drawH = height - 2 * pad;

    // مراعاة أن خط العرض/الطول ليسا بنفس المقياس عند خطوط العرض المختلفة
    const latFactor = Math.cos(midLat * Math.PI / 180);
    const scaleX = drawW / (dLon * latFactor);
    const scaleY = drawH / dLat;
    const scale = Math.min(scaleX, scaleY);

    const centerX = width / 2;
    const centerY = height / 2;

    const toXY = (lat, lon) => ({
        x: centerX + (lon - midLon) * latFactor * scale,
        y: centerY - (lat - midLat) * scale
    });

    const pts = savedPoints.map(p => {
        const xy = toXY(p.lat, p.lon);
        return { ...xy, id: p.id, lat: p.lat, lon: p.lon };
    });

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`;

    // خلفية
    svg += `<rect width="${width}" height="${height}" fill="#f8fbf9" stroke="#00a888" stroke-width="1.5"/>`;

    // شبكة خفيفة
    svg += `<g stroke="#e6f3ee" stroke-width="0.6">`;
    for (let i = 1; i < 10; i++) {
        svg += `<line x1="${i*width/10}" y1="0" x2="${i*width/10}" y2="${height}"/>`;
        svg += `<line x1="0" y1="${i*height/10}" x2="${width}" y2="${i*height/10}"/>`;
    }
    svg += `</g>`;

    const closed = isClosePolygon();
    const polyPts = pts.map(p => `${p.x},${p.y}`).join(' ');

    // المضلع/المسار
    if (pts.length >= 3 && closed) {
        svg += `<polygon points="${polyPts}" fill="rgba(0,168,136,0.18)" stroke="#00a888" stroke-width="2.5" stroke-linejoin="round"/>`;
    } else {
        svg += `<polyline points="${polyPts}" fill="none" stroke="#00a888" stroke-width="2.5" stroke-linejoin="round"/>`;
        if (pts.length >= 3) {
            // إظهار خط الإغلاق بشكل متقطع
            svg += `<line x1="${pts[pts.length-1].x}" y1="${pts[pts.length-1].y}" x2="${pts[0].x}" y2="${pts[0].y}" stroke="#00a888" stroke-width="1.5" stroke-dasharray="6,4" opacity="0.5"/>`;
        }
    }

    // وسوم المسافات على كل ضلع
    const segments = [];
    for (let i = 0; i < pts.length - 1; i++) segments.push({ from: i, to: i + 1 });
    if (closed && pts.length >= 3) segments.push({ from: pts.length - 1, to: 0, closing: true });

    segments.forEach(s => {
        const p1 = pts[s.from];
        const p2 = pts[s.to];
        const d = vincentyDistance(p1.lat, p1.lon, p2.lat, p2.lon);
        const dStr = d >= 1000 ? (d / 1000).toFixed(3) + ' كم' : d.toFixed(1) + ' م';

        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;

        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const offset = 22;
        const ox = -dy / len * offset;
        const oy = dx / len * offset;

        const lx = mx + ox;
        const ly = my + oy;

        const labelW = 90;
        const labelH = 22;

        svg += `<rect x="${lx - labelW/2}" y="${ly - labelH/2}" width="${labelW}" height="${labelH}" rx="5" fill="#ffffff" stroke="#00a888" stroke-width="1"/>`;
        svg += `<text x="${lx}" y="${ly + 4}" text-anchor="middle" font-size="12" font-family="Arial" font-weight="bold" fill="#005a4a">${dStr}</text>`;
    });

    // رؤوس النقاط
    pts.forEach((p, i) => {
        svg += `<circle cx="${p.x}" cy="${p.y}" r="11" fill="#ff3366" stroke="#fff" stroke-width="2.5"/>`;
        svg += `<text x="${p.x}" y="${p.y + 5}" text-anchor="middle" font-size="12" font-weight="bold" fill="#fff" font-family="Arial">${i + 1}</text>`;
    });

    // بوصلة في الأعلى يمين
    const cx = width - 45;
    const cy = 55;
    svg += `<circle cx="${cx}" cy="${cy}" r="26" fill="#ffffff" stroke="#00a888" stroke-width="1.5"/>`;
    svg += `<polygon points="${cx},${cy-20} ${cx-8},${cy+8} ${cx},${cy+3} ${cx+8},${cy+8}" fill="#00a888"/>`;
    svg += `<text x="${cx}" y="${cy+22}" text-anchor="middle" font-size="11" font-weight="bold" fill="#005a4a" font-family="Arial">N</text>`;

    // مقياس رسم
    const totalMeters = vincentyDistance(
        savedPoints[0].lat, savedPoints[0].lon,
        savedPoints[0].lat, savedPoints[0].lon + (1 / (111320 * latFactor))
    ); // مسافة 1 درجة طول
    const oneDegInScale = (1 * latFactor * scale); // عرض درجة واحدة بالبكسل

    // اختر مقياساً مناسباً للرسم
    let scaleBarMeters = 10;
    if (oneDegInScale > 0) {
        const metersPerPx = 111320 / scale * 1; // تقريب
    }
    // نحسب المقياس الفعلي بالبكسل لكل متر
    const sampleDist = vincentyDistance(
        savedPoints[0].lat, savedPoints[0].lon,
        savedPoints[0].lat + 0.001, savedPoints[0].lon
    ); // مسافة 0.001 درجة عرض بالمتر
    const samplePx = 0.001 * scale; // بالبكسل

    // المقياس: بكسلات لكل متر
    const pxPerMeter = samplePx / sampleDist;

    // اختر طول شريط مناسب (~120 px)
    const targetPx = 120;
    let barMeters = targetPx / pxPerMeter;
    // تقريب لأرقام جميلة
    const niceValues = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    for (const v of niceValues) {
        if (barMeters <= v) { barMeters = v; break; }
    }
    const barPx = barMeters * pxPerMeter;
    const barLabel = barMeters >= 1000 ? (barMeters / 1000) + ' كم' : barMeters + ' م';

    const barX = 30;
    const barY = height - 30;
    svg += `<line x1="${barX}" y1="${barY}" x2="${barX + barPx}" y2="${barY}" stroke="#005a4a" stroke-width="2"/>`;
    svg += `<line x1="${barX}" y1="${barY - 5}" x2="${barX}" y2="${barY + 5}" stroke="#005a4a" stroke-width="2"/>`;
    svg += `<line x1="${barX + barPx}" y1="${barY - 5}" x2="${barX + barPx}" y2="${barY + 5}" stroke="#005a4a" stroke-width="2"/>`;
    svg += `<text x="${barX + barPx / 2}" y="${barY - 8}" text-anchor="middle" font-size="11" font-weight="bold" fill="#005a4a" font-family="Arial">${barLabel}</text>`;

    // المساحة في مركز المضلع
    if (pts.length >= 3) {
        const area = polygonArea(savedPoints);
        const areaStr = formatArea(area);
        const cx2 = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const cy2 = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        const boxW = 220;
        svg += `<rect x="${cx2 - boxW/2}" y="${cy2 - 15}" width="${boxW}" height="30" rx="8" fill="#007a63" opacity="0.92"/>`;
        svg += `<text x="${cx2}" y="${cy2 + 5}" text-anchor="middle" font-size="13" font-weight="bold" font-family="Arial" fill="#ffffff">المساحة: ${areaStr}</text>`;
    }

    // عنوان صغير أعلى يسار
    svg += `<text x="30" y="30" font-size="13" font-weight="bold" fill="#005a4a" font-family="Arial">المخطط الهندسي</text>`;
    svg += `<text x="30" y="48" font-size="10" fill="#555" font-family="Arial">عدد النقاط: ${pts.length}</text>`;

    svg += '</svg>';
    return svg;
}

// ===== طباعة PDF =====
function printPDF() {
    if (savedPoints.length === 0) {
        alert('⚠️ لا توجد نقاط');
        return;
    }

    const closed = isClosePolygon();
    const r = computeResults(closed);
    const now = new Date();
    const dateStr = now.toLocaleString('ar-YE', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
    });

    const pointsRows = savedPoints.map(p => `
        <tr>
            <td>${p.id}</td>
            <td class="ltr">${p.lat.toFixed(8)}</td>
            <td class="ltr">${p.lon.toFixed(8)}</td>
            <td class="ltr">${p.alt.toFixed(2)}</td>
            <td class="ltr">${p.acc.toFixed(2)}</td>
        </tr>`).join('');

    const distancesRows = r.segments.map(s => `
        <tr>
            <td>${s.closing ? `${s.from} ← ${s.to} (إغلاق)` : `${s.from} ← ${s.to}`}</td>
            <td class="ltr">${formatDistance(s.distance)}</td>
        </tr>`).join('');

    // المخطط الهندسي SVG
    const svgDiagram = buildSchematicSVG(760, 520);

    // قسم صورة Google Earth
    const satelliteSection = satelliteImageData ? `
        <div class="page-break"></div>
        <h2>🛰️ الإسقاط على الواقع (Google Earth)</h2>
        <div class="satellite-container">
            <img src="${satelliteImageData}" class="satellite-img" alt="صورة Google Earth">
        </div>
        <div class="satellite-caption">
            صورة جوية للموقع من Google Earth مع إظهار حدود المنطقة الممسوحة
        </div>
    ` : '';

    const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body {
        font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
        color: #111;
        direction: rtl;
        margin: 0;
        padding: 0;
    }
    .page-break { page-break-before: always; }
    .header {
        text-align: center;
        border-bottom: 3px solid #00a888;
        padding-bottom: 10px;
        margin-bottom: 18px;
    }
    .header h1 { color: #007a63; font-size: 22px; margin: 0 0 4px; }
    .header .sub { color: #555; font-size: 12px; }
    .meta {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        color: #333;
        margin-bottom: 14px;
        flex-wrap: wrap;
        gap: 6px;
    }
    h2 {
        font-size: 15px;
        color: #007a63;
        margin: 18px 0 10px;
        border-right: 4px solid #00a888;
        padding-right: 8px;
    }
    table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11.5px;
        margin-bottom: 8px;
    }
    th, td {
        border: 1px solid #999;
        padding: 6px 8px;
        text-align: center;
    }
    th {
        background: #e8f6f2;
        color: #005a4a;
        font-weight: bold;
    }
    tr:nth-child(even) td { background: #fafafa; }
    .ltr { direction: ltr; font-family: 'Courier New', monospace; }
    .diagram-container {
        text-align: center;
        margin: 14px 0;
        padding: 10px;
        background: #fafdfc;
        border: 1px solid #cfe9e0;
        border-radius: 8px;
    }
    .diagram-container svg { max-width: 100%; height: auto; }
    .satellite-container {
        text-align: center;
        margin: 14px 0;
        padding: 8px;
        background: #fafdfc;
        border: 1px solid #cfe9e0;
        border-radius: 8px;
    }
    .satellite-img {
        max-width: 100%;
        max-height: 460px;
        border-radius: 6px;
        border: 2px solid #00a888;
    }
    .satellite-caption {
        text-align: center;
        font-size: 11px;
        color: #666;
        margin-top: 6px;
        font-style: italic;
    }
    .summary {
        background: #f0fbf7;
        border: 2px solid #00a888;
        border-radius: 6px;
        padding: 12px;
        margin-top: 16px;
    }
    .summary-row {
        display: flex;
        justify-content: space-between;
        font-size: 13px;
        padding: 6px 0;
        border-bottom: 1px dashed #a8d5c9;
    }
    .summary-row:last-child { border-bottom: none; }
    .summary-row.total {
        font-weight: bold;
        font-size: 14px;
        color: #005a4a;
        border-top: 2px solid #00a888;
        padding-top: 10px;
        margin-top: 6px;
    }
    .summary-row .val { direction: ltr; font-family: 'Courier New', monospace; }
    .footer {
        margin-top: 24px;
        text-align: center;
        font-size: 10px;
        color: #888;
        border-top: 1px solid #ccc;
        padding-top: 8px;
    }
    .badge {
        display: inline-block;
        background: #00a888;
        color: #fff;
        padding: 2px 10px;
        border-radius: 10px;
        font-size: 10px;
    }
</style>
</head>
<body>
    <div class="header">
        <h1>📍 تقرير مسح ميداني</h1>
        <div class="sub">مسّاح اليمن — Yemen Surveyor</div>
    </div>

    <div class="meta">
        <div><b>التاريخ:</b> ${dateStr}</div>
        <div><b>عدد النقاط:</b> ${savedPoints.length}</div>
        <div><b>نوع المضلع:</b> <span class="badge">${closed ? 'مغلق' : 'مفتوح'}</span></div>
    </div>

    ${svgDiagram ? `
    <h2>📐 المخطط الهندسي للمسح</h2>
    <div class="diagram-container">
        ${svgDiagram}
    </div>` : ''}

    <h2>📌 جدول النقاط</h2>
    <table>
        <thead>
            <tr>
                <th>#</th>
                <th>خط العرض</th>
                <th>خط الطول</th>
                <th>الارتفاع (م)</th>
                <th>الدقة (م)</th>
            </tr>
        </thead>
        <tbody>${pointsRows}</tbody>
    </table>

    <h2>📏 المسافات (صيغة Vincenty)</h2>
    <table>
        <thead>
            <tr><th>من ← إلى</th><th>المسافة</th></tr>
        </thead>
        <tbody>${distancesRows}</tbody>
    </table>

    <div class="summary">
        <div class="summary-row">
            <span>المسافة الكلية (المحيط)</span>
            <span class="val">${formatDistance(r.totalPerimeter)}</span>
        </div>
        <div class="summary-row">
            <span>المسافة المباشرة (أول نقطة ← آخر نقطة)</span>
            <span class="val">${formatDistance(r.directDistance)}</span>
        </div>
        ${savedPoints.length >= 3 ? `
        <div class="summary-row total">
            <span>📐 مساحة المضلع</span>
            <span class="val">${formatArea(r.area)}</span>
        </div>` : ''}
    </div>

    ${satelliteSection}

    <div class="footer">
        تم إنشاء هذا التقرير بواسطة تطبيق مسّاح اليمن
        | الصيغ الجيوديسية: WGS-84 / Vincenty
    </div>
</body>
</html>`;

    const jobName = `تقرير_مسح_${now.toISOString().substring(0, 10)}`;
    if (window.Android && window.Android.printHTML) {
        window.Android.printHTML(html, jobName);
    } else {
        alert('⚠️ الطباعة متاحة فقط داخل التطبيق على أندرويد');
    }
}

function resetApp() {
    currentLocation = { lat: 0, lon: 0, alt: 0, acc: 0 };
    ['latValue','lonValue','altValue','accValue'].forEach(id => document.getElementById(id).textContent = '--');
    document.getElementById('saveStatus').textContent = '';
    if (window.Android && window.Android.stopTracking) window.Android.stopTracking();
    showScreen('calibrationScreen');
    calibrationProgress = 0;
    document.getElementById('calibrationProgress').style.width = '0%';
    document.getElementById('calibrationStatus').textContent = 'في انتظار الحركة...';
    startCalibration();
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}
function showResults() { showScreen('resultScreen'); }

document.addEventListener('DOMContentLoaded', () => {
    loadPersistedPoints();
    startCalibration();
});
