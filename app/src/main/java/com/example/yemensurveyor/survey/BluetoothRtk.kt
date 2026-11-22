package com.example.yemensurveyor.survey

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.io.InputStream
import java.util.UUID

/** Secure Classic Bluetooth SPP connection to a receiver already paired in Android. */
class BluetoothRtk(context: Context) {
    private val manager = context.getSystemService(BluetoothManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private var job: Connection? = null
    var latest: SurveyFix? = null
        private set
    var status: String = ""
        private set
    var selected: Boolean = false
        private set

    @SuppressLint("MissingPermission")
    fun devices(): List<Pair<String, String>> = manager?.adapter?.bondedDevices.orEmpty()
        .map { (it.name ?: it.address) to it.address }.sortedBy { it.first }

    @SuppressLint("MissingPermission")
    fun connect(address: String) {
        disconnect()
        val device = manager?.adapter?.bondedDevices?.firstOrNull { it.address == address }
            ?: return
        selected = true
        status = "جاري الاتصال بالمستقبل…"
        val connection = Connection()
        job = connection
        Thread({
            try {
                val socket = device.createRfcommSocketToServiceRecord(SPP)
                connection.socket = socket
                socket.use {
                    socket.connect()
                    publish(connection) { status = "متصل · في انتظار NMEA GGA وGST" }
                    val parser = NmeaRtk()
                    socket.inputStream.buffered().use { input ->
                        while (!connection.closed) {
                            val line = nextSentence(input) ?: break
                            val result = parser.accept(line, SystemClock.elapsedRealtime())
                            if (result != null || parser.lostFix) publish(connection) {
                                latest = result
                                status = if (result == null) "يبحث المستقبل عن إشارة"
                                    else "متصل · يستقبل NMEA"
                            }
                        }
                    }
                    publish(connection) { resetWithMessage("انقطع اتصال مستقبل RTK") }
                }
            } catch (_: Exception) {
                publish(connection) { resetWithMessage("تعذر الاتصال بمستقبل RTK عبر Bluetooth SPP") }
            }
        }, "survey-rtk").apply { isDaemon = true }.start()
    }

    private fun publish(connection: Connection, update: () -> Unit) {
        handler.post { if (job === connection) update() }
    }

    private fun resetWithMessage(message: String) {
        latest = null
        job = null
        status = message
    }

    fun disconnect() {
        job?.close()
        job = null
        latest = null
        selected = false
        status = ""
    }

    private fun nextSentence(input: InputStream): String? {
        val sentence = StringBuilder(160)
        while (true) {
            val value = input.read()
            when {
                value == -1 -> return null
                value == 10 -> return sentence.toString().trimEnd('\r')
                sentence.length < 240 -> sentence.append(value.toChar())
            }
        }
    }

    private class Connection {
        @Volatile var closed = false
            private set
        @Volatile private var activeSocket: BluetoothSocket? = null
        var socket: BluetoothSocket?
            get() = activeSocket
            @Synchronized set(value) {
                if (closed) runCatching { value?.close() } else activeSocket = value
            }

        @Synchronized
        fun close() {
            closed = true
            runCatching { activeSocket?.close() }
            activeSocket = null
        }
    }

    private companion object {
        val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805f9b34fb")
    }
}
