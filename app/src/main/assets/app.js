'use strict';

const byId = id => document.getElementById(id);
const text = (id, value) => { if (byId(id).textContent !== value) byId(id).textContent = value; };
const visible = (id, value) => { byId(id).hidden = !value; };
const POINTS_KEY = 'yemen_surveyor_points';
const ID_KEY = 'yemen_surveyor_next_id';
const IMAGE_KEY = 'yemen_surveyor_satellite';
const MAX_POINTS = 10000;
let points = [];
let nextId = 1;
let picture = null;
let state = null;
let selectedTarget = null;
let lastInvite = '';

function callAndroid(name, ...argumentsList) {
    if (window.Android && typeof window.Android[name] === 'function') window.Android[name](...argumentsList);
}

function requestActivation() {
    if (byId('email').reportValidity()) callAndroid('requestActivation', byId('email').value);
}

function activate() {
    if (byId('email').reportValidity()) callAndroid('activate', byId('email').value, byId('activationToken').value.trim());
}

function showPanel(name) {
    document.querySelectorAll('.panel').forEach(panel => { panel.hidden = panel.id !== name; });
    document.querySelectorAll('.tab').forEach(button => {
        button.classList.toggle('current', button.dataset.screen === name);
        button.setAttribute('aria-pressed', button.dataset.screen === name ? 'true' : 'false');
    });
    if (name === 'points') showCalculations();
    if (name === 'report') previewReport();
    window.scrollTo(0, 0);
}

function updateOptions(id, entries, placeholder) {
    const select = byId(id);
    const definition = JSON.stringify(entries);
    if (select.dataset.options === definition) return;
    const value = select.value;
    select.replaceChildren();
    const empty = new Option(placeholder, '');
    select.add(empty);
    entries.forEach(entry => select.add(new Option(entry.label, entry.value)));
    if (entries.some(entry => entry.value === value)) select.value = value;
    else if (entries.length) select.value = entries[0].value;
    select.dataset.options = definition;
}

function showFix(fix, rtk) {
    text('liveLat', fixed(fix?.lat, 8));
    text('liveLon', fixed(fix?.lon, 8));
    text('liveAlt', Number.isFinite(fix?.alt) ? fixed(fix.alt, 2) + ' م' : '—');
    text('liveAcc', fix?.horizontal95 ? 'R95 ' + fixed(fix.horizontal95, 3) + ' م' :
        fix?.acc ? fixed(fix.acc, 2) + ' م' : '—');
    text('fixSource', fix ? SOURCE_LABELS[fix.source] : 'انتظار الموقع');
    const metrics = [];
    if (fix) {
        metrics.push(fix.stable ? 'قراءة مستقرة' : 'بانتظار استقرار القراءة');
        if (fix.satellites) metrics.push(fix.satellites + ' قمرًا');
        if (fix.datum) metrics.push('ارتفاع ' + datumLabel(fix.datum));
        if (Number.isFinite(fix.correctionAge)) metrics.push('عمر التصحيح ' + fixed(fix.correctionAge, 1) + ' ث');
    } else if (rtk.selected) metrics.push('بانتظار قراءة حديثة من المستقبل');
    else if (!state.permission) metrics.push('اسمح بالموقع الدقيق لبدء القياس');
    else if (!state.locationEnabled) metrics.push('خدمة الموقع متوقفة');
    else metrics.push('انتقل إلى مكان مفتوح وانتظر تحديث الموقع');
    text('fixState', metrics.join(' · '));
    visible('locationPermission', !rtk.selected && (!state.permission || !state.locationEnabled));
    text('receiverStatus', rtk.status);
}

