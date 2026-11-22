package com.example.yemensurveyor.survey

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.util.Base64
import org.json.JSONObject
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class LocalAddress(val ip: String, val adapter: String)

fun localAddresses(): List<LocalAddress> = runCatching {
    NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }
        .flatMap { adapter ->
            adapter.inetAddresses.toList().filterIsInstance<Inet4Address>()
                .mapNotNull { it.hostAddress }
                .filter(::isPrivateIp).map { LocalAddress(it, adapter.name) }
        }.distinctBy { it.ip }.sortedByDescending {
            it.adapter.startsWith("ap") || it.adapter.startsWith("swlan") || it.adapter.startsWith("softap")
        }
}.getOrDefault(emptyList())

internal fun isPrivateIp(ip: String): Boolean {
    val parts = ip.split('.').map { it.toIntOrNull() ?: return false }
    if (parts.size != 4 || parts.any { it !in 0..255 } || parts.joinToString(".") != ip) return false
    return parts[0] == 10 || (parts[0] == 172 && parts[1] in 16..31) ||
        (parts[0] == 192 && parts[1] == 168) || (parts[0] == 169 && parts[1] == 254)
}

class Invitation private constructor(val ip: String, val port: Int, val key: ByteArray) {
    private val keyText: String get() = encode(key)
    fun webLink(): String = "http://$ip:$port/join#$keyText"

    companion object {
        fun create(ip: String, port: Int, key: ByteArray): Invitation? =
            if (port in 1024..65535 && isPrivateIp(ip) && key.size == 32) Invitation(ip, port, key) else null

        fun parse(text: String): Invitation? {
            if (text.length !in 35..300) return null
            return runCatching {
                val uri = Uri.parse(text.trim())
                val rawKey = if (uri.scheme == "http" && uri.path == "/join") uri.fragment
                    else if (uri.scheme == "yemensurveyor" && uri.host == "join") uri.getQueryParameter("key")
                    else return null
                val ip = if (uri.scheme == "http") uri.host else uri.getQueryParameter("ip")
                val port = if (uri.scheme == "http") uri.port else uri.getQueryParameter("port")?.toIntOrNull()
                create(ip ?: return null, port ?: return null, decode(rawKey ?: return null))
            }.getOrNull()
        }
    }
}

private const val BASE64_FLAGS = Base64.NO_PADDING or Base64.NO_WRAP or Base64.URL_SAFE
private fun encode(value: ByteArray): String = Base64.encodeToString(value, BASE64_FLAGS)
private fun decode(value: String): ByteArray = Base64.decode(value, BASE64_FLAGS)

/** The invitation's 256-bit key authenticates and encrypts local messages. */
internal class SessionCipher(key: ByteArray) {
    private val secret = SecretKeySpec(key, "AES")

    fun encrypt(json: JSONObject, context: String): String {
        val nonce = ByteArray(12).also(RANDOM::nextBytes)
        return encode(nonce + cipher(Cipher.ENCRYPT_MODE, nonce, context).doFinal(json.toString().toByteArray()))
    }

    fun decrypt(text: String, context: String): JSONObject {
        val data = decode(text)
        require(data.size > 28)
        val nonce = data.copyOfRange(0, 12)
        val bytes = cipher(Cipher.DECRYPT_MODE, nonce, context).doFinal(data, 12, data.size - 12)
        return JSONObject(bytes.toString(Charsets.UTF_8))
    }

    private fun cipher(mode: Int, nonce: ByteArray, context: String): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, secret, GCMParameterSpec(128, nonce))
            updateAAD("yemen-survey/1/$context".toByteArray())
        }

    companion object {
        private val RANDOM = SecureRandom()
        fun key(): ByteArray = ByteArray(32).also(RANDOM::nextBytes)
    }
}

fun Position.toJson(): JSONObject = JSONObject().put("lat", lat).put("lon", lon)
fun JSONObject.position(): Position = Position(getDouble("lat"), getDouble("lon"))
fun JSONObject.numberOrNull(name: String): Double? = optDouble(name).takeIf(Double::isFinite)

