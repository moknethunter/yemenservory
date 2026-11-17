package com.example.yemensurveyor.gps
import android.content.Context
import android.location.GnssStatus
import android.location.LocationManager
import android.os.Build
class GnssSatelliteMonitor(context: Context) {
    private val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    var visible = 0; private set
    var used = 0; private set
    var avgCn0 = 0f; private set
    private val callback = object : GnssStatus.Callback() {
        override fun onSatelliteStatusChanged(status: GnssStatus) {
            var u = 0; var sum = 0f; var cnt = 0
            visible = status.satelliteCount
            for (i in 0 until status.satelliteCount) {
                if (status.usedInFix(i)) u++
                val cn0 = status.getCn0DbHz(i)
                if (cn0 > 0) { sum += cn0; cnt++ }
            }
            used = u; avgCn0 = if (cnt > 0) sum / cnt else 0f
        }
    }
    fun start() { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) manager.registerGnssStatusCallback(callback) }
    fun stop() { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) manager.unregisterGnssStatusCallback(callback) }
    val isFixReliable: Boolean get() = used >= 6 && avgCn0 >= 25f
}