function renderStations(list, peers) {
    list.replaceChildren(...peers.map(peer => {
        const li = document.createElement('li');
        const title = document.createElement('strong');
        const role = { ROVER: 'متحرك', REFERENCE: 'مرجع ثابت' }[peer.role] || 'بانتظار تعيين الدور';
        title.textContent = peer.name + ' · ' + role;
        const detail = document.createElement('p');
        detail.className = 'muted';
        const fix = peer.fix;
        const parts = [fix ? SOURCE_LABELS[fix.source] : 'بانتظار الموقع'];
        if (fix) parts.push(fix.stable ? 'مستقر' : 'بانتظار الثبات');
        if (fix?.horizontal95) parts.push('R95 ' + fixed(fix.horizontal95, 3) + ' م');
        else if (fix?.acc) parts.push('تقدير أفقي ' + fixed(fix.acc, 2) + ' م');
        if (fix) parts.push(fixed(fix.lat, 8) + ', ' + fixed(fix.lon, 8));
        if (Number.isFinite(peer.range)) parts.push('إلى المحطة ' + fixed(peer.range, 3) + ' م');
        if (Number.isFinite(peer.bearing)) parts.push('اتجاه ' + fixed(peer.bearing, 2) + '° من الشمال');
        if (peer.relay) parts.push('عبر ' + peer.relay);
        if (Number.isFinite(peer.residual)) parts.push('فرق عن نقطة التحكم ' + fixed(peer.residual, 3) + ' م');
        else if (Number.isFinite(peer.drift)) parts.push('تغيّر عن أول قراءة ' + fixed(peer.drift, 2) + ' م');
        detail.textContent = parts.join(' · ');
        li.append(title, detail);
        return li;
    }));
    if (!peers.length) {
        const empty = document.createElement('li');
        empty.className = 'muted';
        empty.textContent = 'بانتظار انضمام الأجهزة';
        list.append(empty);
    }
}

function updateStations(peers, busy, shot) {
    renderStations(byId('stationList'), peers);
    visible('measurement', !!shot);
    if (shot) renderStations(byId('measurements'), shot);
    updateOptions('assignDevice', peers.map(peer => ({ value: peer.id, label: peer.name })), 'اختر جهازًا');
    updateOptions('rover', peers.filter(peer => peer.role === 'ROVER').map(peer =>
        ({ value: peer.id, label: peer.name })), 'اختر الهاتف المتحرك');
    byId('captureRover').disabled = busy || !byId('rover').value;
    visible('cancelCapture', busy);
}

function onSurveyState(next) {
    state = next;
    const active = next.activation;
    visible('activation', !active.active);
    visible('workspace', active.active);
    visible('licenseSummary', active.active);
    if (!active.active) {
        text('activationReason', active.reason);
        text('activationMessage', active.message);
        byId('device').value = active.device;
        byId('requestActivation').disabled = !active.configured;
        byId('activate').disabled = !active.configured;
        return;
    }
    if (byId('activationToken').value) byId('activationToken').value = '';
    text('licenseSummary', (active.plan === 'trial' ? 'مجاني حتى ' : 'مفعّل حتى ') +
        new Date(active.expires * 1000).toLocaleDateString('ar-YE'));

    const field = next.field;
    showFix(next.fix, next.rtk);
    visible('openHost', !field.hosting && !field.guest);
    visible('hostControl', field.hosting);
    visible('joinForm', !field.guest);
    visible('leave', field.guest);
    visible('hotspotCredentials', !!field.ssid);
    text('hotspotCredentials', field.ssid ? 'Wi-Fi: ' + field.ssid + '  ·  كلمة المرور: ' + field.password : '');
    text('networkStatus', field.networkMessage);
    text('guestStatus', field.guestMessage);
    text('hostStatus', field.message || '');
    updateOptions('addresses', field.addresses.map(address =>
        ({ label: address.ip + ' · ' + address.adapter, value: address.ip })), 'بانتظار عنوان Wi-Fi');
    visible('relayControls', field.role === 'REFERENCE');
    visible('startRelay', !field.relayHotspot);
    visible('stopRelay', field.relayHotspot);
    visible('relayCredentials', field.relayHotspot && !!field.ssid);
    text('relayCredentials', field.relayHotspot ? 'Wi-Fi: ' + field.ssid + '  ·  كلمة المرور: ' + field.password : '');
    if (field.hosting) updateStations(field.peers || [], field.busy, field.lastShot);
    if (field.invite && field.invite !== lastInvite) {
        lastInvite = field.invite;
        byId('inviteInput').value = field.invite;
        byId('joinPanel').open = true;
        showPanel('field');
    }
    if (!field.invite) lastInvite = '';
    if (field.capture) {
        if (points.some(p => p.captureId === field.capture.captureId) || appendCapture(field.capture)) {
            callAndroid('acknowledge', field.capture.captureId);
        }
    }
    showStakeout();
}

