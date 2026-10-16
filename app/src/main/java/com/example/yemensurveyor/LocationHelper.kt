package com.example.yemensurveyor

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.os.Looper
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

class LocationHelper(private val context: Context) {

    private val fusedLocationClient: FusedLocationProviderClient =
        LocationServices.getFusedLocationProviderClient(context)

    private var locationCallback: LocationCallback? = null

    private val locationRequest = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000L)
        .setMinUpdateIntervalMillis(500L)
        .setMaxUpdateDelayMillis(1000L)
        .setWaitForAccurateLocation(true)
        .build()

    @SuppressLint("MissingPermission")
    fun startHighAccuracyTracking(onLocation: (Double, Double, Double, Float) -> Unit) {
        stopTracking()

        locationCallback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.lastLocation?.let { loc ->
                    onLocation(loc.latitude, loc.longitude, loc.altitude, loc.accuracy)
                }
            }
        }

        try {
            fusedLocationClient.requestLocationUpdates(
                locationRequest,
                locationCallback!!,
                Looper.getMainLooper()
            )
        } catch (e: SecurityException) {
            e.printStackTrace()
        }
    }

    fun stopTracking() {
        locationCallback?.let {
            fusedLocationClient.removeLocationUpdates(it)
            locationCallback = null
        }
    }

    @SuppressLint("MissingPermission")
    fun getLastKnownLocation(): Location? {
        return try {
            fusedLocationClient.lastLocation.result
        } catch (e: Exception) {
            null
        }
    }
}
