package com.example.yemensurveyor

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Looper
import android.os.SystemClock
import com.example.yemensurveyor.gps.GnssSatelliteMonitor
import com.example.yemensurveyor.survey.FixSource
import com.example.yemensurveyor.survey.HeightDatum
import com.example.yemensurveyor.survey.Position
import com.example.yemensurveyor.survey.SurveyFix
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlin.math.abs
import kotlin.math.sqrt

class LocationHelper(private val context: Context) : SensorEventListener {
    private val locationManager = context.getSystemService(LocationManager::class.java)
    private val sensorManager = context.getSystemService(SensorManager::class.java)
    private val fused by lazy { LocationServices.getFusedLocationProviderClient(context) }
    private val satellites = GnssSatelliteMonitor(context)
    private val recent = ArrayDeque<SurveyFix>()
    private var fusedCallback: LocationCallback? = null
    private var active = false
    private var latest: SurveyFix? = null
    private var lastMotionAt = -4_000L
    private var platformListener: LocationListener? = null

    val satelliteCount: Int get() = satellites.used
    val locationEnabled: Boolean get() = runCatching {
        locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
            locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }.getOrDefault(false)

    @SuppressLint("MissingPermission")
    fun start() {
        if (active) return
        active = true
        runCatching { satellites.start() }
        val movementSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
            ?: sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        movementSensor?.let { sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_UI) }
        sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_UI)
        }

        if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) != ConnectionResult.SUCCESS) {
            startPlatform()
            return
        }

        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1_000L)
            .setMinUpdateIntervalMillis(650L)
            .setMaxUpdateAgeMillis(0)
            .build()
        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                if (fusedCallback === this) result.locations.forEach { receive(it, FixSource.FUSED) }
            }
        }
        fusedCallback = callback
        try {
            fused.requestLocationUpdates(request, callback, Looper.getMainLooper()).addOnFailureListener {
                if (fusedCallback === callback) startPlatform()
            }
        } catch (_: SecurityException) {
            startPlatform()
        }
    }

    @SuppressLint("MissingPermission")
    private fun startPlatform() {
        if (!active || platformListener != null) return
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                if (platformListener !== this) return
                val source = if (location.provider == LocationManager.GPS_PROVIDER) FixSource.GNSS else FixSource.NETWORK
                if (source == FixSource.NETWORK && latest?.let {
                        it.source == FixSource.GNSS && it.isFresh(SystemClock.elapsedRealtime())
                    } == true) return
                receive(location, source)
            }

            @Deprecated("Legacy callback")
            override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) = Unit
            override fun onProviderEnabled(provider: String) = Unit
            override fun onProviderDisabled(provider: String) = Unit
        }
        platformListener = listener
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            runCatching { locationManager.requestLocationUpdates(provider, 1_000L, 0f, listener, Looper.getMainLooper()) }
        }
    }

    @Suppress("DEPRECATION")
    private fun receive(location: Location, source: FixSource) {
        val simulated = if (Build.VERSION.SDK_INT >= 31) location.isMock else location.isFromMockProvider
        if (!active || simulated || !location.hasAccuracy() ||
            !location.accuracy.isFinite() || location.accuracy <= 0f) return
        val now = SystemClock.elapsedRealtime()
        val sampleTime = location.elapsedRealtimeNanos / 1_000_000
        if (now - sampleTime !in 0..5_000 || sampleTime <= (latest?.sampledAt ?: -1)) return
        val position = runCatching { Position(location.latitude, location.longitude) }.getOrNull() ?: return
        val altitude = location.altitude.takeIf { location.hasAltitude() && it.isFinite() }
        val uncertainty = location.accuracy.toDouble()
        val fix = SurveyFix(position, altitude, altitude?.let { HeightDatum.ELLIPSOID }, uncertainty,
            source, sampleTime, satelliteCount)
        if (now - lastMotionAt < 1_800 || recent.any {
                it.source != source || sampleTime - it.sampledAt > 6_000 ||
                    it.position.distanceTo(position) > uncertainty.coerceIn(1.5, 4.0)
            }) recent.clear()
        if (recent.size >= 4) recent.removeFirst()
        recent.addLast(fix)
        latest = fix.copy(stable = recent.size >= 3 && sampleTime - recent.first().sampledAt >= 1_600)
    }

    fun current(now: Long = SystemClock.elapsedRealtime()): SurveyFix? = latest?.takeIf { it.isFresh(now) }
        ?.let { it.copy(stable = it.stable && now - lastMotionAt >= 1_800) }

    fun stop() {
        active = false
        fusedCallback?.let { fused.removeLocationUpdates(it) }
        fusedCallback = null
        platformListener?.let { locationManager.removeUpdates(it) }
        platformListener = null
        satellites.stop()
        sensorManager.unregisterListener(this)
        recent.clear()
        latest = null
    }

    override fun onSensorChanged(event: SensorEvent) {
        val magnitude = sqrt(event.values.take(3).sumOf { (it * it).toDouble() })
        val moving = when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> abs(magnitude - SensorManager.GRAVITY_EARTH) > 0.8
            Sensor.TYPE_LINEAR_ACCELERATION -> magnitude > 0.45
            Sensor.TYPE_GYROSCOPE -> magnitude > 0.18
            else -> false
        }
        if (moving) {
            lastMotionAt = SystemClock.elapsedRealtime()
            recent.clear()
            latest = latest?.copy(stable = false)
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