function shareInvite() {
    callAndroid('shareInvitation', byId('addresses').value);
}

function assignRole() {
    callAndroid('assignRole', byId('assignDevice').value, byId('assignRole').value);
}

function joinHost() {
    callAndroid('join', byId('inviteInput').value.trim(), byId('deviceName').value,
        byId('controlLat').value, byId('controlLon').value);
}

function setBase() {
    callAndroid('setReference', byId('baseLat').value, byId('baseLon').value);
}

function captureRover() {
    callAndroid('captureRover', byId('rover').value, byId('strictRtk').checked);
}

function onReceivers(devices) {
    updateOptions('devices', devices.map(d => ({ label: d.name + ' · ' + d.address, value: d.address })),
        'لا يوجد جهاز مقترن');
    if (!devices.length) text('receiverStatus', 'اقرن المستقبل من إعدادات Bluetooth أولًا');
}

function connectRtk() {
    const address = byId('devices').value;
    if (address) callAndroid('connectReceiver', address);
}

function onCaptureMessage(message) {
    text('captureMessage', message);
}

function onLocalCapture(fix) {
    appendCapture(fix);
}

function nullable(value) {
    if (value == null || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function isCoordinate(lat, lon) {
    return Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180;
}

function normalizedPoint(source, id) {
    const lat = nullable(source.lat), lon = nullable(source.lon);
    if (!isCoordinate(lat, lon)) return null;
    return {
        id, lat, lon, alt: nullable(source.alt), acc: nullable(source.acc) > 0 ? Number(source.acc) : null,
        horizontal95: nullable(source.horizontal95) > 0 ? Number(source.horizontal95) : null,
        source: Object.hasOwn(SOURCE_LABELS, source.source) ? source.source : 'LEGACY',
        datum: ['ELLIPSOID', 'MSL'].includes(source.datum) ? source.datum : null,
        correctionAge: nullable(source.correctionAge), satellites: nullable(source.satellites),
        baseline: nullable(source.baseline), baseAccuracy: nullable(source.baseAccuracy),
        bearing: nullable(source.bearing), relay: typeof source.relay === 'string' ? source.relay : '',
        timestamp: typeof source.timestamp === 'string' && !isNaN(Date.parse(source.timestamp))
            ? new Date(source.timestamp).toISOString() : '',
        captureId: typeof source.captureId === 'string' ? source.captureId : null
    };
}

function storePoints(list) {
    try {
        localStorage.setItem(POINTS_KEY, JSON.stringify(list));
        points = list;
        try { localStorage.setItem(ID_KEY, String(nextId)); } catch (_) {}
        renderPoints();
        return true;
    } catch (_) {
        alert('تعذر حفظ النقاط. صدّر البيانات الحالية وحرّر مساحة تخزين ثم أعد المحاولة.');
        return false;
    }
}

function appendCapture(fix) {
    if (points.length >= MAX_POINTS) {
        text('captureMessage', 'وصلت إلى الحد الأقصى للنقاط. صدّر النقاط وأخلِ القائمة.');
        return false;
    }
    const point = normalizedPoint({ ...fix, timestamp: new Date().toISOString() }, nextId);
    if (!point) return false;
    nextId++;
    if (!storePoints([...points, point])) {
        nextId--;
        return false;
    }
    text('captureMessage', 'حُفظت النقطة P' + point.id +
        (point.baseline == null ? '' : ' · البعد الأفقي عن المحطة ' + fixed(point.baseline, 3) + ' م'));
    return true;
}

function rowButton(label, action, extra = '') {
    const button = document.createElement('button');
    button.className = 'quiet ' + extra;
    button.textContent = label;
    button.onclick = action;
    return button;
}

function renderPoints() {
    text('pointCount', points.length);
    const list = byId('pointsList');
    const fragment = document.createDocumentFragment();
    if (!points.length) {
        const empty = document.createElement('li');
        empty.className = 'muted';
        empty.textContent = 'لم تُحفظ نقاط بعد';
        fragment.append(empty);
    }
    for (const point of points) {
        const li = document.createElement('li');
        const title = document.createElement('div');
        title.className = 'section-head';
        const id = document.createElement('strong');
        id.textContent = 'P' + point.id;
        const coordinates = document.createElement('span');
        coordinates.className = 'coords';
        coordinates.textContent = fixed(point.lat, 8) + ', ' + fixed(point.lon, 8);
        title.append(id, coordinates);
        const details = document.createElement('p');
        details.className = 'muted';
        details.textContent = [SOURCE_LABELS[point.source],
            point.horizontal95 ? 'R95 ' + fixed(point.horizontal95, 3) + ' م' : point.acc ? 'تقدير أفقي ' + fixed(point.acc, 2) + ' م' : '',
            point.baseline == null ? '' : 'البعد عن المحطة ' + fixed(point.baseline, 3) + ' م',
            point.bearing == null ? '' : 'الاتجاه ' + fixed(point.bearing, 2) + '° من الشمال',
            point.baseAccuracy == null ? '' : 'تقدير موقع المحطة ' + fixed(point.baseAccuracy, 3) + ' م',
            point.relay ? 'عبر ' + point.relay : ''
        ].filter(Boolean).join(' · ');
        const actions = document.createElement('div');
        actions.className = 'point-actions';
        actions.append(rowButton('إسقاط', () => { selectedTarget = point; showPanel('field'); showStakeout(); }),
            rowButton('Google Maps', () => callAndroid('openMap', String(point.lat), String(point.lon))),
            rowButton('تقديم', () => movePoint(point, -1)),
            rowButton('تأخير', () => movePoint(point, 1)),
            rowButton('حذف', () => removePoint(point), 'danger'));
        li.append(title, details, actions);
        fragment.append(li);
    }
    list.replaceChildren(fragment);
    showCalculations();
    updateGridLabel();
}

function movePoint(point, offset) {
    const order = [...points];
    const from = order.indexOf(point), to = from + offset;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    storePoints(order);
}

function tidySavedOrder() {
    const order = tidyOrder(points, byId('closePolygon').checked);
    if (order.every((p, i) => p === points[i])) {
        alert('لا توجد أضلاع متقاطعة في الترتيب الحالي');
        return;
    }
    if (confirm('إزالة التقاطعات وتحديث ترتيب وصل النقاط؟ تبقى أرقام النقاط كما هي.')) storePoints(order);
}

function removePoint(point) {
    if (confirm('حذف النقطة P' + point.id + '؟') && storePoints(points.filter(p => p.id !== point.id))) {
        if (selectedTarget?.id === point.id) selectedTarget = null;
    }
}

function clearPoints() {
    if (points.length && confirm('هل تريد مسح جميع النقاط المحفوظة؟') && storePoints([])) selectedTarget = null;
}

function showStakeout() {
    const remote = state?.field?.target;
    const target = remote || selectedTarget;
    visible('stakeoutCard', !!target);
    if (!target) return;
    const fix = state.fix;
    text('stakeoutTarget', (target.id ? 'P' + target.id + ' · ' : '') + fixed(target.lat, 8) + ', ' + fixed(target.lon, 8));
    visible('sendTarget', state.field.hosting && !remote);
    visible('clearTarget', !remote);
    if (!fix) {
        text('stakeoutGuide', 'بانتظار موقع الجهاز');
        text('stakeoutAccuracy', '');
        return;
    }
    const solution = WGS84.Inverse(fix.lat, fix.lon, target.lat, target.lon);
    const heading = ((solution.azi1 + 360) % 360).toFixed(1);
    text('stakeoutGuide', fixed(solution.s12, 3) + ' م' +
        (solution.s12 < 0.001 ? '' : ' · ' + heading + '° من الشمال الحقيقي'));
    const uncertainty = fix.horizontal95 || fix.acc;
    text('stakeoutAccuracy', uncertainty ? 'تقدير خطأ موقع الجهاز ' + fixed(uncertainty, 3) + ' م' +
        (solution.s12 <= uncertainty ? ' · الهدف داخل نطاق عدم اليقين الحالي' : '') : '');
}

function sendStakeout(clear) {
    if (!clear && !selectedTarget) return;
    callAndroid('stakeout', byId('rover').value,
        clear ? '' : String(selectedTarget.lat), clear ? '' : String(selectedTarget.lon));
}

function clearStakeout() {
    if (state?.field?.hosting && byId('rover').value) sendStakeout(true);
    selectedTarget = null;
    showStakeout();
}

function onStakeoutMessage(message) {
    text('stakeoutStatus', message);
}

function showCalculations() {
    const container = byId('calcResults');
    const result = solveGeometry(points, byId('closePolygon').checked);
    const rows = [];
    if (result.segments.length) {
        rows.push([result.closed ? 'المحيط' : 'طول المسار', fixed(result.total, 2) + ' م']);
        rows.push(['المسافة بين الأولى والأخيرة', fixed(result.direct, 2) + ' م']);
        if (result.area != null) rows.push(['المساحة', fixed(result.area, 2) + ' م²']);
        result.segments.forEach(s => rows.push(['P' + points[s.from].id + ' ← P' + points[s.to].id, fixed(s.meters, 2) + ' م']));
    }
    container.innerHTML = rows.length ? rows.map(([label, value]) =>
        '<div class="calc-line"><span>' + xml(label) + '</span><bdi>' + xml(value) + '</bdi></div>').join('')
        : '<p class="muted">احفظ نقطتين على الأقل لحساب المسافة.</p>';
}

function updateGridLabel() {
    if (!points.length) { text('gridLabel', ''); return; }
    try {
        const grid = utmGrid(points, byId('utmZone').value);
        text('gridLabel', 'WGS 84 / UTM ' + grid.zone + (grid.south ? 'S' : 'N') +
            ' · EPSG:' + grid.epsg + ' · DXF أفقي بالمتر');
    } catch (error) { text('gridLabel', error.message); }
}

function fileName(ext, prefix = 'survey') {
    return prefix + '_' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.' + ext;
}

function havePoints() {
    if (points.length) return true;
    alert('احفظ نقطة واحدة على الأقل');
    return false;
}

function exportFile(format) {
    if (!havePoints()) return;
    const closed = byId('closePolygon').checked;
    try {
        if (format === 'xlsx') callAndroid('saveFile', buildWorkbook(points), fileName('xlsx'), 'xlsx');
        if (format === 'csv') callAndroid('saveFile', buildCsv(points), fileName('csv'), 'csv');
        if (format === 'kml') callAndroid('saveFile', buildKml(points, closed), fileName('kml'), 'kml');
        if (format === 'dxf' || format === 'pnezd') {
            const grid = utmGrid(points, byId('utmZone').value);
            if (format === 'dxf') callAndroid('saveFile', buildDxf(grid, closed),
                fileName('dxf', 'survey_EPSG' + grid.epsg), 'dxf');
            else callAndroid('saveFile', buildPnezd(grid), fileName('csv', 'PNEZD_EPSG' + grid.epsg), 'csv');
        }
    } catch (error) { alert(error.message); }
}

function shareCsv() {
    if (havePoints()) callAndroid('shareCSV', buildCsv(points), fileName('csv'));
}

function openEarth() {
    if (havePoints()) callAndroid('openEarth', buildKml(points, byId('closePolygon').checked), fileName('kml'));
}

async function importFile(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const room = MAX_POINTS - points.length;
    if (file.size > 15_000_000 || room <= 0) {
        alert('الملف كبير أو لا توجد مساحة لإضافة نقاط. الحد ١٠٬٠٠٠ نقطة.');
        return;
    }
    try {
        const source = XLSX.read(await file.arrayBuffer(), { type: 'array', sheetRows: room + 1, sheets: 0 });
        const rows = XLSX.utils.sheet_to_json(source.Sheets[source.SheetNames[0]], { header: 1, raw: true });
        const header = (rows[0] || []).map(h => String(h).toLowerCase().trim());
        const [lat, lon, alt, acc, datum] = [
            /^(latitude|lat|خط العرض|العرض)$/, /^(longitude|lon|lng|خط الطول|الطول)$/,
            /^(alt|altitude|elevation|ارتفاع|الارتفاع)/, /^(acc|accuracy|الدقة|دقة)/, /^height datum$/
        ].map(pattern => header.findIndex(h => pattern.test(h)));
        if (lat < 0 || lon < 0) throw new Error('يجب أن يحتوي الصف الأول على عمودي Latitude وLongitude.');
        const oldNext = nextId;
        const imported = [];
        rows.slice(1).forEach(row => {
            const point = normalizedPoint({
                lat: row[lat], lon: row[lon], alt: row[alt], acc: row[acc], datum: row[datum],
                source: 'IMPORTED', timestamp: new Date().toISOString()
            }, nextId);
            if (point) { imported.push(point); nextId++; }
        });
        if (!imported.length) throw new Error('لا توجد إحداثيات صالحة في الملف');
        if (!storePoints([...points, ...imported])) { nextId = oldNext; return; }
        alert('تم استيراد ' + imported.length + ' نقطة');
    } catch (error) { alert('تعذر الاستيراد. ' + error.message); }
}

function updatePhoto() {
    const element = byId('imagePreview');
    element.hidden = !picture;
    if (picture) element.src = picture;
    else element.removeAttribute('src');
}

function attachImage(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type) || file.size > 20_000_000) { alert('اختر صورة بحجم أقل من ٢٠ ميغابايت'); return; }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1300 / Math.max(image.width, image.height));
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        picture = canvas.toDataURL('image/jpeg', .78);
        URL.revokeObjectURL(url);
        try { localStorage.setItem(IMAGE_KEY, picture); } catch (_) { alert('تتوفر الصورة للتقرير الحالي'); }
        updatePhoto();
    };
    image.onerror = () => { URL.revokeObjectURL(url); alert('تعذر فتح الصورة'); };
    image.src = url;
}