fun SurveyFix.toJson(now: Long): JSONObject = position.toJson()
    .put("alt", altitude ?: JSONObject.NULL)
    .put("datum", datum?.name ?: JSONObject.NULL)
    .put("acc", accuracy ?: JSONObject.NULL)
    .put("source", source.name)
    .put("age", now - sampledAt)
    .put("satellites", satellites)
    .put("stable", stable)
    .put("correctionAge", correctionAge ?: JSONObject.NULL)
    .put("horizontal95", horizontal95 ?: JSONObject.NULL)

internal fun JSONObject.fix(now: Long): SurveyFix? = runCatching {
    val age = getLong("age").also { require(it in 0..FIX_LIFETIME_MS) }
    val source = FixSource.valueOf(getString("source"))
    SurveyFix(
        position(), numberOrNull("alt"), optString("datum").let { datum ->
            HeightDatum.entries.firstOrNull { it.name == datum }
        }, numberOrNull("acc")?.takeIf { it > 0 }, source, now - age,
        optInt("satellites").coerceIn(0, 99), optBoolean("stable"),
        numberOrNull("correctionAge"), numberOrNull("horizontal95")
    )
}.getOrNull()

internal const val MAX_MESSAGE_BYTES = 12_288

internal fun exchange(
    context: Context, invitation: Invitation, data: JSONObject, ip: String = invitation.ip,
    port: Int = invitation.port
): JSONObject {
    val request = UUID.randomUUID().toString()
    data.put("request", request)
    val cipher = SessionCipher(invitation.key)
    val response = forward(context, ip, port, cipher.encrypt(data, "request"))
    return cipher.decrypt(response, "response/$request")
}

internal fun forward(context: Context, ip: String, port: Int, encrypted: String): String {
    require(isPrivateIp(ip) && port in 1024..65535)
    val address = InetAddress.getByName(ip)
    val network = context.getSystemService(ConnectivityManager::class.java).let { manager ->
        @Suppress("DEPRECATION")
        manager.allNetworks.firstOrNull {
            manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true &&
                manager.getLinkProperties(it)?.routes?.any { route ->
                    route.destination.prefixLength > 0 && route.matches(address)
                } == true
        }
    }
    val socket = network?.socketFactory?.createSocket() ?: Socket()
    return socket.use {
        val message = encrypted.toByteArray(Charsets.US_ASCII)
        it.soTimeout = 2_500
        it.connect(InetSocketAddress(address, port), 950)
        val output = it.getOutputStream().buffered()
        output.write(("POST /exchange HTTP/1.1\r\nHost: $ip:$port\r\n" +
            "Content-Length: ${message.size}\r\nConnection: close\r\n\r\n").toByteArray())
        output.write(message)
        output.flush()
        val input = it.getInputStream().buffered()
        require(input.httpLine() == "HTTP/1.1 200 OK")
        input.readMessage(input.headers())
    }
}

internal fun java.io.InputStream.httpLine(): String {
    val line = StringBuilder()
    while (line.length < 2048) {
        val byte = read()
        require(byte >= 0)
        if (byte == 10) return line.toString().trimEnd('\r')
        line.append(byte.toChar())
    }
    throw IllegalArgumentException("HTTP line too long")
}

internal fun java.io.InputStream.headers(): Int {
    var length: Int? = null
    repeat(24) {
        val line = httpLine()
        if (line.isEmpty()) return length ?: 0
        if (line.substringBefore(':').equals("content-length", ignoreCase = true)) {
            require(length == null)
            length = line.substringAfter(':').trim().toInt()
            require(length in 0..MAX_MESSAGE_BYTES)
        }
    }
    throw IllegalArgumentException("Too many headers")
}

internal fun java.io.InputStream.readMessage(length: Int): String {
    require(length in 1..MAX_MESSAGE_BYTES)
    val bytes = ByteArray(length)
    var offset = 0
    while (offset < bytes.size) {
        val count = read(bytes, offset, bytes.size - offset)
        require(count > 0)
        offset += count
    }
    return bytes.toString(Charsets.US_ASCII)
}
