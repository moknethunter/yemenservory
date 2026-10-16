package com.example.yemensurveyor

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.example.yemensurveyor.databinding.ActivityMainBinding
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var locationHelper: LocationHelper
    private lateinit var webView: WebView

    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val fineGranted = permissions[Manifest.permission.ACCESS_FINE_LOCATION] == true
        if (fineGranted) {
            Toast.makeText(this, "تم منح صلاحية الموقع", Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(this, "نحتاج صلاحية الموقع لعمل التطبيق", Toast.LENGTH_LONG).show()
        }
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

        webView.addJavascriptInterface(object {
            @JavascriptInterface
            fun startHighAccuracyTracking() {
                runOnUiThread {
                    if (hasLocationPermission()) {
                        locationHelper.startHighAccuracyTracking { lat, lon, alt, acc ->
                            webView.evaluateJavascript(
                                "javascript:onLocationUpdate($lat, $lon, $alt, $acc);",
                                null
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
            fun getLastKnownLocation(): String {
                val loc = locationHelper.getLastKnownLocation()
                return if (loc != null) {
                    "{\"lat\":${loc.latitude},\"lon\":${loc.longitude},\"alt\":${loc.altitude},\"acc\":${loc.accuracy}}"
                } else {
                    "{}"
                }
            }

            @JavascriptInterface
            fun exportCSV(csvContent: String, fileName: String) {
                try {
                    val dir = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        File(getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS), "")
                    } else {
                        File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "")
                    }
                    if (!dir.exists()) dir.mkdirs()
                    val file = File(dir, fileName)
                    file.writeText(csvContent)
                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "تم الحفظ في: ${file.absolutePath}", Toast.LENGTH_LONG).show()
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "خطأ في الحفظ: ${e.message}", Toast.LENGTH_LONG).show()
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