function removeImage() {
    picture = null;
    localStorage.removeItem(IMAGE_KEY);
    updatePhoto();
}

function reportOptions() {
    return {
        title: byId('reportTitle').value.trim() || 'تقرير مسح ميداني',
        project: byId('projectName').value.trim(), client: byId('clientName').value.trim(),
        surveyor: byId('surveyorName').value.trim(), notes: byId('notes').value.trim(),
        draw: byId('drawType').value, order: byId('reportOrder').value, labels: byId('drawLabels').value,
        orientation: byId('paper').value, theme: REPORT_THEMES[byId('reportTheme').value] || REPORT_THEMES.navy,
        image: byId('includeImage').checked, date: new Date().toLocaleDateString('ar-YE')
    };
}

function previewReport() {
    const options = reportOptions();
    const arranged = arrangeReportPoints(points, options);
    const plan = makePlan(arranged, options, solveGeometry(arranged, options.draw === 'polygon'));
    byId('reportPreview').innerHTML = plan.svg;
    text('reportMessage', !points.length ? 'أضف نقاطًا قبل إعداد التقرير' :
        plan.hidden ? 'التسميات المتزاحمة تظهر في جداول التقرير.' : '');
}

function printReport() {
    if (!havePoints()) return;
    const options = reportOptions();
    callAndroid('printReport', buildReport(arrangeReportPoints(points, options), options, picture), options.orientation === 'landscape');
}

document.addEventListener('DOMContentLoaded', () => {
    try {
        const stored = JSON.parse(localStorage.getItem(POINTS_KEY) || '[]');
        const used = new Set();
        if (Array.isArray(stored)) stored.slice(0, MAX_POINTS).forEach(raw => {
            if (raw == null) return;
            let id = Number(raw.id);
            if (!Number.isSafeInteger(id) || id < 1 || used.has(id)) id = nextId;
            const point = normalizedPoint(raw, id);
            if (point) { used.add(id); points.push(point); nextId = Math.max(nextId, id + 1); }
        });
        nextId = Math.max(nextId, Number(localStorage.getItem(ID_KEY)) || 1);
        const savedImage = localStorage.getItem(IMAGE_KEY);
        if (savedImage && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(savedImage)) picture = savedImage;
    } catch (_) {}
    renderPoints();
    updatePhoto();
    callAndroid('refresh');
});
