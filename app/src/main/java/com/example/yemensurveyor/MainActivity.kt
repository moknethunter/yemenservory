package com.example.yemensurveyor

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.example.yemensurveyor.databinding.ActivityMainBinding
import java.io.File
import java.io.FileOutputStream

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var locationHelper: LocationHelper
    private lateinit var webView: WebView

    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCsvContent: String? = null

    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val fineGranted = permissions[Manifest.permission.ACCESS_FINE_LOCATION] == true
        if (!fineGranted) {
            Toast.makeText(this, "نحتاج صلاحية الموقع لعمل التطبيق", Toast.LENGTH_LONG).show()
        }
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            val data = result.data
            val uris = when {
                data?.clipData != null -> {
                    val count = data.clipData!!.itemCount
                    Array(count) { i -> data.clipData!!.getItemAt(i).uri }
                }
                data?.data != null -> arrayOf(data.data!!)
                else -> null
            }
            fileChooserCallback?.onReceiveValue(uris)
        } else {
            fileChooserCallback?.onReceiveValue(null)
        }
        fileChooserCallback = null
    }

    private val createDocumentLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            result.data?.data?.let { uri ->
                try {
                    contentResolver.openOutputStream(uri)?.use { os ->
                        os.write(pendingCsvContent?.toByteArray(Charsets.UTF_8) ?: ByteArray(0))
                    }
                    Toast.makeText(this, "✅ تم حفظ الملف بنجاح", Toast.LENGTH_LONG).show()
                } catch (e: Exception) {
                    Toast.makeText(this, "❌ خطأ في الحفظ: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
        pendingCsvContent = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        webView = binding.webView
        locationHelper = LocationHelper(this)

        requestLocationPermissions()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            setGeolocationEnabled(true)
        }
        webView.webViewClient = WebViewClient()

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                val intent = fileChooserParams?.createIntent()
                    ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                return try {
                    fileChooserLauncher.launch(intent)
                    true
                } catch (e: Exception) {
                    fileChooserCallback = null
                    false
                }
            }
        }

        webView.addJavascriptInterface(object {

            @JavascriptInterface
            fun startHighAccuracyTracking() {
                runOnUiThread {
                    if (hasLocationPermission()) {
                        locationHelper.startHighAccuracyTracking { lat, lon, alt, acc ->
                            webView.evaluateJavascript(
                                "javascript:onLocationUpdate($lat, $lon, $alt, $acc);", null
                            )
                        }
                    }
                }
            }

            @JavascriptInterface
            fun stopTracking() {
                locationHelper.stopTracking()
            }

            @JavascriptInterface
            fun saveCSVWithDialog(csvContent: String, suggestedName: String) {
                pendingCsvContent = csvContent
                runOnUiThread {
                    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "text/csv"
                        putExtra(Intent.EXTRA_TITLE, suggestedName)
                    }
                    try {
                        createDocumentLauncher.launch(intent)
                    } catch (e: Exception) {
                        Toast.makeText(
                            this@MainActivity, "❌ لا يمكن فتح مدير الملفات: ${e.message}",
                            Toast.LENGTH_LONG
                        ).show()
                        pendingCsvContent = null
                    }
                }
            }

            @JavascriptInterface
            fun quickSaveCSV(csvContent: String, fileName: String) {
                try {
                    val dir = File(
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                        ""
                    )
                    if (!dir.exists()) dir.mkdirs()
                    val file = File(dir, fileName)
                    FileOutputStream(file).use { it.write(csvContent.toByteArray(Charsets.UTF_8)) }
                    runOnUiThread {
                        Toast.makeText(
                            this@MainActivity, "✅ تم الحفظ: ${file.absolutePath}",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        Toast.makeText(
                            this@MainActivity, "❌ خطأ: ${e.message}", Toast.LENGTH_LONG
                        ).show()
                    }
                }
            }

            @JavascriptInterface
            fun exportKMLAndOpen(kmlContent: String, fileName: String) {
                try {
                    val dir = File(cacheDir, "exports").apply { mkdirs() }
                    val file = File(dir, fileName)
                    file.writeText(kmlContent, Charsets.UTF_8)

                    val uri = FileProvider.getUriForFile(
                        this@MainActivity,
                        "${packageName}.fileprovider",
                        file
                    )

                    val intent = Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, "application/vnd.google-earth.kml+xml")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }

                    runOnUiThread {
                        try {
                            startActivity(intent)
                        } catch (e: Exception) {
                            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                                type = "application/vnd.google-earth.kml+xml"
                                putExtra(Intent.EXTRA_STREAM, uri)
                                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            }
                            startActivity(
                                Intent.createChooser(shareIntent, "فتح KML بواسطة:")
                            )
                        }
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        Toast.makeText(
                            this@MainActivity, "❌ خطأ في KML: ${e.message}",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
            }

            @JavascriptInterface
            fun shareCSV(csvContent: String, fileName: String) {
                try {
                    val dir = File(cacheDir, "exports").apply { mkdirs() }
                    val file = File(dir, fileName)
                    file.writeText(csvContent, Charsets.UTF_8)
                    val uri = FileProvider.getUriForFile(
                        this@MainActivity, "${packageName}.fileprovider", file
                    )
                    val intent = Intent(Intent.ACTION_SEND).apply {
                        type = "text/csv"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        putExtra(Intent.EXTRA_SUBJECT, "نقاط المسح - مسّاح اليمن")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    runOnUiThread {
                        startActivity(Intent.createChooser(intent, "مشاركة:"))
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        Toast.makeText(
                            this@MainActivity, "❌ خطأ: ${e.message}", Toast.LENGTH_LONG
                        ).show()
                    }
                }
            }

            /**
             * طباعة HTML وحفظه كملف PDF عبر نافذة الطباعة الرسمية في أندرويد.
             */
            @JavascriptInterface
            fun printHTML(htmlContent: String, jobName: String) {
                runOnUiThread {
                    try {
                        val printWebView = WebView(this@MainActivity)
                        printWebView.settings.javaScriptEnabled = false
                        printWebView.webViewClient = object : WebViewClient() {
                            override fun onPageFinished(view: WebView?, url: String?) {
                                try {
                                    val printManager = getSystemService(Context.PRINT_SERVICE) as PrintManager
                                    val printAdapter = view?.createPrintDocumentAdapter(jobName)
                                    if (printAdapter != null) {
                                        val attrs = PrintAttributes.Builder()
                                            .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                            .setResolution(PrintAttributes.Resolution("pdf", "pdf", 600, 600))
                                            .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                                            .build()
                                        printManager.print(jobName, printAdapter, attrs)
                                    } else {
                                        Toast.makeText(
                                            this@MainActivity,
                                            "❌ فشل إنشاء محول الطباعة",
                                            Toast.LENGTH_LONG
                                        ).show()
                                    }
                                } catch (e: Exception) {
                                    Toast.makeText(
                                        this@MainActivity,
                                        "❌ خطأ في الطباعة: ${e.message}",
                                        Toast.LENGTH_LONG
                                    ).show()
                                }
                            }
                        }
                        printWebView.loadDataWithBaseURL(
                            null, htmlContent, "text/HTML", "UTF-8", null
                        )
                    } catch (e: Exception) {
                        Toast.makeText(
                            this@MainActivity,
                            "❌ خطأ: ${e.message}",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
            }

        }, "Android")

        webView.loadUrl("file:///android_asset/index.html")
    }

    private fun hasLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            this, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun requestLocationPermissions() {
        locationPermissionLauncher.launch(
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            )
        )
    }

    override fun onDestroy() {
        locationHelper.stopTracking()
        super.onDestroy()
    }
}
