package com.example.yemensurveyor

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.print.PrintAttributes
import android.print.PrintManager
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.example.yemensurveyor.databinding.ActivityMainBinding
import com.example.yemensurveyor.survey.BluetoothRtk
import com.example.yemensurveyor.survey.Invitation
import com.example.yemensurveyor.survey.LocalAddress
import com.example.yemensurveyor.survey.Position
import com.example.yemensurveyor.survey.SurveyFix
import com.example.yemensurveyor.survey.SurveyGuest
import com.example.yemensurveyor.survey.SurveyHost
import com.example.yemensurveyor.survey.SurveyRole
import com.example.yemensurveyor.survey.localAddresses
import com.example.yemensurveyor.survey.toJson
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var location: LocationHelper
    private lateinit var receiver: BluetoothRtk
    private lateinit var activation: Activation
    private val handler = Handler(Looper.getMainLooper())
    private var foreground = false

    private var host: SurveyHost? = null
    private var guest: SurveyGuest? = null
    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
    private var hotspotGeneration = 0
    private var relayHotspot = false
    private var requestRelayHotspot = false
    private var hotspotSsid = ""
    private var hotspotPassword = ""
    private var networkMessage = ""
    private var bridgeMessage = ""
    private var addresses = emptyList<LocalAddress>()
    private var addressesAt = 0L
    private var incomingInvite = ""
    private var reference: Position? = null
    private var chooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingExport: ByteArray? = null
    private var printView: WebView? = null

    private val locationPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        resumeLocation()
        publish()
    }

    private val hotspotPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && activation.license() != null) {
            if (requestRelayHotspot) startRelayHotspot() else startFieldHost(true)
        }
        else {
            networkMessage = "اسمح بالأجهزة القريبة أو استخدم شبكة Wi-Fi قائمة"
            publish()
        }
    }

    private val bluetoothPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && activation.license() != null) listReceivers()
        else notifyUser("اسمح بالأجهزة القريبة لربط مستقبل RTK")
    }

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uri = result.data?.data?.takeIf { result.resultCode == RESULT_OK }
        chooserCallback?.onReceiveValue(uri?.let { arrayOf(it) })
        chooserCallback = null
    }

    private val saveDocument = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = pendingExport
        pendingExport = null
        val uri = result.data?.data ?: return@registerForActivityResult
        if (result.resultCode != RESULT_OK) return@registerForActivityResult
        if (data == null) {
            notifyUser("أعد تصدير الملف من التطبيق")
            return@registerForActivityResult
        }
        Thread {
            val success = runCatching { contentResolver.openOutputStream(uri)?.use { it.write(data) } != null }
                .getOrDefault(false)
            runOnUiThread { notifyUser(if (success) "تم حفظ الملف" else "تعذر حفظ الملف") }
        }.apply { isDaemon = true }.start()
    }

    private val update = object : Runnable {
        override fun run() {
            if (!foreground) return
            publish()
            handler.postDelayed(this, 700)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        }
        webView = binding.webView
        location = LocationHelper(this)
        receiver = BluetoothRtk(this)
        activation = Activation(this)
        readInvite(intent)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = true
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.toString() !in setOf(INDEX, "file:///android_asset/chat.html")
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?, callback: ValueCallback<Array<Uri>>?, params: FileChooserParams?
            ): Boolean {
                if (activation.license() == null) return false
                chooserCallback?.onReceiveValue(null)
                chooserCallback = callback
                return runCatching {
                    fileChooser.launch(params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    })
                    true
                }.getOrElse {
                    chooserCallback = null
                    false
                }
            }
        }
        webView.addJavascriptInterface(Bridge(), "Android")
        webView.loadUrl(INDEX)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        readInvite(intent)
        publish()
    }

    private fun readInvite(intent: Intent?) {
        val link = intent?.dataString ?: return
        if (Invitation.parse(link) != null) incomingInvite = link
    }

    private fun emit(function: String, value: Any) {
        val json = if (value is String) JSONObject.quote(value) else value.toString()
        webView.evaluateJavascript("if (window.$function) window.$function($json);", null)
    }

    private fun publish() {
        val license = activation.license()
        val now = SystemClock.elapsedRealtime()
        val state = JSONObject().put("activation", JSONObject()
            .put("configured", activation.configured).put("device", activation.device)
            .put("email", license?.email ?: "").put("plan", license?.plan ?: "")
            .put("expires", license?.expiresAt ?: 0).put("reason", activation.reason)
            .put("message", bridgeMessage).put("contact", activation.ownerEmail)
            .put("active", license != null))
        if (license == null) {
            if (host != null) stopFieldHost()
            if (guest != null) stopGuest()
            if (receiver.selected) receiver.disconnect()
            location.stop()
            emit("onSurveyState", state)
            return
        }
        if (host != null && (addresses.isEmpty() || now - addressesAt > 3_000)) {
            addresses = localAddresses()
            addressesAt = now
        }
        val fix = currentFix(now)
        guest?.reading = fix
        val field = host?.status(reference ?: fix?.position) ?: JSONObject()
        field.put("hosting", host != null).put("guest", guest != null)
            .put("addresses", JSONArray(addresses.map { JSONObject().put("ip", it.ip).put("adapter", it.adapter) }))
            .put("ssid", hotspotSsid).put("password", hotspotPassword)
            .put("role", guest?.assignedRole?.name ?: "").put("relayHotspot", relayHotspot && reservation != null)
            .put("networkMessage", networkMessage).put("guestMessage", guest?.status ?: "")
            .put("invite", incomingInvite).put("target", guest?.target?.toJson() ?: JSONObject.NULL)
        state.put("fix", fix?.toJson(now) ?: JSONObject.NULL).put("satellites", location.satelliteCount)
            .put("permission", has(Manifest.permission.ACCESS_FINE_LOCATION))
            .put("locationEnabled", location.locationEnabled).put("field", field)
            .put("rtk", JSONObject().put("status", receiver.status).put("selected", receiver.selected))
        emit("onSurveyState", state)
    }

    private fun currentFix(now: Long): SurveyFix? = if (receiver.selected) receiver.latest?.takeIf { it.isFresh(now) }
        else location.current(now)

    private fun has(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun resumeLocation() {
        if (foreground && activation.license() != null && has(Manifest.permission.ACCESS_FINE_LOCATION)) location.start()
    }

    @SuppressLint("MissingPermission")
    @Suppress("DEPRECATION")
    private fun startFieldHost(hotspot: Boolean) {
        if (Build.VERSION.SDK_INT >= 33 && hotspot && !has(Manifest.permission.NEARBY_WIFI_DEVICES)) {
            requestRelayHotspot = false
            hotspotPermission.launch(Manifest.permission.NEARBY_WIFI_DEVICES)
            return
        }
        if (hotspot && Build.VERSION.SDK_INT in 26..32 && !has(Manifest.permission.ACCESS_FINE_LOCATION)) {
            askLocation()
            networkMessage = "بعد منح صلاحية الموقع اضغط بدء نقطة الاتصال مجددًا"
            return
        }
        if (guest != null) {
            networkMessage = "أوقف مشاركة هاتفك قبل تشغيل محطة رئيسية"
            return
        }
        if (host != null) return
        host = runCatching { SurveyHost(assets.open("join.html").use { it.readBytes() }) }.getOrElse {
            networkMessage = "تعذر بدء خادم الجلسة"
            return
        }
        addressesAt = 0
        networkMessage = if (hotspot) "جاري إنشاء نقطة اتصال محلية…" else "اربط الأجهزة بنفس شبكة Wi-Fi ثم شارك رابط الجلسة"
        if (hotspot) openHotspot(false)
    }

    @SuppressLint("MissingPermission")
    private fun startRelayHotspot() {
        if (guest?.assignedRole != SurveyRole.REFERENCE) return
        if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.NEARBY_WIFI_DEVICES)) {
            requestRelayHotspot = true
            hotspotPermission.launch(Manifest.permission.NEARBY_WIFI_DEVICES)
            return
        }
        openHotspot(true)
    }

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    private fun openHotspot(relay: Boolean) {
        if (reservation != null) return
        if (Build.VERSION.SDK_INT < 26) {
            networkMessage = "شغّل نقطة اتصال الهاتف من إعدادات أندرويد أو اتصل بشبكة Wi-Fi قائمة"
            return
        }
        relayHotspot = relay
        val generation = ++hotspotGeneration
        runCatching {
            val wifi = applicationContext.getSystemService(WifiManager::class.java)
            wifi.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
                override fun onStarted(value: WifiManager.LocalOnlyHotspotReservation) {
                    if (generation != hotspotGeneration || (!relay && host == null) || (relay && guest == null)) {
                        value.close()
                        return
                    }
                    reservation = value
                    if (Build.VERSION.SDK_INT >= 30) {
                        val config = value.softApConfiguration
                        hotspotSsid = config.ssid.orEmpty()
                        hotspotPassword = config.passphrase.orEmpty()
                    } else {
                        val config = value.wifiConfiguration
                        hotspotSsid = config?.SSID.orEmpty()
                        hotspotPassword = config?.preSharedKey.orEmpty()
                    }
                    addressesAt = 0
                    networkMessage = if (relay) "اتصل من الجهاز المتحرك بشبكة المرجع عند الخروج من مدى المحطة"
                        else "اربط الهواتف بنقطة الاتصال ثم شارك الدعوة"
                    publish()
                }

                override fun onFailed(reason: Int) {
                    if (generation != hotspotGeneration) return
                    networkMessage = "تعذر فتح نقطة الاتصال. استخدم نقطة اتصال النظام أو شبكة Wi-Fi قائمة."
                    publish()
                }

                override fun onStopped() {
                    if (generation != hotspotGeneration) return
                    reservation = null
                    hotspotSsid = ""
                    hotspotPassword = ""
                    networkMessage = "أغلق النظام نقطة الاتصال. اربط الأجهزة بشبكة Wi-Fi واحدة."
                    publish()
                }
            }, handler)
        }.onFailure {
            networkMessage = "تعذر فتح نقطة الاتصال. افتحها من إعدادات النظام."
        }
    }

    private fun closeHotspot() {
        hotspotGeneration++
        reservation?.close()
        reservation = null
        hotspotSsid = ""
        hotspotPassword = ""
        relayHotspot = false
    }

    private fun stopFieldHost() {
        if (!relayHotspot) closeHotspot()
        host?.close()
        host = null
        addresses = emptyList()
        networkMessage = ""
        reference = null
    }

    private fun stopGuest() {
        if (relayHotspot) closeHotspot()
        guest?.close()
        guest = null
    }

    private fun askLocation() {
        locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    private fun listReceivers() {
        if (Build.VERSION.SDK_INT >= 31 && !has(Manifest.permission.BLUETOOTH_CONNECT)) {
            bluetoothPermission.launch(Manifest.permission.BLUETOOTH_CONNECT)
            return
        }
        val devices = runCatching { receiver.devices() }.getOrDefault(emptyList())
        emit("onReceivers", JSONArray(devices.map { (name, address) ->
            JSONObject().put("name", name).put("address", address)
        }))
    }

    private fun launchSafely(intent: Intent) {
        runCatching { startActivity(intent) }.onFailure { notifyUser("لا يوجد تطبيق مناسب لفتح هذا الخيار") }
    }

    private fun notifyUser(message: String) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    private fun coordinates(lat: String, lon: String): Position? = runCatching {
        Position(lat.trim().toDouble(), lon.trim().toDouble())
    }.getOrNull()

    private fun encodeFilename(value: String, extension: String): String =
        value.takeIf { it.matches(Regex("[A-Za-z0-9_-]{1,90}\\.$extension")) }
            ?: "survey_${System.currentTimeMillis()}.$extension"

    private inner class Bridge {
        private fun licensed(action: () -> Unit) = runOnUiThread {
            if (activation.license() != null) action()
            publish()
        }

        @JavascriptInterface fun refresh() = runOnUiThread { publish() }

        @JavascriptInterface fun activate(email: String, token: String) = runOnUiThread {
            bridgeMessage = activation.activate(email, token)
            resumeLocation()
            publish()
        }

        @JavascriptInterface fun requestActivation(email: String) = runOnUiThread {
            val address = activation.validEmail(email)
            if (address == null || !activation.configured) {
                bridgeMessage = if (address == null) "أدخل عنوان بريد إلكتروني صحيحًا" else activation.reason
                publish()
                return@runOnUiThread
            }
            val body = "البريد: $address\nرمز الجهاز: ${activation.device}\nأرغب في تفعيل أو تجديد مسّاح اليمن."
            val uri = Uri.parse("mailto:${activation.ownerEmail}?subject=" +
                Uri.encode("طلب تفعيل مسّاح اليمن") + "&body=" + Uri.encode(body))
            launchSafely(Intent(Intent.ACTION_SENDTO, uri))
        }

        @JavascriptInterface fun requestLocation() = licensed {
            if (has(Manifest.permission.ACCESS_FINE_LOCATION)) {
                if (!location.locationEnabled) launchSafely(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS))
                else resumeLocation()
            } else askLocation()
        }

        @JavascriptInterface fun startHost(hotspot: Boolean) = licensed { startFieldHost(hotspot) }
        @JavascriptInterface fun stopHost() = licensed { stopFieldHost() }

        @JavascriptInterface fun shareInvitation(ip: String) = licensed {
            val link = host?.invite(ip)
            if (link == null) {
                networkMessage = "اختر عنوانًا محليًا صالحًا في شبكة الجلسة"
            } else {
                val invite = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link)
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Survey invite", link))
                launchSafely(Intent.createChooser(invite, "مشاركة رابط جلسة المسح"))
            }
        }

        @JavascriptInterface fun join(link: String, name: String, lat: String, lon: String) = licensed {
            val invitation = Invitation.parse(link)
            val control = coordinates(lat, lon)
            when {
                host != null -> networkMessage = "أوقف المحطة الرئيسية قبل الانضمام كجهاز مشارك"
                invitation == null -> networkMessage = "تحقق من رابط الانضمام"
                (lat.isNotBlank() || lon.isNotBlank()) && control == null ->
                    networkMessage = "تحقق من إحداثيات النقطة المرجعية"
                !receiver.selected && !has(Manifest.permission.ACCESS_FINE_LOCATION) -> {
                    networkMessage = "اسمح بالموقع الدقيق، ثم اضغط مشاركة الموقع مجددًا"
                    askLocation()
                }
                else -> {
                    incomingInvite = ""
                    networkMessage = ""
                    stopGuest()
                    guest = SurveyGuest(applicationContext, invitation, name.take(40), control)
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        @JavascriptInterface fun assignRole(id: String, role: String) = licensed {
            val assigned = runCatching { host?.assign(id, SurveyRole.valueOf(role)) == true }.getOrDefault(false)
            networkMessage = if (assigned) "حُفظ دور الجهاز" else "اختر جهازًا متصلًا"
        }

        @JavascriptInterface fun openRelayHotspot() = licensed { startRelayHotspot() }
        @JavascriptInterface fun closeRelayHotspot() = licensed { if (relayHotspot) closeHotspot() }

        @JavascriptInterface fun leave() = licensed { stopGuest() }

        @JavascriptInterface fun setReference(lat: String, lon: String) = licensed {
            val position = coordinates(lat, lon)
            if (position == null && (lat.isNotBlank() || lon.isNotBlank())) {
                networkMessage = "أدخل خط العرض والطول بالدرجات العشرية"
            } else {
                reference = position
                networkMessage = if (position == null) "سيُستخدم موقع المحطة الحالي"
                    else "حُفظت إحداثيات المحطة المرجعية"
            }
        }

        @JavascriptInterface fun captureLocal(strict: Boolean) = licensed {
            val now = SystemClock.elapsedRealtime()
            val fix = currentFix(now)
            if (fix?.canCapture(now, strict) != true) {
                emit("onCaptureMessage", if (strict) "انتظر تثبيت RTK وقراءات أفقية مستقرة ≤ ٥ سم"
                    else "ثبّت الجهاز وانتظر قراءة حديثة ومستقرة")
            } else {
                emit("onLocalCapture", fix.toJson(now).put("strict", strict))
            }
        }

        @JavascriptInterface fun captureRover(id: String, strict: Boolean) = licensed {
            val message = host?.capture(id, reference, currentFix(SystemClock.elapsedRealtime()), strict)
                ?: "ابدأ جلسة جماعية أولًا"
            emit("onCaptureMessage", message)
        }

        @JavascriptInterface fun acknowledge(id: String) = licensed { host?.acknowledge(id) }
        @JavascriptInterface fun cancelCapture() = licensed { host?.cancelCapture() }

        @JavascriptInterface fun stakeout(id: String, lat: String, lon: String) = licensed {
            val point = coordinates(lat, lon)
            val clear = lat.isBlank() && lon.isBlank()
            val sent = (clear || point != null) && host?.setStakeout(id, point) == true
            emit("onStakeoutMessage", if (sent && clear) "أُلغي توجيه الهاتف المتحرك"
                else if (sent) "أُرسلت نقطة الإسقاط إلى الهاتف المتحرك" else "اختر هاتفًا متحركًا متصلًا")
        }

        @JavascriptInterface fun receivers() = licensed { listReceivers() }
        @JavascriptInterface fun connectReceiver(address: String) = licensed {
            if (Build.VERSION.SDK_INT >= 31 && !has(Manifest.permission.BLUETOOTH_CONNECT)) listReceivers()
            else runCatching { receiver.connect(address) }.onFailure { notifyUser("تحقق من تشغيل Bluetooth والاقتران") }
        }
        @JavascriptInterface fun disconnectReceiver() = licensed { receiver.disconnect() }
        @JavascriptInterface fun bluetoothSettings() = licensed { launchSafely(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) }

        @JavascriptInterface fun saveFile(contents: String, name: String, format: String) = licensed {
            if (pendingExport != null) return@licensed
            val mime = when (format) {
                "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                "csv" -> "text/csv"
                "dxf" -> "application/dxf"
                "kml" -> "application/vnd.google-earth.kml+xml"
                else -> return@licensed
            }
            val data = runCatching {
                require(contents.length <= 12_000_000)
                if (format == "xlsx") Base64.decode(contents, Base64.DEFAULT) else contents.toByteArray()
            }.getOrNull()
            if (data == null) {
                notifyUser("تعذر تجهيز الملف")
                return@licensed
            }
            pendingExport = data
            runCatching {
                saveDocument.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    type = mime
                    addCategory(Intent.CATEGORY_OPENABLE)
                    putExtra(Intent.EXTRA_TITLE, encodeFilename(name, format))
                })
            }.onFailure {
                pendingExport = null
                notifyUser("تعذر فتح مدير الملفات")
            }
        }

        @JavascriptInterface fun shareCSV(text: String, name: String) = licensed {
            cachedExport(text, name, "csv", "text/csv", false)
        }

        @JavascriptInterface fun openEarth(text: String, name: String) = licensed {
            cachedExport(text, name, "kml", "application/vnd.google-earth.kml+xml", true)
        }

        @JavascriptInterface fun openMap(lat: String, lon: String) = licensed {
            coordinates(lat, lon)?.let { point ->
                val url = Uri.parse("https://www.google.com/maps/search/").buildUpon()
                    .appendQueryParameter("api", "1").appendQueryParameter("query", "${point.lat},${point.lon}").build()
                launchSafely(Intent(Intent.ACTION_VIEW, url))
            }
        }

        @JavascriptInterface fun printReport(html: String, landscape: Boolean) = licensed {
            if (html.length > 5_000_000) return@licensed
            printView?.destroy()
            val document = WebView(this@MainActivity)
            printView = document
            document.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String?) {
                    val media = PrintAttributes.MediaSize.ISO_A4
                    runCatching {
                        getSystemService(PrintManager::class.java).print(
                            "تقرير مسّاح اليمن", view.createPrintDocumentAdapter("تقرير مسّاح اليمن"),
                            PrintAttributes.Builder().setMediaSize(if (landscape) media.asLandscape() else media.asPortrait())
                                .setMinMargins(PrintAttributes.Margins.NO_MARGINS).build()
                        )
                    }.onFailure { notifyUser("تعذر فتح شاشة الطباعة") }
                }
            }
            document.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
        }
    }

    private fun cachedExport(text: String, name: String, extension: String, mime: String, view: Boolean) {
        if (text.length > 12_000_000) return
        runCatching {
            val dir = File(cacheDir, "exports").apply { mkdirs() }
            val file = File(dir, encodeFilename(name, extension)).apply { writeText(text) }
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            val share = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (!view) launchSafely(Intent.createChooser(share, "مشاركة نقاط المسح"))
            else runCatching {
                startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            }.onFailure { launchSafely(Intent.createChooser(share, "فتح أو مشاركة ملف KML")) }
        }.onFailure { notifyUser("تعذر تجهيز الملف") }
    }

    override fun onStart() {
        super.onStart()
        foreground = true
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        resumeLocation()
        guest?.resume()
        handler.post(update)
    }

    override fun onStop() {
        foreground = false
        handler.removeCallbacks(update)
        location.stop()
        guest?.pause()
        super.onStop()
    }

    override fun onDestroy() {
        stopGuest()
        stopFieldHost()
        receiver.disconnect()
        chooserCallback?.onReceiveValue(null)
        printView?.destroy()
        webView.destroy()
        super.onDestroy()
    }

    private companion object {
        const val INDEX = "file:///android_asset/index.html"
    }
}
